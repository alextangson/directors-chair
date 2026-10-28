import { getContentStrict } from "../../storage/local-store.js";
import { isOntologyActive, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { approvedCutIdentity } from "../lineage/cut-identity.js";
import { parseTimedSrt } from "../en-edition/source.js";
import { loadProfile } from "../profile/creator-profile.js";
import { enabledPlatforms, lineStoppedReason } from "../profile/platform-lines.js";
import { canonPlatform, slotOf } from "../production/receipts.js";
import { srtFor, validCutApproval } from "../production/derive.js";
import { factPath } from "../production/chat-approval/files.js";
import { ZH_VIDEO } from "../theme/destinations.js";
import { isThemeRoot, readPlan } from "../theme/plan.js";
import type { Eligibility, EligibleSource } from "./types.js";

const fail = (code: string, error: string): Eligibility => ({ ok: false, code, error });
const time = (at: string | null | undefined): number | null => at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;

/** Read only: a display stage or one accepted claim never establishes all-platform completion. */
export async function evaluateSource(sourceId: string, dataDir: string, options: { notBefore?: string; fresh?: boolean } = {}): Promise<Eligibility> {
  try {
    const source = await getContentStrict(sourceId, dataDir);
    if (!source || source.deletedAt) return fail("source_missing", "源视频不存在或已删除");
    if (!isThemeRoot(source) || source.status === "archived") return fail("source_ineligible", "只有未归档的中文源视频可以自动派生");
    if (!(await isOntologyActive(dataDir, sourceId))) return fail("ontology_inactive", "源视频未纳入当前制作记录，不能自动判断本轮排期");
    const [doc, profile, record] = await Promise.all([
      readProductionDocOrEmpty(sourceId, dataDir), loadProfile(dataDir), readPublishRecord(sourceId, undefined, dataDir),
    ]);
    const { plan } = await readPlan(source, dataDir, profile);
    const requiredZhPlatforms = Object.entries(plan.destinations).filter(([platform, entry]) => ZH_VIDEO.has(platform) && entry?.required).map(([platform]) => platform).sort();
    if (!requiredZhPlatforms.length) return fail("no_zh_targets", "本条去向计划没有必发中文视频平台，不自动派生");
    if (record.kind !== "ok") return fail(record.kind === "unreadable" ? "source_unreadable" : "publish_receipt_missing", record.kind === "unreadable" ? record.reason : "缺少实际平台排期回执");
    const receiptRefs: EligibleSource["receiptRefs"] = [];
    const completionTimes: number[] = [];
    for (const platform of requiredZhPlatforms) {
      const slot = slotOf(doc, doc.round, platform);
      if (!slot?.verified || (slot.pub_state !== "scheduled" && slot.pub_state !== "public")) return fail("zh_publish_incomplete", `${platform} 本轮尚无有效排期或公开回执`);
      const actual = record.platforms.find((p) => canonPlatform(p.platform) === platform);
      if (!actual?.submitted || (actual.state !== "scheduled" && actual.state !== "public")) return fail("publish_receipt_missing", `${platform} 尚未核到实际排期或公开回执`);
      if (actual.state === "scheduled" && (!actual.scheduledAt || time(actual.scheduledAt) === null)) return fail("publish_receipt_invalid", `${platform} 的定时回执没有有效定时时间`);
      if (slot.item_id && actual.postId && slot.item_id !== actual.postId) return fail("publish_receipt_mismatch", `${platform} 的平台作品 ID 与本轮回执不一致`);
      if (slot.pub_state === "scheduled" && (time(slot.published_at) === null || time(slot.published_at) !== time(actual.scheduledAt))) return fail("publish_receipt_mismatch", `${platform} 的定时时间与本轮回执不一致`);
      const fact = slot.fact_id ? doc.facts.find((f) => f.id === slot.fact_id) : undefined;
      const submitted = time(actual.submittedAt) ?? time(fact?.submitted_at);
      const roundStart = time(doc.round_started_at);
      if (roundStart !== null && submitted !== null && submitted < roundStart) return fail("publish_receipt_old_round", `${platform} 的实际提交属于上一轮`);
      const completedAt = submitted ?? time(fact?.seen_at) ?? time(slot.seen_at);
      if (completedAt === null) return fail("publish_receipt_invalid", `${platform} 回执缺少可核验的提交或观察时间`);
      completionTimes.push(completedAt);
      receiptRefs.push({ platform, slotId: slot.id, ...(slot.fact_id ? { factId: slot.fact_id } : {}), evidence: `publish-plan:${platform}:${actual.state}:${actual.postId ?? actual.url ?? actual.scheduledAt ?? actual.time ?? ""}` });
    }
    if (options.notBefore) {
      const floor = time(options.notBefore);
      if (floor === null) return fail("invalid_not_before", "自动派生启用时间无效");
      if (Math.max(...completionTimes) < floor) return fail("before_policy_enabled", "本条中文排期在自动派生启用前已完成；需要明确补入才会派生");
    }
    const cut = await approvedCutIdentity(source, dataDir, { fresh: options.fresh !== false });
    if (cut.id === null) return fail(validCutApproval(doc, source.body)?.sha256 ? "source_unreadable" : "no_approved_cut", cut.reason);
    const srt = cut.id.startsWith("sha256:") ? srtFor(doc, cut.id.slice("sha256:".length)) : null;
    if (!srt?.path) return fail("no_source_srt", "当前成片还没有登记对应字幕");
    const bytes = await fs.readFile(factPath(sourceId, srt, dataDir));
    if (createHash("sha256").update(bytes).digest("hex") !== srt.sha256) return fail("source_srt_changed", "当前成片字幕在登记之后被改过");
    if (!parseTimedSrt(bytes.toString("utf8")).length) return fail("source_srt_invalid", "当前成片字幕为空，不能派生");
    const on = enabledPlatforms(profile);
    const intents: EligibleSource["intents"] = [];
    if (plan.destinations.wechat_mp?.required) {
      const stopped = lineStoppedReason(profile, "wechat_article");
      intents.push({ kind: "wechat_article", targetPlatforms: ["wechat_mp"], ...(stopped ? { blockedReason: stopped } : {}) });
    }
    const english = ["youtube", "x"].filter((platform) => plan.destinations[platform as "youtube" | "x"]?.required);
    if (english.length) {
      const stopped = english.find((platform) => !on.includes(platform));
      intents.push({ kind: "en_edition", targetPlatforms: english, ...(stopped ? { blockedReason: lineStoppedReason(profile, "en_edition", stopped) ?? `${stopped} 已暂停` } : {}) });
    }
    return { ok: true, value: { sourceId, sourceTitle: source.title, round: doc.round, sourceCutHash: cut.id, requiredZhPlatforms, receiptRefs, intents } };
  } catch (error) {
    return fail("source_unreadable", `派生来源核验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
