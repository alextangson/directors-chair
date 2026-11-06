import { authedFetch, SESSION_EXPIRED } from "../transport";

export interface DispatchPolicyView { enabled: boolean; host: "codex"; id: string; enabledAt: string }
export interface DispatchJobView {
  id: string; kind: "wechat_article" | "en_edition";
  state: "queued" | "leased" | "dispatching" | "started" | "blocked" | "unknown" | "cancelled";
  reason?: string; code?: string; derivedContentId?: string;
  session?: { threadId: string; turnId?: string };
}
export interface DispatchStatusView { policy: DispatchPolicyView; jobs: DispatchJobView[] }
export interface DispatchThreadView {
  threadId: string; status: string;
  turns: Array<{ id: string; status: string; items: Array<{ type: string; text?: string }> }>;
  nextCursor?: string | null; needsAttention?: string;
}
export type ResumeView = { status: "started"; session: { threadId: string } } | { status: "blocked" | "unknown"; code: string; error: string; threadId?: string };
export type DispatchReply<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };
const ROOT = "/api/derivative-dispatch";
async function call<T>(url: string, body?: Record<string, unknown>): Promise<DispatchReply<T>> {
  try {
    const r = await authedFetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const v = await r.json().catch(() => null) as { ok?: boolean; data?: T; error?: string; code?: string } | null;
    if (!r.ok || !v?.ok || v.data === undefined) return { ok: false, error: v?.error ?? (r.status === 403 ? SESSION_EXPIRED : `派生会话服务没有完整响应（HTTP ${r.status}）`), ...(v?.code ? { code: v.code } : {}) };
    return { ok: true, data: v.data };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}
export const loadDispatchPolicy = () => call<DispatchPolicyView>(`${ROOT}/policy`);
export const saveDispatchPolicy = (enabled: boolean) => call<DispatchPolicyView>(`${ROOT}/policy`, { enabled, host: "codex" });
export const loadDispatchStatus = (sourceId: string) => call<DispatchStatusView>(`${ROOT}?content_id=${encodeURIComponent(sourceId)}`);
export const prepareDispatch = (sourceId: string) => call<DispatchStatusView>(`${ROOT}/prepare`, { content_id: sourceId });
export const loadDispatchThread = (sourceId: string, jobId: string, cursor?: string) => call<DispatchThreadView>(`${ROOT}/thread?content_id=${encodeURIComponent(sourceId)}&job_id=${encodeURIComponent(jobId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
export const resumeDispatchThread = (sourceId: string, jobId: string) => call<ResumeView>(`${ROOT}/resume`, { content_id: sourceId, job_id: jobId });

/** 深链只使用已关联的正式 Codex UUID；打不开也不能退到新建会话。 */
export function codexDispatchLink(threadId: string): string | null {
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(threadId) ? `codex://threads/${threadId}` : null;
}
