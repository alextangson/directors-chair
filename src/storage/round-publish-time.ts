/**
 * 已发布稿的「本轮发布时间」与「最近 N 条」保留名单：NAS 归档（会删本机文件）、发布即备份、「我的内容/5 已发布」共用这一份口径。
 *
 * 口径（创始人 10-30 放宽 09-30 的保守口径）：本轮已投出的平台槽都能给时间——可信观察或已认的 AI 回执里写的
 * 公开 / 定时时间、创始人点「我发了 / 确认已公开」的时刻（槽是已公开才算）、发布计划认定的槽里的定时时间。多个平台取最早；还没到点的时间
 * 照样返回（归档要发布满 24 小时，未来时间不会触发任何删除）。
 * 一个都定不出 → null：不归档、不备份，归档报告列「待确认发布时间」。旧稿（没按本体走）照用 publishedAt。
 */
import type { Content } from "./local-store.js";
import { isImportedHistory } from "./imported-history.js";
import { readProductionDocOrEmpty } from "./production-store.js";
import { ontologyApplies } from "../modules/production/publish-gate.js";
import { explainContent, explainContext } from "../modules/production/read.js";
import { canonPlatform, receiptsOfRound } from "../modules/production/receipts.js";
import { readPublishRecord } from "./publish-record.js";

export const KEEP_PUBLISHED = 5;

export async function roundPublishTime(c: Content, data: string, now: number = Date.now()): Promise<string | null> {
  if (!(await ontologyApplies(c, data))) return c.publishedAt ?? null;
  const doc = await readProductionDocOrEmpty(c.id, data);
  const plan = await readPublishRecord(c.id, undefined, data, now);
  const entries = new Map((plan.kind === "none" ? [] : plan.platforms).filter((p) => p.scheduledAt).map((p) => [canonPlatform(p.platform), p]));
  const times = receiptsOfRound(doc).live.map((s) => {
    const f = s.fact_id ? doc.facts.find((x) => x.id === s.fact_id) : undefined;
    if (f?.published_at) return Date.parse(f.published_at);
    // 创始人点「我发了 / 确认已公开」：只有槽确实是「已公开」时，那一刻才是公开时间；
    // 确认一条「已定时 / 审核中」的回执 ≠ 已经公开，确认时刻不能当发布时间（不然会在公开前就备份、删本机）
    if (s.by === "founder" && s.pub_state === "public" && s.seen_at) return Date.parse(s.seen_at);
    // 计划里的定时时间只给「本轮、纠正之后、由这份计划认定」的槽用：按平台去套，可能套上上一轮或被纠正掉的那次
    // 还要是同一次提交：计划在两次对账之间换了一条（新提交），旧观察不能借新条目的时间
    if (s.source === "plan") {
      const e = entries.get(canonPlatform(s.platform));
      return e && (e.submittedAt ?? null) === (f?.submitted_at ?? null) ? Date.parse(e.scheduledAt!) : NaN;
    }
    return NaN;
  }).filter((t) => !Number.isNaN(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

export async function withRoundPublishTime(c: Content, data: string): Promise<Content> {
  return { ...c, publishedAt: await roundPublishTime(c, data) };
}

export interface PublishedSet {
  /** 在「已发布」栏的稿，publishedAt 已换成本轮发布时间（定不出 = null） */
  published: Content[];
  /** 最近 KEEP_PUBLISHED 条（定不出时间的当最新，一律保留）：视图只显示它们，归档不动它们 */
  keep: Set<string>;
  /** 逐条读失败的（不挡其他稿） */
  errors: Array<{ content: Content; error: string }>;
}

/** 已发布栏 + 保留名单：逐条隔离，一条坏记录不挡整库 */
export async function publishedSet(contents: Content[], data: string, keepN = KEEP_PUBLISHED): Promise<PublishedSet> {
  const ctx = await explainContext(data);
  const published: Content[] = [];
  const errors: PublishedSet["errors"] = [];
  for (const c of contents) {
    // 历史作品记录没有素材，也不占「最近 5 条」的名额；视图与 NAS 归档共用这份名单
    if (isImportedHistory(c)) continue;
    try {
      if ((await explainContent(c, data, ctx)).column !== "已发布") continue;
      published.push({ ...c, publishedAt: await roundPublishTime(c, data) });
    } catch (e) { errors.push({ content: c, error: e instanceof Error ? e.message : String(e) }); }
  }
  const rank = (c: Content) => c.publishedAt ?? "9999";
  const keep = new Set([...published].sort((a, b) => rank(b).localeCompare(rank(a))).slice(0, keepN).map((c) => c.id));
  return { published, keep, errors };
}
