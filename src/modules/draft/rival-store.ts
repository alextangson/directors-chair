/**
 * 比稿记录：落在稿件 draftPath.rivals 上。running 只有本进程里真在跑才算数，
 * 服务重启后读到的 running 一律当 interrupted（可以重新发起）。
 */
import { contentTransaction, listContents } from "../../storage/local-store.js";
import type { RivalUsage } from "./rival-gemini.js";

export type RivalPicked = "host" | "rival" | "merged";

export interface RivalPickRecord {
  picked: RivalPicked;
  founder_words: string;
  version: number;
  test_reads: { host: string | null; rival: string | null };
  at: string;
}

export interface RivalRecord {
  id: string;
  status: "running" | "done" | "failed";
  brief_hash: string;
  angle_key: string;
  model: string;
  started_at: string;
  finished_at?: string;
  body?: string;
  reason?: string;
  usage?: RivalUsage;
  cost_usd_estimate?: number;
  pick?: RivalPickRecord;
}

export type RivalView = "running" | "done" | "failed" | "interrupted" | "stale";

const live = new Map<string, Promise<void>>();
export const trackJob = (id: string, p: Promise<void>) => { live.set(id, p); void p.finally(() => live.delete(id)); };
export const isLive = (id: string) => live.has(id);
/** 只给测试：等后台那次 Gemini 调用落盘 */
export async function settleRivalJob(id: string): Promise<void> { await live.get(id); }

export function viewOf(r: RivalRecord, currentAngleKey: string | null): RivalView {
  if (r.status === "running" && !live.has(r.id)) return "interrupted";
  if (currentAngleKey !== null && r.angle_key !== currentAngleKey && !r.pick) return "stale";
  return r.status;
}

/** 后台任务结束：把结果写回这条记录（单稿写锁里读改写） */
export async function finishRival(contentId: string, id: string, patch: Partial<RivalRecord>, dataDir?: string): Promise<void> {
  await contentTransaction(contentId, dataDir, async (tx) => {
    const c = await tx.read();
    const dp = c?.draftPath;
    if (!dp?.rivals?.some((r) => r.id === id)) return;
    await tx.write({ draftPath: { ...dp, rivals: dp.rivals.map((r) => (r.id === id ? { ...r, ...patch, finished_at: new Date().toISOString() } : r)) } });
  });
}

export interface RivalTally { total: number; rival_wins: number; host_wins: number; merged: number; hint?: string }
const TRIAL_SIZE = 5;

/** 战绩：从各稿的比稿记录现数 */
export async function rivalTally(dataDir?: string): Promise<RivalTally> {
  const picks = (await listContents(dataDir)).filter((c) => !c.deletedAt).flatMap((c) => (c.draftPath?.rivals ?? []).map((r) => r.pick).filter((p): p is RivalPickRecord => Boolean(p)));
  const n = (k: RivalPicked) => picks.filter((p) => p.picked === k).length;
  const t: RivalTally = { total: picks.length, rival_wins: n("rival"), host_wins: n("host"), merged: n("merged") };
  return t.total >= TRIAL_SIZE ? { ...t, hint: `比稿已经试了 ${t.total} 篇：请创始人定去留（留就继续；不留就删掉 write-script 里「比稿（试行）」一节和 rival 动作）` } : t;
}
