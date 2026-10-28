import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicationOverview, publicationOverviewOf } from "./publication-overview.js";
import { contentSummary } from "../../tools/content-summary.js";
import { makeEnv, projectRoot, record, videoContent, type Env } from "./testkit.js";
import type { PublishTarget, TargetState } from "./targets.js";

const target = (platform: string, state: TargetState): PublishTarget => ({ platform, state, actions: [] });

describe("publication status display", () => {
  it("does not call schedules, reviews, or elapsed schedules public", () => {
    expect(publicationOverview([target("douyin", "已定时")])).toMatchObject({ state: "scheduled", label: "已排期" });
    expect(publicationOverview([target("douyin", "审核中")])).toMatchObject({ state: "reviewing", label: "发布中" });
    expect(publicationOverview([target("douyin", "应已公开")])).toMatchObject({ state: "needs_check" });
    expect(publicationOverview([target("douyin", "已公开"), target("bilibili", "已定时")])).toMatchObject({ state: "reviewing" });
    expect(publicationOverview([target("douyin", "已公开"), target("bilibili", "已公开")])).toMatchObject({ state: "public", label: "已公开" });
  });

  it("keeps failed, unverified, and unfinished platforms visible", () => {
    expect(publicationOverview([target("douyin", "已定时"), target("bilibili", "未发")])).toMatchObject({ state: "partial", submitted: 1, total: 2 });
    expect(publicationOverview([target("douyin", "已公开"), target("bilibili", "被驳回")])).toMatchObject({ state: "failed" });
    expect(publicationOverview([target("douyin", "已公开"), target("bilibili", "读不到")])).toMatchObject({ state: "needs_check" });
    expect(publicationOverview([])).toMatchObject({ state: "not_started", submitted: 0, total: 0 });
  });
});

describe("publication receipts and content summaries", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: true }); });
  afterEach(async () => { await env.cleanup(); });

  it("reports a future schedule accurately in both write receipt and read summary", async () => {
    const c = await videoContent(env, "定时不是公开");
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const input = { content_id: c.id, kind: "publish", platform: "douyin", pub_state: "scheduled", scheduled_at: scheduledAt, request_id: "schedule" };
    const r = await record(env, input);
    expect(r).toMatchObject({ ok: true, stage: "已排期", production_stage: "已发布", publication: { state: "scheduled", submitted: 1, total: 1 } });
    expect(await record(env, input)).toMatchObject({ ok: true, replayed: true, verified: true, stage: "已排期", publication: { state: "scheduled" } });
    const summary = await contentSummary(c.id, env.dir);
    expect(summary).toMatchObject({ stage: "已排期", publication: { state: "scheduled" }, next: expect.stringContaining("不重复提交") });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(1536);
  });

  it("counts required destinations even when only one platform has a receipt", async () => {
    const c = await videoContent(env, "不能一条算全部");
    await fs.writeFile(path.join(env.dir, "creator-profile.json"), JSON.stringify({ platforms: ["douyin", "wechat_video", "xiaohongshu", "bilibili", "wechat_mp", "youtube"] }));
    const r = await record(env, { content_id: c.id, kind: "publish", platform: "douyin", pub_state: "scheduled", scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), request_id: "first-platform" });
    expect(r).toMatchObject({ stage: "部分平台已投出", publication: { state: "partial", submitted: 1, total: 4 } });
    const summary = await contentSummary(c.id, env.dir);
    expect(summary).toMatchObject({ stage: "部分平台已投出", publication: { state: "partial", total: 4 } });
  });

  it("does not silently report completion when the destination plan cannot be read", async () => {
    const c = await videoContent(env, "计划损坏");
    const dir = path.join(projectRoot(env, c.id), "00-project", "autocrew");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "destination-plan.json"), "{broken");
    expect(await publicationOverviewOf(c, env.dir)).toMatchObject({ state: "needs_check", error: expect.stringContaining("去向计划读不出来") });
  });

  it("does not turn an explicitly skipped platform in an old publish plan back into work", async () => {
    const c = await videoContent(env, "本条不出B站");
    const root = projectRoot(env, c.id), stateDir = path.join(root, "00-project", "autocrew");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(path.join(root, "06-publish"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "destination-plan.json"), JSON.stringify({ version: 2, created_at: c.createdAt, basis: ["douyin", "bilibili"], reshoots: [], destinations: {
      douyin: { required: true, by: "founder", at: c.createdAt }, bilibili: { required: false, by: "founder", at: c.createdAt, founder_words: "本条不出B站" },
    } }));
    await fs.writeFile(path.join(root, "06-publish", "publish-plan.json"), JSON.stringify({ platforms: [
      { platform: "douyin", publication: { status: "not_submitted" } }, { platform: "bilibili", publication: { status: "not_submitted" } },
    ] }));
    const scheduled = { kind: "publish", pub_state: "scheduled", scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), content_id: c.id };
    const r = await record(env, { ...scheduled, platform: "douyin", request_id: "only-required" });
    expect(r).toMatchObject({ stage: "已排期", publication: { state: "scheduled", submitted: 1, total: 1, platforms: [{ platform: "douyin", state: "已定时" }] } });
    // An existing out-of-plan receipt is retained as information, without changing the intended set.
    const extra = await record(env, { ...scheduled, platform: "bilibili", request_id: "existing-extra" });
    expect(extra).toMatchObject({ publication: { state: "scheduled", total: 1, additional: [{ platform: "bilibili", state: "已定时" }] } });
  });
});
