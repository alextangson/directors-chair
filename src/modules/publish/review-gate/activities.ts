/**
 * 发布前检查的「活动」提醒（活动台账第二期，创始人 2026-10-31 定：只提醒不拦）。
 * 台账里有对口、排期时还在投稿期的活动，而计划这个平台既没选中它、也没写像样的不参加理由 → warn。
 * 不进检查指纹：台账变了不让已过的检查过期，只影响这次的提醒。
 */
import { freshnessOf, notOpenYet } from "../activity-ledger.js";
import { readLedger } from "../activity-ledger-store.js";
import type { PlanEntry } from "./plan.js";
import { platformLabel } from "./platforms.js";
import type { CheckItem } from "./types.js";

type Obj = Record<string, unknown>;
const CHECK = "活动";
/** 「条件待核 / 首发未知」不是不参加的理由：只参加带话题的活动不用等规则全核清 */
const VAGUE = /待核|未核|未知|待确认|未确认|待查/;

const keyOf = (c: Obj) => String(c.ledger_key ?? c.key ?? "");
const reasonOf = (c: Obj) => [c.reason, c.skip_reason, c.note].find((x): x is string => typeof x === "string" && !!x.trim())?.trim() ?? "";

/** scheduledAt = 这个平台实际发的时间（effectiveScheduledAt）；NaN = 没排期，按现在算 */
export async function activityItems(entry: PlanEntry, dataDir: string | undefined, now: number, scheduledAt: number): Promise<CheckItem[]> {
  let activities;
  try { activities = Object.values((await readLedger(dataDir)).activities); }
  catch (e) { return [{ check: CHECK, result: "warn", field: "campaigns", basis: `活动台账读不了，不能当成没有活动：${e instanceof Error ? e.message : String(e)}` }]; }
  const label = platformLabel(entry.platform);
  const mine = activities.filter((r) => r.platform === entry.platform);
  // 台账空着只是提示（activities 动作的 empty_platforms 会指去完整核查）；warn 只留给「有在期活动却没参加」
  if (!mine.length) return [{ check: CHECK, result: "info", field: "campaigns", basis: `台账里没有${label}的任何活动：按完整核查看一遍活动列表并入账（对口和不对口都记），核不了写明原因` }];
  const when = Number.isNaN(scheduledAt) ? now : scheduledAt;
  // 开始时间单独判：快截止的活动 freshnessOf 先给 recheck，不看还没开始
  const open = mine.filter((r) => r.relevance === "fits_us" && !notOpenYet(r, when) && freshnessOf(r, when) !== "expired");
  if (!open.length) return [{ check: CHECK, result: "info", field: "campaigns", basis: `台账里${label}在排期时没有在期的对口活动` }];
  const planned = entry.campaigns.filter((c): c is Obj => !!c && typeof c === "object");
  return open.map((r) => {
    const c = planned.find((x) => keyOf(x) === r.key);
    if (c?.selected === true) return { check: CHECK, result: "pass", field: "campaigns", basis: `参加「${r.name}」` };
    const reason = c ? reasonOf(c) : "";
    if (reason && !VAGUE.test(reason)) return { check: CHECK, result: "info", field: "campaigns", basis: `不参加「${r.name}」：${reason}` };
    const why = reason ? `写的理由「${reason}」是没核清，不是不参加的理由——只需带话题的就照常参加，不承诺独家` : "计划里既没选中它，也没写不参加的理由";
    return { check: CHECK, result: "warn", field: "campaigns", basis: `台账里有在期的对口活动「${r.name}」（${r.key}）：${why}` };
  });
}
