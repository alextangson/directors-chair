import { getContent } from "../../storage/local-store.js";
import { readOutbox, readPolicy } from "./store.js";
import { createDispatchWorker } from "./worker.js";
import { createCodexAdapter } from "./codex-host.js";
import { reconcileSource } from "./reconcile.js";
import { notifyDerivativeChange } from "./events.js";
import type { CodexHostAdapter } from "./types.js";

let adapter: CodexHostAdapter | undefined;
const worker = createDispatchWorker({ adapter: () => adapter ??= createCodexAdapter({
  onAttention: (threadId, reason) => { void worker.attention(threadId, reason).catch((err) => console.error("[derivative-dispatch] 会话等待原因没写住:", (err as Error).message)); },
}) });
const fail = (error: unknown) => ({ ok: false as const, code: "derivative_dispatch_failed", error: error instanceof Error ? error.message : String(error) });

export async function dispatchStatus(sourceId: string, dataDir: string) {
  try {
    const source = await getContent(sourceId, dataDir);
    if (!source || source.deletedAt) return { ok: false, code: "source_missing", error: "源视频不存在" };
    const [policy, box] = await Promise.all([readPolicy(dataDir), readOutbox(sourceId, dataDir)]);
    return { ok: true, policy, jobs: box.jobs, revision: box.revision };
  } catch (err) { return fail(err); }
}

export async function prepareDispatch(sourceId: string, dataDir: string) {
  try {
    const policy = await readPolicy(dataDir);
    if (!policy.enabled) return { ok: false, code: "policy_disabled", error: "先在设置中开启 Codex 后台派生" };
    const box = await reconcileSource(sourceId, dataDir, policy, new Date(), { includeExisting: true });
    if (!box.jobs.some((j) => j.state !== "cancelled")) return { ok: false, code: "not_ready", error: "本条还没有满足条件的派生任务：检查目标平台排期、成片、字幕与去向计划" };
    notifyDerivativeChange(sourceId, dataDir);
    return { ok: true, policy, jobs: box.jobs, revision: box.revision };
  } catch (err) { return fail(err); }
}

export async function inspectDispatchThread(sourceId: string, jobId: string, dataDir: string, cursor?: string) {
  try {
    const job = (await readOutbox(sourceId, dataDir)).jobs.find((j) => j.id === jobId);
    if (!job?.session?.threadId) return { ok: false, code: "session_unknown", error: "还没有核到真实会话 ID" };
    adapter ??= createCodexAdapter({ onAttention: (id, reason) => { void worker.attention(id, reason).catch(() => undefined); } });
    return { ok: true, ...await adapter.inspect(job.session.threadId, cursor) };
  } catch (err) { return fail(err); }
}

export async function resumeDispatchThread(sourceId: string, jobId: string, dataDir: string) {
  try { return { ok: true, ...await worker.resume(sourceId, jobId, dataDir) }; }
  catch (err) { return fail(err); }
}

export async function dispatchSource(sourceId: string, dataDir: string, limit = 2): Promise<number> {
  const before = await readOutbox(sourceId, dataDir);
  const prior = new Set(before.jobs.filter((j) => j.state === "started").map((j) => j.id));
  const after = await worker.runSource(sourceId, dataDir, false, limit);
  return after.jobs.filter((j) => j.state === "started" && !prior.has(j.id)).length;
}
export const derivativeActiveCount = () => adapter?.activeCount() ?? 0;
export async function closeDerivativeHost(): Promise<void> {
  const active = adapter; adapter = undefined;
  if (active) await active.close();
}
