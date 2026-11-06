import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContentStrict } from "../../storage/local-store.js";
import { readProductionDocOrEmpty, writeProductionDoc } from "../../storage/production-store.js";
import { factPath } from "../production/chat-approval/files.js";
import { loadProfile, updateProfile } from "../profile/creator-profile.js";
import { mutatePlan } from "../theme/plan.js";
import { evaluateSource } from "./eligibility.js";
import { dispatchFixture, receipts, ZH } from "./testkit.js";

let fixture: Awaited<ReturnType<typeof dispatchFixture>>;
beforeEach(async () => { fixture = await dispatchFixture(); });
afterEach(async () => { await fixture.env.cleanup(); });
const evaluate = (options = {}) => evaluateSource(fixture.source.id, fixture.env.dir, options);

describe("中文排期后的派生资格", () => {
  it("3/4 不满足，4/4 当前真实排期才生成两条派生意图", async () => {
    await receipts(fixture.env, fixture.source, ZH.slice(0, 3));
    expect(await evaluate()).toMatchObject({ ok: false, code: "zh_publish_incomplete" });
    await receipts(fixture.env, fixture.source);
    const result = await evaluate();
    expect(result).toMatchObject({ ok: true, value: { requiredZhPlatforms: [...ZH].sort(), sourceCutHash: expect.stringMatching(/^sha256:/), intents: [
      { kind: "wechat_article", targetPlatforms: ["wechat_mp"] }, { kind: "en_edition", targetPlatforms: ["youtube", "x"] },
    ] } });
    if (result.ok) expect(result.value.receiptRefs).toHaveLength(4);
  });

  it("只有已认可的模型 claim，没有实际平台回执时仍不满足", async () => {
    await receipts(fixture.env, fixture.source, ZH, { plan: false });
    expect(await evaluate()).toMatchObject({ ok: false, code: "publish_receipt_missing" });
  });

  it("原始计划不能替代本轮 canonical 槽，也不能覆盖本轮纠正", async () => {
    await receipts(fixture.env, fixture.source);
    const doc = await readProductionDocOrEmpty(fixture.source.id, fixture.env.dir);
    doc.decisions.push({ id: "correction", type: "publish_correction", round: doc.round, source: "founder", target_id: `slot:${doc.round}:douyin`, at: new Date(Date.now() + 1000).toISOString() });
    await writeProductionDoc(fixture.source.id, fixture.env.dir, doc, doc.revision);
    expect(await evaluate()).toMatchObject({ ok: false, code: "zh_publish_incomplete" });
    const next = await readProductionDocOrEmpty(fixture.source.id, fixture.env.dir);
    next.round++;
    await writeProductionDoc(fixture.source.id, fixture.env.dir, next, next.revision);
    expect(await evaluate()).toMatchObject({ ok: false, code: "zh_publish_incomplete" });
  });

  it.each(["reviewing", "rejected"] as const)("%s 不是已完成排期", async (state) => {
    await receipts(fixture.env, fixture.source, ZH, { state });
    expect(await evaluate()).toMatchObject({ ok: false, code: "zh_publish_incomplete" });
  });

  it("作品 ID 或定时不同，不能把其他作品的实际回执并进来", async () => {
    await receipts(fixture.env, fixture.source);
    const file = path.join(fixture.source.root, "06-publish/publish-plan.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.platforms[0].publication.post_id = "other-work";
    await fs.writeFile(file, JSON.stringify(raw));
    expect(await evaluate()).toMatchObject({ ok: false, code: "publish_receipt_mismatch" });
    raw.platforms[0].publication.post_id = `${ZH[0]}-id`;
    raw.platforms[0].publication.scheduled_at = new Date(Date.now() + 4 * 86_400_000).toISOString();
    await fs.writeFile(file, JSON.stringify(raw));
    expect(await evaluate()).toMatchObject({ ok: false, code: "publish_receipt_mismatch" });
  });

  it("比较最后实际提交时刻，观察刷新不使旧排期跨过启用门槛", async () => {
    const floor = new Date(Date.now() - 10_000).toISOString();
    const old = new Date(Date.now() - 60_000).toISOString();
    await receipts(fixture.env, fixture.source, ZH, { submittedAt: old });
    expect(await evaluate({ notBefore: floor })).toMatchObject({ ok: false, code: "before_policy_enabled" });
    await receipts(fixture.env, fixture.source, [ZH[3]], { plan: false, submittedAt: new Date().toISOString() });
    const file = path.join(fixture.source.root, "06-publish/publish-plan.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.platforms[3].publication.submitted_at = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(raw));
    expect(await evaluate({ notBefore: floor })).toMatchObject({ ok: true });
  });

  it("scheduled 变成已核到 public 仍满足，不要求永远停留在 scheduled", async () => {
    await receipts(fixture.env, fixture.source, ZH, { state: "public" });
    expect(await evaluate()).toMatchObject({ ok: true });
  });

  it("其他公开作品不能为本轮新定时 claim 提供实际回执", async () => {
    await receipts(fixture.env, fixture.source);
    const file = path.join(fixture.source.root, "06-publish/publish-plan.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    raw.platforms[0].publication.status = "public";
    delete raw.platforms[0].publication.scheduled_at;
    await fs.writeFile(file, JSON.stringify(raw));
    expect(await evaluate()).toMatchObject({ ok: false, code: "publish_receipt_mismatch" });
  });

  it("只产生本条去向意图；全局停止保留意图并明确阻断原因", async () => {
    await receipts(fixture.env, fixture.source);
    const source = (await getContentStrict(fixture.source.id, fixture.env.dir))!;
    await mutatePlan(source, fixture.env.dir, await loadProfile(fixture.env.dir), (plan) => {
      plan.destinations.wechat_mp!.required = false;
      plan.destinations.x!.required = false;
    });
    expect(await evaluate()).toMatchObject({ ok: true, value: { intents: [{ kind: "en_edition", targetPlatforms: ["youtube"] }] } });
    await updateProfile({ platforms: ZH }, fixture.env.dir);
    expect(await evaluate()).toMatchObject({ ok: true, value: { intents: [{ kind: "en_edition", blockedReason: expect.stringContaining("取消") }] } });
  });

  it("字幕字节变了是明确不满足；字幕 I/O 失败是可见读取错误", async () => {
    await receipts(fixture.env, fixture.source);
    const doc = await readProductionDocOrEmpty(fixture.source.id, fixture.env.dir);
    const srt = doc.facts.find((fact) => fact.kind === "srt")!;
    const file = factPath(fixture.source.id, srt, fixture.env.dir);
    await fs.writeFile(file, "1\n00:00:00,000 --> 00:00:01,000\nchanged\n");
    expect(await evaluate()).toMatchObject({ ok: false, code: "source_srt_changed" });
    await fs.rm(file);
    expect(await evaluate()).toMatchObject({ ok: false, code: "source_unreadable" });
  });

  it("损坏去向或发布计划明确回读取错误", async () => {
    await receipts(fixture.env, fixture.source);
    await fs.writeFile(path.join(fixture.source.root, "06-publish/publish-plan.json"), "{broken");
    expect(await evaluate()).toMatchObject({ ok: false, code: "source_unreadable" });
  });
});
