import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gatherFacts } from "./retro-facts.js";
import { appendHypotheses, type Hypothesis } from "./hypotheses.js";
import { appendOutcomes } from "../flywheel/outcome-store.js";
import type { PerformanceOutcome } from "../flywheel/outcome-schema.js";

let dir: string;
const NOW = new Date("2026-10-28T12:00:00+08:00");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-retro-review-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

function row(id: string, overrides: Partial<PerformanceOutcome> = {}): PerformanceOutcome {
  return {
    contentId: id, platform: "douyin", platformTitle: id,
    publishedAt: "2026-10-19T12:00:00+08:00", metricDate: "2026-10-28",
    metrics: { views: 100 }, source: "auto", recordedAt: NOW.toISOString(),
    needsReview: false, reviewReasons: [], ...overrides,
  };
}

describe("周复盘统一使用已复核指标", () => {
  it("可疑播放不进定龄比较或机器裁决，同一快照的有效完播率保留", async () => {
    await appendOutcomes([
      ...Array.from({ length: 5 }, (_, i) => row(`peer-${i}`)),
      row("test", { metrics: { views: 9999999, completionRate: 33 }, needsReview: true, reviewReasons: ["播放量 9999999 超过平台中位数 100 的 20 倍，确认非读错字段"] }),
    ], dir);
    const hypothesis: Hypothesis = {
      id: "hyp-review", statement: "测试稿播放高于基线", metricFocus: "views", direction: "up",
      scope: { platform: "douyin" }, contentIds: ["test"], proposedAt: "2026-10-18T12:00:00+08:00",
      retroRunId: "retro-weekly-seed", status: "open",
    };
    await appendHypotheses([hypothesis], dir);
    const facts = await gatherFacts(7, dir);
    expect(facts.metricReview).toEqual({ excludedRows: 0, excludedMetrics: 1 });
    expect(facts.block).not.toContain("9999999");
    expect(facts.block).toContain("播放中位 100");
    expect(facts.block).toContain("完播率中位 33.0%");
    expect(facts.block).toContain("已剔除 1 个待复核指标");
    expect(facts.judged[0].verdict.status).toBe("inconclusive");
    expect(facts.judged[0].verdict.evidence.testValue).toBeNull();
  });

  it("认不出复核理由时整行排除，并报告排除的快照数和指标数", async () => {
    await appendOutcomes([
      row("valid"),
      row("unknown", { metrics: { views: 8888888, likes: 7777777 }, needsReview: true, reviewReasons: ["字段归属需要人工确认"] }),
    ], dir);
    const facts = await gatherFacts(7, dir);
    expect(facts.metricReview).toEqual({ excludedRows: 1, excludedMetrics: 2 });
    expect(facts.block).toContain("其中 1 条快照无有效指标");
    expect(facts.block).not.toContain("8888888");
    expect(facts.block).not.toContain("7777777");
    expect(facts.block).toContain("播放中位 100");
  });

  it("全部指标待复核时明确说明无可用数据，不误报账本没有快照", async () => {
    await appendOutcomes([row("pending", { needsReview: true, reviewReasons: ["字段待核"] })], dir);
    const facts = await gatherFacts(7, dir);
    expect(facts.metricReview).toEqual({ excludedRows: 1, excludedMetrics: 1 });
    expect(facts.block).toContain("全部快照的指标都待复核");
    expect(facts.block).not.toContain("一条快照都没有");
    expect(facts.block).not.toContain("播放中位");
  });
});
