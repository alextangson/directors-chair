/**
 * autocrew_draft rival：比稿（试行，spec 2026-11-06）。开头选定后让 Gemini 按同一份锁住的依据写一版全文。
 * - rival{content_id, base_version}：启动，立即回 rival_id；同一份简报在跑 / 已完成就回同一个，不重复请求。
 * - rival{content_id, rival_id}：取状态 running / done{body} / failed{reason} / interrupted / stale。
 * - save 带 rival_pick 记创始人盲选的结果（pickRefusal / recordPick 在这里，save 调用）。
 */
import { randomUUID } from "node:crypto";
import { getContent, type Content, type ContentTx } from "../storage/local-store.js";
import { isRealDraft } from "../storage/first-body-guard.js";
import { needsOpening } from "../modules/draft/draft-types.js";
import { angleKey, briefHash, buildRivalBrief, RIVAL_SYSTEM } from "../modules/draft/rival-brief.js";
import { callGemini, NOT_CONFIGURED_HINT, rivalKey, rivalModel } from "../modules/draft/rival-gemini.js";
import { finishRival, isLive, rivalTally, trackJob, viewOf, type RivalRecord } from "../modules/draft/rival-store.js";
import type { RivalPickInput } from "../modules/draft/draft-args-extra.js";
import { stageRefusal } from "./draft-start.js";
import { fail, withVersion } from "./draft-version.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;
const COST_NOTE = "按 Gemini 官网单价估的美元数，不是实际账单";

