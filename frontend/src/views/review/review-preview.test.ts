// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { InboxItem } from "./review-model";
import { ReviewPanel } from "./ReviewPanel";

let response: Record<string, unknown>;
const invoke = vi.fn(async (..._args: unknown[]) => response);
vi.mock("../../transport", () => ({ invoke: (...a: unknown[]) => invoke(...a), authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));
const body = "第一段。\n\n第二段完整正文。";
const hash = createHash("sha256").update(body).digest("hex");
const updatedAt = "2026-10-28T00:00:00.000Z";
const draft = (extra: Partial<InboxItem> = {}): InboxItem => ({ item_id: "draft:c", gen: "g1", type: "draft", content_id: "content-1-a", title: "中文稿", summary: "稿子写好了，过一眼", waiting: null, agent_waiting: false, since: updatedAt, rank: 3,
  detail: { body_hash: hash, updated_at: updatedAt }, actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }, { action: "revise_script", label: "还要改…", role: "secondary", note: "required" }], ...extra });
let el: HTMLDivElement, root: Root;
const acts: Array<[unknown, unknown]> = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("crypto", webcrypto);
  response = { ok: true, content: { title: "中文稿", body, updatedAt } }; invoke.mockClear(); acts.length = 0;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); vi.unstubAllGlobals(); });
const button = (s: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === s);
const render = async (item = draft()) => { await act(async () => root.render(createElement(ReviewPanel, { item, gone: false, onClose: () => {}, act: async (a, extra) => { acts.push([a, extra]); } }))); };
const settle = () => act(async () => new Promise((r) => setTimeout(r, 10)));

describe("普通稿认稿", () => {
  it("显示完整正文和打开稿件入口，批准带看到正文的哈希", async () => {
    await render(); await settle();
    expect(el.querySelector(".ri-body")?.textContent).toBe(body);
    expect(el.querySelector('a[href="#/editor/content-1-a"]')).toBeTruthy();
    await act(async () => button("稿子没问题")!.click());
    expect(acts[0]).toEqual([expect.objectContaining({ action: "approve_script" }), { expected_body_hash: hash }]);
  });
  it.each([
    { ok: false, error: "读盘失败" },
    { ok: true, content: { title: "中文稿", body: "改过的正文", updatedAt } },
    { ok: true, content: { title: "新标题", body, updatedAt } },
    { ok: true, content: { title: "中文稿", body, updatedAt: "2026-10-29T00:00:00.000Z" } },
  ])("读取失败或正文、标题、存盘版本漂移时不能盲批", async (r) => {
    response = r; await render(); await settle();
    expect(button("稿子没问题")).toBeUndefined();
    expect(button("还要改…")).toBeTruthy();
    expect(el.textContent).toMatch(/读不出来|稿子刚改过/);
    expect(acts).toEqual([]);
  });
  it("缺少认稿版本元数据时显示正文，但不能批准", async () => {
    await render(draft({ detail: {} })); await settle();
    expect(el.querySelector(".ri-body")?.textContent).toBe(body);
    expect(button("稿子没问题")).toBeUndefined();
    expect(el.textContent).toContain("缺少版本信息");
  });
});

describe("英文发布包预览", () => {
  const pkg = (): InboxItem => draft({ type: "en_package", item_id: "enpkg:c", detail: { package_hash: "package-v1", problems: [], preview: { hash: "package-v1", thumbnail: { fact_id: `en-thumbnail-${"a".repeat(64)}` }, cut: { fact_id: `en-cut-${"b".repeat(64)}` }, kits: [{ platform: "youtube", title: "English title", caption: "Full description", tags: ["AI"], chapters: [{ at: "0:10", title: "The test" }], aiDisclosure: "yes" }] } }, actions: [{ action: "approve_en_package", label: "英文发布包没问题", role: "primary" }, { action: "revise_en_package", label: "还要改…", role: "secondary", note: "required" }] });
  const readyMedia = async () => { await act(async () => { el.querySelector("img")!.dispatchEvent(new Event("load")); el.querySelector("video")!.dispatchEvent(new Event("loadedmetadata")); }); };
  it("显示缩略图、成片、平台文案和章节，媒体读到后才允许批准", async () => {
    await render(pkg());
    for (const s of ["English title", "Full description", "0:10", "The test", "Yes"]) expect(el.textContent).toContain(s);
    expect(el.querySelector("img")?.getAttribute("src")).toContain("/api/inbox/media?");
    expect(button("英文发布包没问题")).toBeUndefined();
    await readyMedia();
    await act(async () => button("英文发布包没问题")!.click());
    expect(acts[0][0]).toMatchObject({ action: "approve_en_package" });
  });
  it("文件变化或预览包哈希不一致时不批准", async () => {
    await render(pkg()); await readyMedia();
    await act(async () => el.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(button("英文发布包没问题")).toBeUndefined();
    expect(el.textContent).toContain("缩略图读不出来或文件已变化");
    const other = pkg(); other.gen = "g2"; other.detail.package_hash = "package-v2";
    await render(other);
    expect(button("英文发布包没问题")).toBeUndefined();
    expect(el.textContent).toContain("版本信息不完整");
  });
  it("缺少 AI 声明时显示未填写，不替稿件猜一个答案", async () => {
    const item = pkg();
    (item.detail.preview as { kits: Array<{ aiDisclosure: string | null }> }).kits[0].aiDisclosure = null;
    await render(item);
    expect(el.textContent).toContain("AI 使用声明：未填写");
  });
});
