import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContentStrict } from "../../storage/local-store.js";
import { readProductionDocOrEmpty, writeProductionDoc } from "../../storage/production-store.js";
import { loadProfile, updateProfile } from "../profile/creator-profile.js";
import { mutatePlan, readPlanFile } from "../theme/plan.js";
import { reconcileSource } from "./reconcile.js";
import { mutateOutbox, readOutbox, writePolicy } from "./store.js";
import { dispatchFixture, receipts, ZH } from "./testkit.js";
import type { DispatchPolicy } from "./types.js";

let fixture: Awaited<ReturnType<typeof dispatchFixture>>;
let policy: DispatchPolicy;
beforeEach(async () => {
  fixture = await dispatchFixture();
  policy = await writePolicy({ enabled: true, host: "codex" }, fixture.env.dir, new Date(Date.now() - 10_000));
});
afterEach(async () => { await fixture.env.cleanup(); });
const reconcile = (options = {}) => reconcileSource(fixture.source.id, fixture.env.dir, policy, new Date(), options);

describe("派生 outbox 对账", () => {
  it("并发和重复对账只建两项，首次入队冻结去向，排期转公开不更换任务 ID", async () => {
    await receipts(fixture.env, fixture.source);
    expect(await readPlanFile(fixture.source.id, fixture.env.dir)).toBeNull();
    const boxes = await Promise.all(Array.from({ length: 4 }, () => reconcile()));
    for (const box of boxes) expect(box.jobs).toHaveLength(2);
    expect(await readPlanFile(fixture.source.id, fixture.env.dir)).not.toBeNull();
    const first = await readOutbox(fixture.source.id, fixture.env.dir);
    expect(await reconcile()).toEqual(first);
    await receipts(fixture.env, fixture.source, ZH, { state: "public" });
    expect((await reconcile()).jobs.map((job) => job.id)).toEqual(first.jobs.map((job) => job.id));
  });

  it("启用前已完成的旧排期默认不入队，明确补入只豁免同一 scope", async () => {
    await receipts(fixture.env, fixture.source, ZH, { submittedAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await reconcile()).jobs).toEqual([]);
    const backfilled = await reconcile({ includeExisting: true });
    expect(backfilled.jobs).toHaveLength(2);
    expect(backfilled.jobs.every((job) => job.manualRequestedAt)).toBe(true);
    expect((await reconcile()).jobs.every((job) => job.state === "queued")).toBe(true);
    const doc = await readProductionDocOrEmpty(fixture.source.id, fixture.env.dir);
    doc.round++;
    await writeProductionDoc(fixture.source.id, fixture.env.dir, doc, doc.revision);
    expect((await reconcile()).jobs.every((job) => job.state === "cancelled")).toBe(true);
    expect((await reconcile()).jobs).toHaveLength(2);
  });

  it("显式补入不会给后来新加的派生类型自动授权历史豁免", async () => {
    await receipts(fixture.env, fixture.source, ZH, { submittedAt: new Date(Date.now() - 60_000).toISOString() });
    const source = (await getContentStrict(fixture.source.id, fixture.env.dir))!;
    await mutatePlan(source, fixture.env.dir, await loadProfile(fixture.env.dir), (plan) => { plan.destinations.youtube!.required = false; plan.destinations.x!.required = false; });
    expect((await reconcile({ includeExisting: true })).jobs).toHaveLength(1);
    await mutatePlan(source, fixture.env.dir, await loadProfile(fixture.env.dir), (plan) => { plan.destinations.youtube!.required = true; });
    const next = await reconcile();
    expect(next.jobs).toHaveLength(1);
    expect(next.jobs[0]).toMatchObject({ kind: "wechat_article", state: "queued" });
  });

  it("关闭或重开只取消未发送任务，保留 started/unknown 会话事实", async () => {
    await receipts(fixture.env, fixture.source);
    const original = await reconcile();
    await mutateOutbox(fixture.source.id, fixture.env.dir, (box) => {
      box.jobs[0].state = "started"; box.jobs[0].session = { threadId: "thread-preserved", turnId: "turn-preserved" };
      box.jobs[1].state = "unknown"; box.jobs[1].attempt = { id: "attempt-uncertain", at: new Date().toISOString(), promptHash: "hash" };
    });
    const before = await readOutbox(fixture.source.id, fixture.env.dir);
    const disabled = await writePolicy({ enabled: false, host: "codex" }, fixture.env.dir);
    expect((await reconcileSource(fixture.source.id, fixture.env.dir, disabled)).jobs).toEqual(before.jobs);
    const doc = await readProductionDocOrEmpty(fixture.source.id, fixture.env.dir);
    doc.round++;
    await writeProductionDoc(fixture.source.id, fixture.env.dir, doc, doc.revision);
    expect((await reconcile()).jobs).toEqual(before.jobs);
    expect(original.jobs.map((job) => job.id)).toEqual(before.jobs.map((job) => job.id));
  });

  it("全局停用派生线保留 blocked 意图；单条取消去向使未发送任务 cancelled", async () => {
    await receipts(fixture.env, fixture.source);
    await reconcile();
    await updateProfile({ platforms: ZH }, fixture.env.dir);
    expect((await reconcile()).jobs.every((job) => job.state === "blocked" && job.code === "line_stopped")).toBe(true);
    const source = (await getContentStrict(fixture.source.id, fixture.env.dir))!;
    await mutatePlan(source, fixture.env.dir, await loadProfile(fixture.env.dir), (plan) => { plan.destinations.wechat_mp!.required = false; });
    const next = await reconcile();
    expect(next.jobs.find((job) => job.kind === "wechat_article")?.state).toBe("cancelled");
    expect(next.jobs.find((job) => job.kind === "en_edition")?.state).toBe("blocked");
  });

  it("未变化的租约保留；执行范围变化会撤掉旧租约", async () => {
    await receipts(fixture.env, fixture.source);
    await reconcile();
    await mutateOutbox(fixture.source.id, fixture.env.dir, (box) => { box.jobs[1].state = "leased"; box.jobs[1].lease = { owner: "worker-a", epoch: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
    expect((await reconcile()).jobs[1].state).toBe("leased");
    const source = (await getContentStrict(fixture.source.id, fixture.env.dir))!;
    await mutatePlan(source, fixture.env.dir, await loadProfile(fixture.env.dir), (plan) => { plan.destinations.x!.required = false; });
    expect((await reconcile()).jobs[1]).toMatchObject({ state: "queued", targetPlatforms: ["youtube"] });
    expect((await readOutbox(fixture.source.id, fixture.env.dir)).jobs[1].lease).toBeUndefined();
  });

  it("I/O 或 JSON 读取异常不把未发送任务误取消", async () => {
    await receipts(fixture.env, fixture.source);
    const before = await reconcile();
    const file = path.join(fixture.source.root, "06-publish/publish-plan.json");
    await fs.writeFile(file, "{broken");
    await expect(reconcile()).rejects.toThrow();
    expect(await readOutbox(fixture.source.id, fixture.env.dir)).toEqual(before);
  });
});
