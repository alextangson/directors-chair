// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DerivativeDispatchPanel, SettingsDerivativeDispatch } from "./DerivativeDispatch";
import type { DispatchJobView, DispatchThreadView } from "./derivative-dispatch-api";

const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
const threadId = "019c6e27-e55b-73d1-87d8-4e01f1f75043";
let enabled = false, failure: string | null = null, jobs: DispatchJobView[] = [];
let history: DispatchThreadView;
const json = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
vi.mock("../transport", () => ({
  SESSION_EXPIRED: "登录过期",
  authedFetch: async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, ...(body ? { body } : {}) });
    if (failure) return new Response(JSON.stringify({ ok: false, error: failure }), { status: 500 });
    const at = new URL(url, "http://x");
    if (at.pathname.endsWith("/policy")) { if (body) enabled = body.enabled === true; return json({ enabled, host: "codex", id: "p", enabledAt: "" }); }
    if (at.pathname.endsWith("/thread")) return json(at.searchParams.has("cursor") ? { ...history, turns: [{ id: "older", status: "completed", items: [{ type: "agentMessage", text: "更早的真实回复" }] }], nextCursor: null } : history);
    if (at.pathname.endsWith("/resume")) return json({ status: "started", session: { threadId } });
    return json({ policy: { enabled, host: "codex", id: "p", enabledAt: "" }, jobs });
  },
}));
let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0; enabled = false; failure = null; jobs = [];
  history = { threadId, status: "idle", turns: [{ id: "turn-1", status: "completed", items: [{ type: "userMessage", text: "源视频对应的真实任务" }, { type: "agentMessage", text: "需要你确认英文稿" }] }], nextCursor: "page+2", needsAttention: "等你认稿" };
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => root.unmount()); el.remove(); });
const button = (t: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t);
const click = async (b: Element | undefined) => { expect(b).toBeTruthy(); await act(async () => (b as HTMLElement).click()); };
const renderPolicy = () => act(async () => root.render(createElement(SettingsDerivativeDispatch)));
const renderPanel = (sourceId = "content-1-a") => act(async () => root.render(createElement(DerivativeDispatchPanel, { sourceId })));
const job = (extra: Partial<DispatchJobView> = {}): DispatchJobView => ({ id: "job-1", kind: "en_edition", state: "started", session: { threadId }, ...extra });

describe("自动派生设置", () => {
  it("默认关闭且不产生写操作；显式打开只写Codex策略", async () => {
    await renderPolicy();
    const toggle = el.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(false);
    expect(calls).toEqual([{ url: "/api/derivative-dispatch/policy" }]);
    await click(toggle);
    expect(calls.at(-1)).toEqual({ url: "/api/derivative-dispatch/policy", body: { enabled: true, host: "codex" } });
    expect(toggle.checked).toBe(true);
    expect(el.textContent).toContain("已创建会话保留");
  });
  it("设置读不出来时明确报错，不把未知状态当作关闭", async () => {
    failure = "策略文件损坏"; await renderPolicy();
    expect(el.textContent).toContain("策略文件损坏");
    expect(el.querySelector<HTMLInputElement>('input[role="switch"]')!.disabled).toBe(true);
    expect(calls.every((c) => !c.body)).toBe(true);
  });
});

describe("原主题展开区的派生会话", () => {
  it("按实际源ID读取，同一主题重渲染不会跟全量列表一起重复请求", async () => {
    await renderPanel("content-11-source"); await renderPanel("content-11-source");
    expect(calls).toEqual([{ url: "/api/derivative-dispatch?content_id=content-11-source" }]);
    await renderPanel("content-22-source");
    expect(calls.at(-1)?.url).toBe("/api/derivative-dispatch?content_id=content-22-source");
    expect(calls.every((c) => !c.body)).toBe(true);
  });
  it("unknown没有真实thread时不给查看或重开，保留核对原因", async () => {
    enabled = true; jobs = [job({ state: "unknown", session: undefined, reason: "创建结果未知，先查宿主" })];
    await renderPanel();
    expect(el.textContent).toContain("创建结果未知，先查宿主");
    expect(button("查看/继续会话")).toBeUndefined();
    expect(button("检查并补齐当前主题")).toBeUndefined();
    expect(calls.every((c) => !c.body)).toBe(true);
  });
  it("关闭自动派生仍可查看和继续已有同一会话，展示真实历史和cursor", async () => {
    jobs = [job()]; await renderPanel();
    expect(el.textContent).toContain("自动派生关闭，待办暂停，已创建会话保留");
    await click(button("查看/继续会话"));
    expect(calls.at(-1)?.url).toBe("/api/derivative-dispatch/thread?content_id=content-1-a&job_id=job-1");
    expect(el.textContent).toContain("源视频对应的真实任务"); expect(el.textContent).toContain("需要你确认英文稿");
    expect(el.textContent).toContain("会话历史的分页预览");
    expect(el.querySelector('a[href="codex://threads/' + threadId + '"]')?.textContent).toBe("尝试在 Codex 打开");
    await click(button("更多历史记录"));
    expect(calls.at(-1)?.url).toContain("cursor=page%2B2");
    expect(el.textContent).toContain("更早的真实回复"); expect(el.textContent).toContain("需要你确认英文稿");
    await click(button("继续当前会话"));
    expect(calls.find((c) => c.url.endsWith("/resume"))).toEqual({ url: "/api/derivative-dispatch/resume", body: { content_id: "content-1-a", job_id: "job-1" } });
    expect(el.textContent).toContain("续办已交给当前会话");
    expect(calls.some((c) => c.url.endsWith("/prepare"))).toBe(false);
  });
  it("历史身份不匹配时不提供继续和原生打开入口", async () => {
    jobs = [job()]; history = { ...history, threadId: "different-thread" }; await renderPanel();
    await click(button("查看/继续会话"));
    expect(el.textContent).toContain("会话身份和记录不一致");
    expect(button("继续当前会话")).toBeUndefined();
    expect(el.querySelector('a[href^="codex:"]')).toBeNull();
  });
  it("手动补齐是显式源ID写操作，读回失败时保留错误", async () => {
    enabled = true; await renderPanel();
    expect(calls.some((c) => c.body)).toBe(false);
    await click(button("检查并补齐当前主题"));
    expect(calls.at(-1)).toEqual({ url: "/api/derivative-dispatch/prepare", body: { content_id: "content-1-a" } });
    failure = "outbox损坏"; await click(button("刷新状态"));
    expect(el.textContent).toContain("outbox损坏");
    expect(el.textContent).not.toContain("已完成");
  });
});
