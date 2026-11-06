// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "./review-model";
import { ReviewInbox, POLL_MS } from "./ReviewInbox";

let items: InboxItem[] = [], reads = 0;
let holdRead = 0, release: ((v: unknown) => void) | null = null;
const reply = (xs: InboxItem[]) => ({ ok: true, data: { items: xs, count: xs.length, agent_waiting: 0, generated_at: "" } });
vi.mock("./review-api", () => ({
  loadInbox: async () => { if (++reads === holdRead) return new Promise((r) => { release = r; }); return reply(items); },
  decideItem: async () => { items = []; return { ok: true, data: {} }; }, undoDecision: async () => ({ ok: true, data: {} }),
  mediaUrl: () => "/media", attachmentUrl: () => "/attachment", INBOX_OPEN_EVENT: "autocrew:inbox-open", inboxHref: () => "#",
}));
vi.mock("../../transport", () => ({ invoke: async () => ({ ok: true }), authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "expired" }));
const item = (id: string): InboxItem => ({ item_id: `cut:${id}`, gen: "g1", type: "cut_review", content_id: id, title: `稿件${id}`, summary: `看成片${id}`, waiting: null, agent_waiting: false, since: "2026-10-28T00:00:00Z", rank: 1,
  detail: { review_fact_id: "f1", versions: [{ fact_id: "f1", sha256: "s1", at: "2026-10-28T00:00:00Z", label: "当前成片" }] }, actions: [{ action: "approve_cut", label: "就用这版", role: "primary", params: { fact_id: "f1", sha256: "s1" } }] });
let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  items = []; reads = 0; holdRead = 0; release = null; vi.useFakeTimers();
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.useRealTimers(); });
const render = async (focusContent?: string) => { await act(async () => root.render(createElement(ReviewInbox, { focusContent }))); };
const poll = async () => { await act(async () => vi.advanceTimersByTime(POLL_MS)); };

describe("审核列表响应顺序与深链", () => {
  it("决定前的慢轮询不能让已处理条目复活", async () => {
    const old = item("A"); items = [old]; await render("A");
    holdRead = 2; await poll(); expect(release).toBeTruthy();
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "就用这版")!.click());
    expect(el.querySelectorAll(".ri-row")).toHaveLength(0);
    await act(async () => release!(reply([old])));
    expect(el.querySelectorAll(".ri-row")).toHaveLength(0);
  });
  it("较早的失败响应不能覆盖后来的成功读取", async () => {
    items = [item("A")]; await render(); holdRead = 2; await poll();
    await poll();
    await act(async () => release!({ ok: false, error: "旧请求失败" }));
    expect(el.querySelector(".ri-warn")).toBeNull();
    expect(el.querySelectorAll(".ri-row")).toHaveLength(1);
  });
  it("相同页面深链从 A 切到 B，打开 B；暂时没读到 B 时继续等待", async () => {
    items = [item("A")]; await render("A");
    expect(el.querySelector(".ri-peek")?.textContent).toContain("稿件A");
    await render("B"); expect(el.querySelector(".ri-peek")).toBeNull();
    items = [item("A"), item("B")]; await poll();
    expect(el.querySelector(".ri-peek")?.textContent).toContain("稿件B");
    await render("A"); expect(el.querySelector(".ri-peek")?.textContent).toContain("稿件A");
  });
});
