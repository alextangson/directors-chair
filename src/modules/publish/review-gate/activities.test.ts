/**
 * 发布前检查的「活动」提醒（台账第二期，2026-10-31）：在期对口活动没参加也没像样理由 → warn，不拦；
 * 活动列表带 used_by，看得出最近真用了几条。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activityItems } from "./activities.js";
import { effectiveScheduledAt, listActivities } from "../activity-ledger-store.js";
import type { PlanEntry } from "./plan.js";

const NOW = Date.parse("2026-10-31T12:00:00+08:00");
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "act-gate-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const act = (key: string, over: Record<string, unknown> = {}) => ({
  key, platform: "douyin", name: "Vibe知识大赏", official_url: "https://x", relevance: "fits_us", verified_at: "2026-10-28T22:58:59+08:00", sources: ["后台"], history: [],
  window: { start: "2026-10-22", end: "2026-11-30", timezone: "Asia/Shanghai" }, ...over,
});
const writeLedger = (acts: Array<ReturnType<typeof act>>) =>
  fs.writeFile(path.join(dir, "platform-activities.json"), JSON.stringify({ version: 1, activities: Object.fromEntries(acts.map((a) => [a.key, a])) }));
const entry = (campaigns: unknown[], over: Partial<PlanEntry> = {}): PlanEntry => ({
  platform: "douyin", content_id: "c1", account: "a", title: "t", caption: "c", tags: [], covers: [], legacy_cover: false, cover_text: null, video_path: null,
  scheduled_at: "2026-11-02T18:00:00+08:00", timezone: "Asia/Shanghai", campaigns, ...over,
});
const at = (e: PlanEntry) => Date.parse(e.scheduled_at ?? "");
const items = (e: PlanEntry) => activityItems(e, dir, NOW, at(e));
const results = async (e: PlanEntry) => (await items(e)).map((i) => i.result);

describe("activityItems", () => {
  it("在期对口活动没选也没理由：warn（不是 block）", async () => {
    await writeLedger([act("douyin:1")]);
    const got = await items(entry([]));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ check: "活动", result: "warn" });
    expect(got[0].basis).toContain("Vibe知识大赏");
  });

  it("选中了：pass；写了具体理由：info", async () => {
    await writeLedger([act("douyin:1")]);
    expect(await results(entry([{ ledger_key: "douyin:1", selected: true }]))).toEqual(["pass"]);
    expect(await results(entry([{ ledger_key: "douyin:1", selected: false, reason: "求婚片不是知识类" }]))).toEqual(["info"]);
  });

  it("理由是「待核 / 首发未知」：照样 warn", async () => {
    await writeLedger([act("douyin:1")]);
    const got = await items(entry([{ ledger_key: "douyin:1", selected: false, reason: "首发条件未知，不关联" }]));
    expect(got[0].result).toBe("warn");
    expect(got[0].basis).toContain("不是不参加的理由");
  });

  it("排期时已过期、还没开始、不对口、别的平台：都不提醒", async () => {
    await writeLedger([
      act("douyin:old", { window: { start: "2026-09-01", end: "2026-10-15", timezone: "Asia/Shanghai" } }),
      act("douyin:later", { window: { start: "2026-12-01", end: "2026-12-30", timezone: "Asia/Shanghai" } }),
      act("douyin:no", { relevance: "not_for_us", reason: "AI 影视赛" }),
      act("xiaohongshu:x", { platform: "xiaohongshu" }),
    ]);
    expect(await results(entry([]))).toEqual(["info"]);
  });

  it("排期在截止之后：按排期时间算过期，不提醒", async () => {
    await writeLedger([act("douyin:1")]);
    expect(await results(entry([], { scheduled_at: "2026-12-05T18:00:00+08:00" }))).toEqual(["info"]);
  });

  it("[Codex 审] 还没开始、但开始后 48 小时内就截止：不算在期", async () => {
    await writeLedger([act("douyin:1", { window: { start: "2026-11-03T00:00:00+08:00", end: "2026-11-04T00:00:00+08:00", timezone: "Asia/Shanghai" } })]);
    expect(await results(entry([]))).toEqual(["info"]);
  });

  it("[Codex 审] 排期只写在计划顶层或 publication 里：按那个时间算", async () => {
    await writeLedger([act("douyin:1")]);
    const top = effectiveScheduledAt({ scheduled_at: "2026-12-05T18:00:00+08:00", platforms: [{ platform: "douyin" }] }, "douyin", null);
    expect((await activityItems(entry([], { scheduled_at: null }), dir, NOW, top)).map((i) => i.result)).toEqual(["info"]);
    const pub = effectiveScheduledAt({ platforms: [{ platform: "douyin", publication: { scheduled_at: "2026-12-05T18:00:00+08:00" } }] }, "douyin", null);
    expect(pub).toBe(top);
    expect(Number.isNaN(effectiveScheduledAt({ platforms: [] }, "douyin", null))).toBe(true);
    expect(effectiveScheduledAt({ platforms: JSON.stringify([{ platform: "douyin", publication: { scheduled_at: "2026-12-05T18:00:00+08:00" } }]) }, "douyin", null)).toBe(top);
  });

  it("两个在期活动：各给一条", async () => {
    await writeLedger([act("douyin:1"), act("douyin:2", { name: "另一个" })]);
    expect(await results(entry([{ ledger_key: "douyin:1", selected: true }]))).toEqual(["pass", "warn"]);
  });

  it("台账里没有这个平台：info 指去完整核查；台账坏了：warn，不当成没有活动", async () => {
    expect((await items(entry([])))[0]).toMatchObject({ result: "info" });
    await fs.writeFile(path.join(dir, "platform-activities.json"), "{broken");
    const got = await items(entry([]));
    expect(got[0]).toMatchObject({ result: "warn" });
    expect(got[0].basis).toContain("不能当成没有活动");
  });
});

describe("listActivities used_by", () => {
  it("数发布计划里选中过它的视频条数，一条视频四个平台算一条", async () => {
    await writeLedger([act("douyin:1"), act("xiaohongshu:x", { platform: "xiaohongshu", name: "AI替我说" })]);
    const plan = (id: string, platforms: unknown[]) => fs.mkdir(path.join(dir, "projects", id, "06-publish"), { recursive: true })
      .then(() => fs.writeFile(path.join(dir, "projects", id, "06-publish", "publish-plan.json"), JSON.stringify({ content_id: id, platforms })));
    await plan("a", [{ platform: "douyin", campaigns: [{ ledger_key: "douyin:1", selected: true }] }, { platform: "xiaohongshu", campaigns: [{ ledger_key: "douyin:1", selected: true }] }]);
    await plan("b", [{ platform: "douyin", campaigns: JSON.stringify([{ ledger_key: "douyin:1", selected: true }]) }]);
    await plan("c", [{ platform: "douyin", campaigns: [{ ledger_key: "douyin:1", selected: false, reason: "不符" }] }]);
    const rows = (await listActivities(dir, NOW)).activities;
    expect(Object.fromEntries(rows.map((r) => [r.key, r.used_by]))).toEqual({ "douyin:1": 2, "xiaohongshu:x": 0 });
    expect((await listActivities(dir, NOW)).used_by_incomplete).toBeUndefined();
    await fs.mkdir(path.join(dir, "projects", "bad", "06-publish"), { recursive: true });
    await fs.writeFile(path.join(dir, "projects", "bad", "06-publish", "publish-plan.json"), "{nope");
    expect((await listActivities(dir, NOW)).used_by_incomplete?.unreadable_plans).toHaveLength(1);
    await plan("shape", [{ platform: "douyin", campaigns: { ledger_key: "douyin:1", selected: true } }]);
    expect((await listActivities(dir, NOW)).used_by_incomplete?.unreadable_plans).toHaveLength(2);
  });
});
