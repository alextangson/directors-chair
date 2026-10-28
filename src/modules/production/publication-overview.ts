/** Public-facing publication status. The production lifecycle's D1 means submitted, not publicly visible. */
import type { Content } from "../../storage/local-store.js";
import { isOntologyActive, readProductionDoc } from "../../storage/production-store.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { loadProfile } from "../profile/creator-profile.js";
import { isThemeRoot, readPlan } from "../theme/plan.js";
import { ZH_VIDEO } from "../theme/destinations.js";
import { publishTargets, LIVE_STATES, type PublishTarget, type TargetState } from "./targets.js";

export interface PublicationOverview {
  state: "not_started" | "scheduled" | "reviewing" | "public" | "partial" | "needs_check" | "failed";
  label: string;
  submitted: number;
  total: number;
  platforms: Array<{ platform: string; state: TargetState }>;
  /** Existing receipts outside the current plan remain visible without becoming new work. */
  additional?: Array<{ platform: string; state: TargetState }>;
  error?: string;
}

export function publicationOverview(targets: readonly PublishTarget[]): PublicationOverview {
  const platforms = targets.map(({ platform, state }) => ({ platform, state }));
  const submitted = targets.filter((t) => LIVE_STATES.has(t.state)).length;
  const total = targets.length;
  let state: PublicationOverview["state"] = "not_started";
  let label = total ? "目标平台尚未投出" : "当前没有待发布目标";
  if (targets.some((t) => t.state === "被驳回")) { state = "failed"; label = "有平台未发成"; }
  else if (targets.some((t) => ["待核", "读不到", "应已公开"].includes(t.state))) { state = "needs_check"; label = "发布状态待核实"; }
  else if (total && targets.every((t) => t.state === "已公开")) { state = "public"; label = "已公开"; }
  else if (total && targets.every((t) => t.state === "已定时")) { state = "scheduled"; label = "已排期"; }
  else if (submitted && submitted < total) { state = "partial"; label = "部分平台已投出"; }
  else if (submitted) { state = "reviewing"; label = "发布中"; }
  return { state, label, submitted, total, platforms };
}

/** Read only. Include this theme's intended Chinese destinations, so one receipt cannot imply completion. */
export async function publicationOverviewOf(content: Content, dataDir: string, doc?: ProductionDoc | null): Promise<PublicationOverview> {
  try {
    const [production, record, active] = await Promise.all([
      doc === undefined ? readProductionDoc(content.id, dataDir) : doc,
      readPublishRecord(content.id, content.manualPublications, dataDir),
      isOntologyActive(dataDir, content.id),
    ]);
    const picked: string[] = [];
    const excluded = new Set<string>();
    if (isThemeRoot(content)) {
      const { plan } = await readPlan(content, dataDir, await loadProfile(dataDir));
      for (const [platform, entry] of Object.entries(plan.destinations)) {
        if (entry?.required && ZH_VIDEO.has(platform)) picked.push(platform);
        if (entry && !entry.required && ZH_VIDEO.has(platform)) excluded.add(platform);
      }
    }
    const targets = publishTargets(content, production, record, active, picked);
    const intended = targets.filter((t) => !excluded.has(t.platform) && (!picked.length || picked.includes(t.platform)));
    const additional = targets.filter((t) => !intended.includes(t) && !["未发", "读不到"].includes(t.state))
      .map(({ platform, state }) => ({ platform, state }));
    return { ...publicationOverview(intended), ...(additional.length ? { additional } : {}) };
  } catch (err) {
    return { state: "needs_check", label: "发布状态待核实", submitted: 0, total: 0, platforms: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function publicationNext(overview: PublicationOverview): string {
  switch (overview.state) {
    case "scheduled": return "排期已完成；到点后核对各平台是否公开，不重复提交";
    case "public": return "已公开，可看数据回流";
    case "partial": return "继续处理未投出的目标平台，已投出的不重复提交";
    case "reviewing": return "等待各平台审核或定时公开，再核对结果，不重复提交";
    case "failed": return "先核对未发成的平台，处理驳回原因后再重试该平台";
    case "needs_check": return "先到平台后台核对实际状态，确认前不重复提交";
    case "not_started": return overview.total ? "按本条去向计划准备发布，已有历史回执不代表本轮已投出" : "本条当前没有待发布目标，保留历史回执，不新增投稿";
  }
}