function receipt(r: RivalRecord, c: Content): R {
  const view = viewOf(r, c.draftPath?.angle ? angleKey(c.draftPath.angle) : null);
  return {
    rival_id: r.id, status: view, model: r.model, pickable: view === "done" && !r.pick,
    ...(view === "done" || (view === "stale" && r.body) ? { body: r.body } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(view === "interrupted" ? { reason: "服务重启过，这次比稿没跑完：可以重新发起 rival{content_id, base_version}" } : {}),
    ...(view === "stale" ? { reason: "立意或开头改过了：这版 Gemini 稿作废，不能选；要比稿就重新发起" } : {}),
    ...(r.usage ? { usage: r.usage, cost_usd_estimate: r.cost_usd_estimate, cost_note: COST_NOTE } : {}),
    ...(r.pick ? { picked: r.pick.picked } : {}),
  };
}

async function runJob(c: Content, rec: RivalRecord, key: string, brief: string, dataDir?: string): Promise<void> {
  try {
    const r = await callGemini(key, rec.model, RIVAL_SYSTEM, brief);
    await finishRival(c.id, rec.id, r.ok ? { status: "done", body: r.body, usage: r.usage, cost_usd_estimate: r.cost_usd_estimate } : { status: "failed", reason: r.reason }, dataDir);
  } catch (err) {
    await finishRival(c.id, rec.id, { status: "failed", reason: `比稿落盘失败：${err instanceof Error ? err.message : String(err)}` }, dataDir).catch(() => undefined);
  }
}

function startRefusal(c: Content | null, a: DraftArgs): R | null {
  if (!c) return fail("not_found", `稿件不存在：${a.contentId}`);
  if (!c.draftPath) return fail("not_started", "这篇还没用 autocrew_draft 接手：先调 start{content_id}");
  const stage = stageRefusal(c);
  if (stage) return stage;
  if (!c.draftPath.angle) return fail("needs_angle", "还没记立意：比稿在立意和开头都选定之后");
  if (needsOpening(c.draftPath.angle)) return fail("needs_opening", "还没选开头：比稿在开头选定之后");
  return null;
}

async function start(a: DraftArgs): Promise<R> {
  const pre = await getContent(a.contentId!, a.dataDir);
  const bad = startRefusal(pre, a);
  if (bad) return bad;
  // 篇幅按主会话第 1 版定，所以先等它存下
  if (!(await isRealDraft(pre!, a.dataDir))) return fail("needs_host_draft", "先存你那版第 1 版再发起比稿：Gemini 的篇幅按你那版的字数定（只给字数，不给正文）");
  const key = await rivalKey(a.dataDir);
  if (!key) return fail("not_configured", NOT_CONFIGURED_HINT);
  let brief: string;
  try { brief = await buildRivalBrief(pre!, a.dataDir); } catch (err) { return fail("failed", `比稿简报拼不出来：${err instanceof Error ? err.message : String(err)}`); }
  const hash = briefHash(brief);
  const snapKey = angleKey(pre!.draftPath!.angle!);
  let created: RivalRecord | null = null;
  // 在写锁里就登记为在跑：否则锁一放、任务还没挂上，并发的第二次调用会把它读成 interrupted 再请求一次
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const r = await withVersion(a, async (c, tx) => {
    const ak = angleKey(c.draftPath!.angle!);
    // 拼简报时读的是锁外快照；改立意 / 开头不涨版本号，这里再核一次，免得旧简报挂到新立意名下
    if (ak !== snapKey || needsOpening(c.draftPath!.angle)) return fail("angle_changed", "拼简报期间立意或开头改过了：重新发起 rival{content_id, base_version}");
    const same = (c.draftPath!.rivals ?? []).find((x) => x.brief_hash === hash && ["running", "done"].includes(viewOf(x, ak)));
    if (same) return { ok: true, reused: true, ...receipt(same, c) };
    const rec: RivalRecord = { id: `rival-${randomUUID().slice(0, 8)}`, status: "running", brief_hash: hash, angle_key: ak, model: rivalModel(), started_at: new Date().toISOString() };
    await tx.write({ draftPath: { ...c.draftPath!, rivals: [...(c.draftPath!.rivals ?? []), rec] } });
    created = rec;
    trackJob(rec.id, gate);
    return { ok: true, reused: false, rival_id: rec.id, status: "running", model: rec.model };
  });
  if (created) void runJob(pre!, created, key, brief, a.dataDir).finally(release);
  else release();
  return r.ok ? { ...r, tally: await rivalTally(a.dataDir), next_action: { note: "接着给你那版做试读；之后用 rival{content_id, rival_id} 取 Gemini 稿（最多等 10 分钟）" } } : r;
}

async function status(a: DraftArgs): Promise<R> {
  const c = await getContent(a.contentId!, a.dataDir);
  const rec = c?.draftPath?.rivals?.find((r) => r.id === a.rivalId);
  if (!c || !rec) return fail("rival_not_found", `这篇没有这次比稿：${a.rivalId}`);
  return { ok: true, ...receipt(rec, c), live: isLive(rec.id), tally: await rivalTally(a.dataDir) };
}

export async function draftRival(a: DraftArgs): Promise<R> {
  if (!a.contentId) return fail("bad_param", "rival 要带 content_id");
  return a.rivalId ? status(a) : start(a);
}

/** save 带 rival_pick：能不能选 */
export function pickRefusal(p: RivalPickInput, c: Content, body: string | undefined): R | null {
  const rec = c.draftPath?.rivals?.find((r) => r.id === p.rival_id);
  if (!rec) return fail("rival_not_found", `这篇没有这次比稿：${p.rival_id}`);
  if (rec.pick) return fail("rival_already_picked", `这次比稿已经选过了（${rec.pick.picked}），同一个 rival_id 只能选一次`);
  const view = viewOf(rec, c.draftPath?.angle ? angleKey(c.draftPath.angle) : null);
  if (view === "stale") return fail("rival_stale", "立意或开头改过了，这版 Gemini 稿已作废，不能选");
  if (view !== "done") return fail("rival_not_ready", `这次比稿还不能选：${view}`);
  if (p.picked === "rival" && body !== rec.body) return fail("rival_body_mismatch", "选 Gemini 那版时 body 要和它的原文逐字一致；想改就先原样选，再按第 6 步改");
  return null;
}

export function rivalAuthor(c: Content, rivalId: string): { host: string; writtenBy: Content["writtenBy"]; note: string } {
  const model = c.draftPath!.rivals!.find((r) => r.id === rivalId)!.model;
  return { host: `gemini:${model}`, writtenBy: { kind: "engine", provider: "gemini", model }, note: `比稿选中 Gemini 那版（${model}）` };
}

/** 选完记到这次比稿上（同一把单稿写锁里） */
export async function recordPick(tx: ContentTx, p: RivalPickInput, version: number, a: DraftArgs): Promise<void> {
  const c = await tx.read();
  const dp = c!.draftPath!;
  const hostRead = [...(dp.testReads ?? [])].reverse().find((t) => p.picked === "host" || t.version < version)?.status ?? null;
  const rivalRead = p.test_reads?.rival ?? (p.picked === "rival" && typeof a.testRead === "object" ? a.testRead.status : null);
  const pick = { picked: p.picked, founder_words: p.founder_words, version, test_reads: { host: p.test_reads?.host ?? hostRead, rival: rivalRead }, at: new Date().toISOString() };
  await tx.write({ draftPath: { ...dp, rivals: dp.rivals!.map((r) => (r.id === p.rival_id ? { ...r, pick } : r)) } });
}
