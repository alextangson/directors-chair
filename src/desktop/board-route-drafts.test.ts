import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { createBoardHandler } from "./board-route.js";
import { makeEnv, videoContent, type Env } from "../modules/production/testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

async function get(query = "", auth: "session" | "bearer" = "session") {
  const handler = createBoardHandler({ authorize: () => auth, originAllowed: () => true, resolveDataDir: async () => env.dir, readBody: async () => "" });
  let status = 0, body = "";
  const res = { writeHead: (s: number) => { status = s; return res; }, end: (s?: string) => { body = s ?? ""; return res; } };
  await handler({ method: "GET" } as http.IncomingMessage, res as unknown as http.ServerResponse, new URL(`http://x/api/inbox${query}`));
  return { status, body: body ? JSON.parse(body) as { items: Array<{ type: string; content_id: string; detail: Record<string, unknown> }> } : null };
}

describe("显式认稿的列表读取桥", () => {
  it("真实草稿默认仍隐藏，只有 with_drafts=1 才返回普通和派生认稿身份", async () => {
    const source = await videoContent(env, "普通中文稿");
    const en = await videoContent(env, "派生英文稿", "draft_ready", "English draft", { platform: "youtube", derivedFrom: { contentId: source.id, kind: "en_edition", sourceCutHash: "test-cut", at: new Date().toISOString() } });
    const normal = await get();
    expect(normal.status).toBe(200);
    expect(normal.body!.items.filter((i) => i.type === "draft")).toEqual([]);
    expect((await get("?with_drafts=true")).body!.items.filter((i) => i.type === "draft")).toEqual([]);
    const explicit = await get("?with_drafts=1");
    expect(explicit.status).toBe(200);
    expect(explicit.body!.items.filter((i) => i.type === "draft").map((i) => i.content_id).sort()).toEqual([source.id, en.id].sort());
    expect(explicit.body!.items.find((i) => i.content_id === source.id && i.type === "draft")!.detail.body_hash).toEqual(expect.any(String));
    expect(explicit.body!.items.find((i) => i.content_id === en.id && i.type === "draft")!.detail.derived).toBe("en_edition");
    expect((await get()).body!.items.filter((i) => i.type === "draft")).toEqual([]);
  });
  it("包含认稿的读取仍只给浏览器会话", async () => {
    expect((await get("?with_drafts=1", "bearer")).status).toBe(403);
  });
});
