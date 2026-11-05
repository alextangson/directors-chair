/** 比稿（spec 2026-11-06-dual-draft-gemini.md）验收清单逐条；Gemini HTTP 全部 mock */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pickOpening, OPENINGS } from "./draft-test-helpers.js";
import { executeDraft } from "./draft.js";
import { setQuoteFetch } from "../modules/draft/verify-quote.js";
import { setRivalFetch, setRivalTimeoutMs } from "../modules/draft/rival-gemini.js";
import { settleRivalJob } from "../modules/draft/rival-store.js";
import { contrastContext } from "../modules/draft/draft-context.js";
import { getContent, updateContent } from "../storage/local-store.js";
import { buildIpcHandlers } from "../desktop/ipc.js";

let dir: string;
let calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
let replies: Array<() => Response | Promise<Response>>;

const PAGE = "研究显示，参与调查的 1200 名职场人里，有 37% 每天用 AI 写周报。很多人说省下来的时间又被开会吃掉了。";
const QUOTE = "参与调查的 1200 名职场人里，有 37% 每天用 AI 写周报";
const HOST_BODY = "上周我省下了三个小时，下周又全没了。主会话独有的一句：这是 Claude 那版才有的句子。省下来的时间，被你自己又填满了。周报写得快了，会却变多了。所以真正要管的不是工具，是你的日程。今天就试一件事：把省下来的时间写进日历。";
const GEMINI_BODY = "上周我省下了三个小时，下周又全没了。Gemini 这版换了个说法：时间不是被偷走的，是你自己让出去的。周报写快了，会就跟着变多。真正要管的是日程，不是工具。今天就做一件事：把省下来的时间先写进日历，标上不许约。";
const ANGLE = { exemplars: [] as unknown[], main_line: "AI 省下的时间会被你自己填满，要管的是日程不是工具", for_whom: "天天用 AI 写东西的职场人",
  opening: "你是不是也觉得用了 AI 以后反而更忙了？", why_viral: "账号近 90 天播放第一的那条讲的就是「AI 让人更累」",
  chain: ["用了 AI 反而更忙", "省下的时间没消失", "被会议和杂事填满", "所以要把时间先占住"], founder_words: "就第二个", genre: "ganhuo" };

const run = (action: string, args: Record<string, unknown> = {}) => executeDraft({ action, ...args, _dataDir: dir, _host: "claude-code", _session: "s1" });
const ok = (text = GEMINI_BODY) => () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: "思考过程", thought: true }, { text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 40_000, candidatesTokenCount: 1_000, thoughtsTokenCount: 9_000, totalTokenCount: 50_000 },
}), { status: 200 });
const err = (status: number, headers: Record<string, string> = {}) => () => new Response("boom", { status, headers });

/** 立意 + 选开头 + 主会话存第一版；回当前版本号 */
async function hostSaved(): Promise<{ id: string; version: number }> {
  const s = await run("start", { inspiration: "用了 AI 反而更忙，想聊聊为什么" });
  const id = s.content_id as string;
  const v0 = (s.progress as { version: number }).version;
  expect((await run("angle", { content_id: id, base_version: v0, ...ANGLE })).ok).toBe(true);
  await pickOpening(run, id, v0);
  expect((await run("verify_quote", { content_id: id, url: "https://example.com/r", quote: QUOTE })).ok).toBe(true);
  const saved = await run("save", { content_id: id, base_version: v0, body: HOST_BODY, title: "AI 让你更忙" });
  expect(saved.ok).toBe(true);
  return { id, version: saved.version as number };
}

