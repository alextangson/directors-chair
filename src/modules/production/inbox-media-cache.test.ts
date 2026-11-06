/** 整分支审 8 P2：拖进度（Range）不再每次整份重算 sha；文件身份变了才重算，字节不对照样 409 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { setEnThumbnail } from "../en-edition/thumbnail.js";

const hashed: string[] = [];
vi.mock("../video/handoff/manifest.js", async (orig) => {
  const m = await orig<typeof import("../video/handoff/manifest.js")>();
  return { ...m, sha256File: async (f: string) => { hashed.push(f); return m.sha256File(f); } };
});

const { openAttachment, openFactMedia } = await import("./inbox-attachment.js");
const { founderApprove, makeEnv, png, projectRoot, put, record, videoContent } = await import("./testkit.js");
const { executeContentSave } = await import("../../tools/content-save.js");
type Env = Awaited<ReturnType<typeof makeEnv>>;

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

describe("预览 / 附件的字节核对按文件身份缓存", () => {
  it("成片预览：同一文件两次只算一次；文件换了再算，字节不对回 409", async () => {
    const c = await videoContent(env, "缓存测试稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "缓存测试稿-原片.mov"), "raw"), request_id: "a" });
    const cut = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "缓存测试稿.mp4"), "cut-bytes"), request_id: "c" });
    const file = path.join(projectRoot(env, c.id), String(cut.path));
    const count = () => hashed.filter((h) => h.endsWith(path.basename(file))).length;
    expect((await openFactMedia(c.id, String(cut.fact_id), env.dir)).ok).toBe(true);
    const sha = (await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.id === cut.fact_id)!.sha256;
    expect((await openFactMedia(c.id, `en-cut-${sha}`, env.dir)).ok).toBe(true);
    expect(await openFactMedia(c.id, `en-cut-${"0".repeat(64)}`, env.dir)).toMatchObject({ ok: false, status: 404 });
    const n1 = count();
    expect((await openFactMedia(c.id, String(cut.fact_id), env.dir)).ok).toBe(true);
    expect(count()).toBe(n1);
    await put(file, "different-and-longer-bytes");
    expect(await openFactMedia(c.id, String(cut.fact_id), env.dir)).toMatchObject({ ok: false, status: 409 });
    expect(count()).toBe(n1 + 1);
  });

  it("英文缩略图按当前登记 SHA 预览：支持合法库外路径，未知、换登记和变字节都拒绝", async () => {
    const c = await videoContent(env, "英文缩略图预览");
    const file = await put(path.join(env.outside, "thumbnail.png"), png(1280, 720, "old"));
    const registered = await setEnThumbnail(c.id, file, env.dir);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const alias = `en-thumbnail-${registered.thumbnail.sha256}`;
    expect(await openFactMedia(c.id, alias, env.dir)).toMatchObject({ ok: true, file, type: "image/png" });
    expect(await openFactMedia(c.id, `en-thumbnail-${"0".repeat(64)}`, env.dir)).toMatchObject({ ok: false, status: 404 });
    await put(file, png(1280, 720, "new-and-longer"));
    expect(await openFactMedia(c.id, alias, env.dir)).toMatchObject({ ok: false, status: 409 });
    expect((await setEnThumbnail(c.id, file, env.dir)).ok).toBe(true);
    expect(await openFactMedia(c.id, alias, env.dir)).toMatchObject({ ok: false, status: 404 });
  });

  it("请示附件同样只算一次", async () => {
    const c = await videoContent(env, "附件缓存稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "附件缓存稿-原片.mov"), "raw"), request_id: "a" });
    const vid = await put(path.join(projectRoot(env, c.id), "04-edit/样片.mp4"), "sample");
    const q = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "ask", content_id: c.id, request_id: "q", kind: "样片", question: "看看", options: [{ id: "ok", label: "可以" }, { id: "no", label: "不行" }], attachments: [vid] }) as Record<string, unknown>;
    const before = hashed.filter((h) => h.endsWith("样片.mp4")).length;
    await openAttachment(c.id, String(q.ask_id), 0, env.dir);
    await openAttachment(c.id, String(q.ask_id), 0, env.dir);
    expect(hashed.filter((h) => h.endsWith("样片.mp4")).length - before).toBeLessThanOrEqual(1);
  });
});
