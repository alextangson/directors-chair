import { createHash } from "node:crypto";
import { getContentStrict } from "../../storage/local-store.js";
import { loadProfile } from "../profile/creator-profile.js";
import { mutatePlan, readPlan } from "../theme/plan.js";
import { evaluateSource } from "./eligibility.js";
import { mutateOutbox, readOutbox } from "./store.js";
import type { DispatchJob, DispatchOutbox, DispatchPolicy } from "./types.js";

const sent = (job: DispatchJob) => job.state === "started" || job.state === "unknown" || job.state === "dispatching" || Boolean(job.session?.threadId);
const key = (sourceId: string, round: number, cut: string, kind: string) => `derivative-${createHash("sha256").update(JSON.stringify([sourceId, round, cut, kind])).digest("hex").slice(0, 32)}`;

/** Rebuildable from source facts. Never erase a delivered or uncertain session while reconciling. */
export async function reconcileSource(sourceId: string, dataDir: string, policy: DispatchPolicy, now = new Date(), options: { includeExisting?: boolean } = {}): Promise<DispatchOutbox> {
  const current = await readOutbox(sourceId, dataDir);
  const evaluationOptions = { fresh: false, ...(options.includeExisting ? {} : { notBefore: policy.enabledAt }) };
  let eligible = policy.enabled ? await evaluateSource(sourceId, dataDir, evaluationOptions)
    : { ok: false as const, code: "policy_disabled", error: "自动派生已关闭" };
  if (!eligible.ok && eligible.code === "source_unreadable") throw new Error(eligible.error);
  if (!eligible.ok && eligible.code === "before_policy_enabled" && current.jobs.some((job) => job.manualRequestedAt)) {
    const manual = await evaluateSource(sourceId, dataDir, { fresh: false });
    if (!manual.ok && manual.code === "source_unreadable") throw new Error(manual.error);
    if (manual.ok) {
      const scope = manual.value;
      const intents = scope.intents.filter((intent) => current.jobs.some((job) => job.manualRequestedAt && job.round === scope.round && job.sourceCutHash === scope.sourceCutHash && job.kind === intent.kind));
      if (intents.length) eligible = { ok: true, value: { ...scope, intents } };
    }
  }
  if (eligible.ok && eligible.value.intents.length) {
    // 默认去向只读时会跟随档案；第一次产生任务前冻结，之后的勾选变化不改这批任务的范围。
    const source = await getContentStrict(sourceId, dataDir);
    if (source) {
      const profile = await loadProfile(dataDir);
      if (!(await readPlan(source, dataDir, profile)).persisted) {
        await mutatePlan(source, dataDir, profile, () => undefined);
        // 冻结不改变本次已经确认的手动补入范围；重新核验其余来源事实。
        const rechecked = await evaluateSource(sourceId, dataDir, { fresh: false });
        if (!rechecked.ok && rechecked.code === "source_unreadable") throw new Error(rechecked.error);
        if (rechecked.ok) {
          const kinds = new Set(eligible.value.intents.map((intent) => intent.kind));
          eligible = { ok: true, value: { ...rechecked.value, intents: rechecked.value.intents.filter((intent) => kinds.has(intent.kind)) } };
        } else eligible = rechecked;
      }
    }
  }
  if (!eligible.ok && !current.jobs.length) return current;
  const at = now.toISOString();
  return mutateOutbox(sourceId, dataDir, (box) => {
    const desired = new Map<string, DispatchJob>();
    if (eligible.ok) {
      const source = eligible.value;
      for (const intent of source.intents) {
        const id = key(sourceId, source.round, source.sourceCutHash, intent.kind);
        const existing = box.jobs.find((job) => job.id === id);
        // 取消后恢复同一个语义任务；保留派生稿 ID、原尝试历史和已知会话。
        const state = intent.blockedReason ? "blocked" : "queued";
        desired.set(id, { ...(existing ?? {}), id, sourceId, sourceTitle: source.sourceTitle, round: source.round, sourceCutHash: source.sourceCutHash,
          kind: intent.kind, targetPlatforms: intent.targetPlatforms, requiredZhPlatforms: source.requiredZhPlatforms, receiptRefs: source.receiptRefs,
          policyId: policy.id, host: policy.host, state, createdAt: existing?.createdAt ?? at, updatedAt: at,
          ...(options.includeExisting ? { manualRequestedAt: existing?.manualRequestedAt ?? at } : {}),
          ...(intent.blockedReason ? { code: "line_stopped", reason: intent.blockedReason } : { code: undefined, reason: undefined }) });
      }
    }
    for (const job of box.jobs) {
      const next = desired.get(job.id);
      if (sent(job)) { desired.delete(job.id); continue; }
      if (!next) {
        if (job.state !== "cancelled") Object.assign(job, { state: "cancelled", code: eligible.ok ? "source_changed" : eligible.code, reason: eligible.ok ? "来源轮次、成片或去向已变化" : eligible.error, updatedAt: at, lease: undefined });
        continue;
      }
      const sameTargets = JSON.stringify(job.targetPlatforms) === JSON.stringify(next.targetPlatforms) && JSON.stringify(job.requiredZhPlatforms) === JSON.stringify(next.requiredZhPlatforms);
      if (job.state === "leased" && sameTargets && job.policyId === policy.id && next.state === "queued") {
        desired.delete(job.id); continue;
      }
      // 排期或快照更新不重建任务；改变执行范围时撤掉旧租约，由 worker 重新领。
      const changed = JSON.stringify({ ...job, updatedAt: undefined, lease: undefined }) !== JSON.stringify({ ...next, updatedAt: undefined, lease: undefined });
      if (changed || !sameTargets) Object.assign(job, next, { lease: undefined });
      desired.delete(job.id);
    }
    box.jobs.push(...desired.values());
  });
}