async function rivalDone(id: string, version: number): Promise<string> {
  const r = await run("rival", { content_id: id, base_version: version });
  expect(r).toMatchObject({ ok: true, status: "running" });
  await settleRivalJob(r.rival_id as string);
  return r.rival_id as string;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-rival-"));
  process.env.GEMINI_API_KEY = "test-key-123";
  delete process.env.AUTOCREW_RIVAL_MODEL;
  calls = []; replies = [];
  setQuoteFetch(async (url) => ({ finalUrl: url, title: "调查", text: PAGE }));
  setRivalFetch((async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const next = replies.shift() ?? ok();
    return next();
  }) as typeof fetch);
});
afterEach(async () => {
  setQuoteFetch(undefined); setRivalFetch(undefined); setRivalTimeoutMs(undefined);
  delete process.env.GEMINI_API_KEY;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("比稿 rival", () => {
  it("1 没配 key：回 not_configured 和去哪配，不发请求", async () => {
    delete process.env.GEMINI_API_KEY;
    const { id, version } = await hostSaved();
    const r = await run("rival", { content_id: id, base_version: version });
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    expect(r.error).toContain("设置·封面生成");
    expect(calls).toHaveLength(0);
  });

  it("开头没选不能比稿", async () => {
    const s = await run("start", { inspiration: "用了 AI 反而更忙" });
    const v = (s.progress as { version: number }).version;
    await run("angle", { content_id: s.content_id, base_version: v, ...ANGLE });
    expect(await run("rival", { content_id: s.content_id, base_version: v })).toMatchObject({ ok: false, code: "needs_opening" });
  });

  it("正常：key 只在请求头，回正文、用量和估算费用；思考段不进正文", async () => {
    const { id, version } = await hostSaved();
    const rid = await rivalDone(id, version);
    expect(calls[0].url).toContain("gemini-3.1-pro-preview:generateContent");
    expect(calls[0].url).not.toContain("test-key-123");
    expect(calls[0].headers["x-goog-api-key"]).toBe("test-key-123");
    const r = await run("rival", { content_id: id, rival_id: rid });
    expect(r).toMatchObject({ ok: true, status: "done", body: GEMINI_BODY, pickable: true, cost_usd_estimate: 0.2 });
    expect(r.cost_note).toContain("不是实际账单");
    expect(r.tally).toMatchObject({ total: 0 });
  });

  it("AUTOCREW_RIVAL_MODEL 可换模型", async () => {
    process.env.AUTOCREW_RIVAL_MODEL = "gemini-x";
    const { id, version } = await hostSaved();
    await rivalDone(id, version);
    expect(calls[0].url).toContain("/models/gemini-x:generateContent");
    delete process.env.AUTOCREW_RIVAL_MODEL;
  });

  it("2a 402：failed「Gemini 账户余额不足」", async () => {
    const { id, version } = await hostSaved();
    replies = [err(402)];
    const rid = await rivalDone(id, version);
    expect(await run("rival", { content_id: id, rival_id: rid })).toMatchObject({ status: "failed", reason: "Gemini 账户余额不足", pickable: false });
  });

  it("2b 连续 5xx：按 Retry-After 重试一次后 failed 带原因", async () => {
    const { id, version } = await hostSaved();
    replies = [err(503, { "retry-after": "0" }), err(503, { "retry-after": "0" })];
    const rid = await rivalDone(id, version);
    expect(calls).toHaveLength(2);
    const r = await run("rival", { content_id: id, rival_id: rid });
    expect(r).toMatchObject({ status: "failed" });
    expect(r.reason).toContain("HTTP 503");
  });

  it("2c 429 一次后成功：重试拿到结果", async () => {
    const { id, version } = await hostSaved();
    replies = [err(429, { "retry-after": "0" }), ok()];
    const rid = await rivalDone(id, version);
    expect(await run("rival", { content_id: id, rival_id: rid })).toMatchObject({ status: "done" });
  });

  it("2d 超时：failed 带超时原因", async () => {
    const { id, version } = await hostSaved();
    setRivalTimeoutMs(30);
    setRivalFetch(((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch);
    const rid = await rivalDone(id, version);
    const r = await run("rival", { content_id: id, rival_id: rid });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("超时");
  });

  it("3 重复调：跑着和跑完都回同一个 rival_id，Gemini 只请求一次", async () => {
    const { id, version } = await hostSaved();
    const a = await run("rival", { content_id: id, base_version: version });
    const b = await run("rival", { content_id: id, base_version: version });
    expect(b).toMatchObject({ rival_id: a.rival_id, reused: true });
    await settleRivalJob(a.rival_id as string);
    expect(await run("rival", { content_id: id, base_version: version })).toMatchObject({ rival_id: a.rival_id, reused: true, status: "done" });
    expect(calls).toHaveLength(1);
  });

  it("3b 同时调两次：第二次不会把刚建的记录读成 interrupted 再请求一次", async () => {
    const { id, version } = await hostSaved();
    const [a, b] = await Promise.all([run("rival", { content_id: id, base_version: version }), run("rival", { content_id: id, base_version: version })]);
    expect(a.ok && b.ok).toBe(true);
    expect(b.rival_id).toBe(a.rival_id);
    await settleRivalJob(a.rival_id as string);
    expect(calls).toHaveLength(1);
  });

  it("4 改了开头：旧 Gemini 稿 stale，选它被拒", async () => {
    const { id, version } = await hostSaved();
    const rid = await rivalDone(id, version);
    const c = (await getContent(id, dir))!;
    const angle = c.draftPath!.angle!;
    await updateContent(id, { draftPath: { ...c.draftPath!, angle: { ...angle, opening_pick: { ...angle.opening_pick!, chosen: OPENINGS[0] } } } }, dir);
    expect(await run("rival", { content_id: id, rival_id: rid })).toMatchObject({ status: "stale", pickable: false });
    const pick = await run("save", { content_id: id, base_version: version, body: GEMINI_BODY, rival_pick: { rival_id: rid, picked: "rival", founder_words: "B" } });
    expect(pick).toMatchObject({ ok: false, code: "rival_stale" });
  });

  it("5 选 Gemini 版但正文改过：rival_body_mismatch", async () => {
    const { id, version } = await hostSaved();
    const rid = await rivalDone(id, version);
    const r = await run("save", { content_id: id, base_version: version, body: `${GEMINI_BODY}我改了一句。`, rival_pick: { rival_id: rid, picked: "rival", founder_words: "B" } });
    expect(r).toMatchObject({ ok: false, code: "rival_body_mismatch" });
  });

  it("6 同一比稿选第二次：拒", async () => {
    const { id, version } = await hostSaved();
    const rid = await rivalDone(id, version);
    const first = await run("save", { content_id: id, base_version: version, body: HOST_BODY, rival_pick: JSON.stringify({ rival_id: rid, picked: "host", founder_words: "A 好" }) });
    expect(first).toMatchObject({ ok: true, rival_picked: "host", tally: { total: 1, host_wins: 1 } });
    const again = await run("save", { content_id: id, base_version: first.version, body: GEMINI_BODY, rival_pick: { rival_id: rid, picked: "rival", founder_words: "还是 B" } });
    expect(again).toMatchObject({ ok: false, code: "rival_already_picked" });
  });

  it("7 服务重启：running 读成 interrupted，能重新发起", async () => {
    const { id, version } = await hostSaved();
    const c = (await getContent(id, dir))!;
    const ghost = { id: "rival-ghost", status: "running" as const, brief_hash: "x", angle_key: "y", model: "gemini-3.1-pro-preview", started_at: new Date().toISOString() };
    await updateContent(id, { draftPath: { ...c.draftPath!, rivals: [ghost] } }, dir);
    expect(await run("rival", { content_id: id, rival_id: "rival-ghost" })).toMatchObject({ status: "interrupted", pickable: false });
    const again = await run("rival", { content_id: id, base_version: version });
    expect(again).toMatchObject({ ok: true, reused: false, status: "running" });
    expect(again.rival_id).not.toBe("rival-ghost");
    await settleRivalJob(again.rival_id as string);
  });

  it("8 选中 Gemini 版：记 Gemini 和模型名；试读挂在这一版；创始人之后手改照常进改稿对照", async () => {
    const { id, version } = await hostSaved();
    const rid = await rivalDone(id, version);
    const r = await run("save", { content_id: id, base_version: version, body: GEMINI_BODY, rival_pick: { rival_id: rid, picked: "rival", founder_words: "B 更顺" }, test_read: { status: "ok", notes: "看完了" } });
    expect(r).toMatchObject({ ok: true, rival_picked: "rival", tally: { total: 1, rival_wins: 1 } });
    const c = (await getContent(id, dir))!;
    expect(c.writtenBy).toEqual({ kind: "engine", provider: "gemini", model: "gemini-3.1-pro-preview" });
    expect(c.versions!.at(-1)!.note).toContain("Gemini");
    const rec = c.draftPath!.rivals![0];
    expect(rec.pick).toMatchObject({ picked: "rival", founder_words: "B 更顺", version: r.version, test_reads: { rival: "ok" } });
    expect(c.draftPath!.testReads!.at(-1)).toMatchObject({ version: r.version, status: "ok" });
    const edited = `${GEMINI_BODY}\n创始人亲手加的一句。`;
    expect((await buildIpcHandlers()["content:update"]({ id, body: edited, _dataDir: dir }, { authMethod: "session" })).ok).toBe(true);
    expect((await buildIpcHandlers()["style:record_edit"]({ content_id: id, before: GEMINI_BODY, after: edited, _dataDir: dir }, { authMethod: "session" })).ok).toBe(true);
    const pairs = (await contrastContext(dir)).pairs as Array<{ after: string }>;
    expect(pairs.some((p) => p.after.includes("创始人亲手加的一句"))).toBe(true);
  });

  it("merged：记主会话名下，版本备注「拼自两版」", async () => {
    const { id, version } = await hostSaved();
    const rid = await rivalDone(id, version);
    const merged = `${HOST_BODY}拼进来 Gemini 那句：时间不是被偷走的，是你自己让出去的。`;
    expect(await run("save", { content_id: id, base_version: version, body: merged, rival_pick: { rival_id: rid, picked: "merged", founder_words: "拼一下" } })).toMatchObject({ ok: true, rival_picked: "merged" });
    const c = (await getContent(id, dir))!;
    expect(c.writtenBy).toEqual({ kind: "host", host: "claude-code" });
    expect(c.versions!.at(-1)!.note).toBe("拼自两版");
  });

  it("rival_pick 解析不了 / 缺字段：bad_param，不当没传", async () => {
    const { id, version } = await hostSaved();
    expect(await run("save", { content_id: id, base_version: version, body: HOST_BODY, rival_pick: "{bad json" })).toMatchObject({ ok: false, code: "bad_param" });
    expect(await run("save", { content_id: id, base_version: version, body: HOST_BODY, rival_pick: { rival_id: "x", picked: "claude", founder_words: "A" } })).toMatchObject({ ok: false, code: "bad_param" });
  });

  it("10 战绩和各稿记录一致；满 5 篇提示定去留", async () => {
    const picks = ["host", "rival", "merged", "rival", "host"] as const;
    let last: Record<string, unknown> = {};
    for (const picked of picks) {
      const { id, version } = await hostSaved();
      const rid = await rivalDone(id, version);
      const body = picked === "rival" ? GEMINI_BODY : picked === "merged" ? `${HOST_BODY}拼一句。` : HOST_BODY;
      last = await run("save", { content_id: id, base_version: version, body, rival_pick: { rival_id: rid, picked, founder_words: "选" } });
      expect(last.ok).toBe(true);
    }
    expect(last.tally).toMatchObject({ total: 5, rival_wins: 2, host_wins: 2, merged: 1 });
    expect((last.tally as { hint?: string }).hint).toContain("定去留");
  });

  it("11 简报只有锁住的依据：有开头、立意、已核验引文，没有主会话的稿", async () => {
    const { id, version } = await hostSaved();
    await rivalDone(id, version);
    const sent = JSON.parse(calls[0].body) as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ parts: Array<{ text: string }> }> };
    const brief = sent.contents[0].parts[0].text;
    expect(brief).toContain(OPENINGS[1]);
    expect(brief).toContain(ANGLE.main_line);
    expect(brief).toContain(QUOTE);
    expect(brief).not.toContain("主会话独有的一句");
    expect(sent.systemInstruction.parts[0].text).toContain("Chinese body text");
  });
});

describe("9 write-script 技能：A/B 盲选不带作者不给推荐", () => {
  it("技能第 5 步有比稿一节，写明不说谁写的、不给推荐、没配 key 只说一次", async () => {
    const skill = await fs.readFile(path.join(__dirname, "../../skills/write-script/SKILL.md"), "utf-8");
    const sec = skill.slice(skill.indexOf("### 比稿（试行）"));
    expect(sec.length).toBeGreaterThan(20);
    expect(sec).toMatch(/不说.*谁写/);
    expect(sec).toContain("不给推荐");
    expect(sec).toContain("not_configured");
  });
});
