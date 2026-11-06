import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { contentFile } from "../../storage/content-project.js";
import { assertDataDirWritable, getConfigDir } from "../../storage/storage-roots.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import type { DispatchOutbox, DispatchPolicy } from "./types.js";

const policyPath = (dataDir: string) => path.join(getConfigDir(dataDir), "derivative-dispatch.json");
const outboxPath = (sourceId: string, dataDir: string) => contentFile(sourceId, dataDir, "derivative-outbox.json");
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = next.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const states = new Set(["queued", "leased", "dispatching", "started", "blocked", "unknown", "cancelled"]);

function validPolicy(raw: unknown): raw is DispatchPolicy {
  return object(raw) && raw.version === 1 && string(raw.id) && typeof raw.enabled === "boolean" && raw.host === "codex" && iso(raw.enabledAt);
}

function validOutbox(raw: unknown, sourceId: string): raw is DispatchOutbox {
  if (!object(raw) || raw.version !== 1 || !Number.isInteger(raw.revision) || Number(raw.revision) < 0 || !Array.isArray(raw.jobs)) return false;
  const ids = new Set<string>();
  return raw.jobs.every((job: unknown) => {
    if (!object(job) || !string(job.id) || ids.has(job.id) || job.sourceId !== sourceId || typeof job.sourceTitle !== "string"
      || !Number.isInteger(job.round) || Number(job.round) < 1 || !string(job.sourceCutHash)
      || !["wechat_article", "en_edition"].includes(String(job.kind)) || job.host !== "codex" || !states.has(String(job.state))
      || !string(job.policyId) || !iso(job.createdAt) || !iso(job.updatedAt)
      || !Array.isArray(job.targetPlatforms) || !job.targetPlatforms.every(string)
      || !Array.isArray(job.requiredZhPlatforms) || !job.requiredZhPlatforms.every(string)
      || !Array.isArray(job.receiptRefs) || !job.receiptRefs.every((r: unknown) => object(r) && string(r.platform) && string(r.slotId) && typeof r.evidence === "string" && (r.factId === undefined || string(r.factId)))) return false;
    if (job.lease !== undefined && (!object(job.lease) || !string(job.lease.owner) || !Number.isInteger(job.lease.epoch) || Number(job.lease.epoch) < 1 || !iso(job.lease.expiresAt))) return false;
    if (job.session !== undefined && (!object(job.session) || !string(job.session.threadId) || (job.session.turnId !== undefined && !string(job.session.turnId)) || (job.session.submittedAt !== undefined && !iso(job.session.submittedAt)))) return false;
    if (job.attempt !== undefined && (!object(job.attempt) || !string(job.attempt.id) || !iso(job.attempt.at) || !string(job.attempt.promptHash))) return false;
    if (job.derivedContentId !== undefined && !string(job.derivedContentId)) return false;
    if (job.cwd !== undefined && !string(job.cwd)) return false;
    if (job.manualRequestedAt !== undefined && !iso(job.manualRequestedAt)) return false;
    ids.add(job.id);
    return true;
  });
}

export async function readPolicy(dataDir: string): Promise<DispatchPolicy> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(policyPath(dataDir), "utf8"));
    if (!validPolicy(raw)) throw new Error("配置形状不正确");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, id: "dispatch-disabled", enabled: false, host: "codex", enabledAt: "1970-01-01T00:00:00.000Z" };
    throw new Error(`派生调度配置读不出来：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writePolicy(input: { enabled: boolean; host: "codex" }, dataDir: string, now = new Date()): Promise<DispatchPolicy> {
  if (typeof input.enabled !== "boolean" || input.host !== "codex") throw new Error("派生调度要明确 enabled 布尔值和 host=codex");
  return serialize(policyPath(dataDir), async () => {
    const previous = await readPolicy(dataDir);
    if (previous.enabled === input.enabled && previous.host === input.host) return previous;
    const next: DispatchPolicy = { version: 1, id: `dispatch-policy-${randomUUID()}`, enabled: input.enabled, host: input.host,
      enabledAt: input.enabled ? now.toISOString() : previous.enabledAt };
    await writeJsonAtomicMkdir(policyPath(dataDir), next);
    return next;
  });
}

export async function readOutbox(sourceId: string, dataDir: string): Promise<DispatchOutbox> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(outboxPath(sourceId, dataDir), "utf8"));
    if (!validOutbox(raw, sourceId)) throw new Error("任务、租约或会话记录形状不正确");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, jobs: [] };
    throw new Error(`派生任务读不出来（${sourceId}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 单资料库写者负责跨进程占用；本队列只串行化同进程的原子文件更新。 */
export async function mutateOutbox(sourceId: string, dataDir: string, fn: (outbox: DispatchOutbox) => void | Promise<void>): Promise<DispatchOutbox> {
  const file = outboxPath(sourceId, dataDir);
  return serialize(file, async () => {
    assertDataDirWritable(dataDir);
    const previous = await readOutbox(sourceId, dataDir);
    const next = structuredClone(previous);
    await fn(next);
    if (!validOutbox(next, sourceId)) throw new Error(`派生任务更新无效（${sourceId}），没有写入`);
    if (JSON.stringify(next.jobs) === JSON.stringify(previous.jobs)) return previous;
    next.revision = previous.revision + 1;
    await writeJsonAtomicMkdir(file, next);
    return next;
  });
}
