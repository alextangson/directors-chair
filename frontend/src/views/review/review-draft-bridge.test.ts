// @vitest-environment happy-dom
/** 使用真实 review-api，让响应按实际 URL 参数决定是否含稿，防止 mock 绕过读桥。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "./review-model";
import { ReviewInbox } from "./ReviewInbox";
import { openInboxItem } from "./review-api";

const urls: string[] = [];
let drafts: InboxItem[] = [], holdDefault = false, releaseDefault: ((r: Response) => void) | null = null;
const body = "完整中文正文。";
const updatedAt = "2026-10-28T00:00:00.000Z";
const view = (items: InboxItem[]) => new Response(JSON.stringify({ ok: true, items, count: items.length, agent_waiting: 0, generated_at: updatedAt }), { status: 200 });
vi.mock("../../transport", () => ({
  SESSION_EXPIRED: "expired",
  invoke: async () => ({ ok: true, content: { title: "中文稿", body, updatedAt } }),
  authedFetch: async (url: string) => {
    urls.push(url);
    const u = new URL(url, "http://localhost");
    if (u.pathname === "/api/inbox") {
      if (holdDefault && !u.searchParams.has("with_drafts")) return new Promise<Response>((r) => { releaseDefault = r; });
      return view(u.searchParams.get("with_drafts") === "1" ? drafts : []);
    }
    if (u.pathname === "/api/inbox/derived") return new Response(JSON.stringify({ ok: true, kind: "en_edition", title: "英文稿", hash: "package", approval: "还没批", problems: [], segments: [{ index: 1, startMs: 0, endMs: 1000, zh: "中文原句", en: "English sentence", keyword: null, changed: null, slotS: 1, estimatedS: 1, words: 2, over: false, swaps: [] }] }));
    throw new Error(`Unexpected request: ${url}`);
  },
}));
const draft = (derived = false): InboxItem => ({ item_id: derived ? "draft:content-2-en" : "draft:content-1-a", gen: "g1", type: "draft", content_id: derived ? "content-2-en" : "content-1-a", title: derived ? "英文稿" : "中文稿", summary: "稿子写好了，过一眼", waiting: null, agent_waiting: false, since: updatedAt, rank: 3,
  detail: derived ? { derived: "en_edition", package_hash: "package" } : { body_hash: createHash("sha256").update(body).digest("hex"), updated_at: updatedAt }, actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }] });
let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("crypto", webcrypto); urls.length = 0; drafts = [draft(), draft(true)]; holdDefault = false; releaseDefault = null;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.unstubAllGlobals(); });
const render = async (focusContent?: string) => { await act(async () => root.render(createElement(ReviewInbox, { variant: "home", focusContent, focusTypes: ["draft"] }))); await act(async () => new Promise((r) => setTimeout(r, 10))); };

describe("显式认稿入口使用真实查询参数", () => {
  it("默认首页不请求 draft；从默认首页切换为普通稿深链时包含 draft 并读到全文", async () => {
    await render();
    expect(urls).toEqual(["/api/inbox"]);
    expect(el.querySelector(".ri-peek")).toBeNull();
    await render("content-1-a");
    expect(urls).toContain("/api/inbox?with_drafts=1");
    expect(el.querySelector(".ri-body")?.textContent).toBe(body);
  });
  it("直接打开派生稿深链时首个请求就包含 draft", async () => {
    await render("content-2-en");
    expect(urls[0]).toBe("/api/inbox?with_drafts=1");
    expect(el.querySelector(".ri-bi")?.textContent).toContain("English sentence");
  });
  it("显式打开事件启用 draft 读取；较晚返回的旧默认请求不能覆盖它", async () => {
    holdDefault = true; await render();
    expect(releaseDefault).toBeTruthy();
    await act(async () => openInboxItem("content-2-en", ["draft"]));
    expect(urls).toContain("/api/inbox?with_drafts=1");
    expect(el.querySelector(".ri-bi")?.textContent).toContain("English sentence");
    await act(async () => releaseDefault!(view([])));
    expect(el.querySelector(".ri-bi")?.textContent).toContain("English sentence");
  });
});
