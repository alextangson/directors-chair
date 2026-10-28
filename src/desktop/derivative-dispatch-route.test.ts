import { beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { createDerivativeDispatchHandler, type DerivativeDispatchRouteDeps } from "./derivative-dispatch-route.js";

const id = "content-123-abc";
const policy = { version: 1 as const, id: "policy-1", enabled: false, host: "codex" as const, enabledAt: "" };
let auth: "session" | "bearer" | null, origin: boolean;
const deps = {
  authorize: () => auth, originAllowed: () => origin, resolveDataDir: async () => "/fixture", readBody: async () => "{}",
  readPolicy: vi.fn(async () => policy), writePolicy: vi.fn(async (input: { enabled: boolean; host: "codex" }) => ({ ...policy, ...input })),
  dispatchStatus: vi.fn(async () => ({ ok: true, policy, jobs: [] })), prepareDispatch: vi.fn(async () => ({ ok: true, policy, jobs: [] })),
  inspectDispatchThread: vi.fn(async () => ({ ok: true, threadId: "real-thread", status: "idle", turns: [], nextCursor: "older" })),
  resumeDispatchThread: vi.fn(async () => ({ ok: true, status: "unknown", code: "host_unavailable", error: "等待核对", threadId: "real-thread" })),
} satisfies DerivativeDispatchRouteDeps;
beforeEach(() => { auth = "session"; origin = true; vi.clearAllMocks(); });
async function call(path: string, method = "GET", body: unknown = {}, contentType = "application/json") {
  const handler = createDerivativeDispatchHandler({ ...deps, readBody: async () => JSON.stringify(body) });
  let status = 0, text = "";
  const res = { writeHead(s: number) { status = s; return res; }, end(s?: string) { text = s ?? ""; return res; } };
  const handled = await handler({ method, headers: { "content-type": contentType } } as http.IncomingMessage, res as unknown as http.ServerResponse, new URL(`http://x${path}`));
  return { handled, status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
describe("派生会话浏览器路由", () => {
  it("策略默认读回关闭，写入只传固定宿主与显式布尔值", async () => {
    expect(await call("/api/derivative-dispatch/policy")).toMatchObject({ status: 200, body: { ok: true, data: policy } });
    expect(await call("/api/derivative-dispatch/policy", "POST", { enabled: true, host: "codex" })).toMatchObject({ status: 200, body: { data: { enabled: true, host: "codex" } } });
    expect(deps.writePolicy).toHaveBeenCalledWith({ enabled: true, host: "codex" }, "/fixture");
    expect((await call("/api/derivative-dispatch/policy", "POST", { enabled: "true", host: "claude" })).status).toBe(400);
  });
  it("GET按源稿读取，显式prepare只补当前源稿", async () => {
    expect((await call(`/api/derivative-dispatch?content_id=${id}`)).body).toEqual({ ok: true, data: { policy, jobs: [] } });
    expect(deps.dispatchStatus).toHaveBeenCalledWith(id, "/fixture");
    expect((await call("/api/derivative-dispatch/prepare", "POST", { content_id: id })).status).toBe(200);
    expect(deps.prepareDispatch).toHaveBeenCalledWith(id, "/fixture");
    expect((await call("/api/derivative-dispatch/prepare", "POST", { content_id: "../other" })).status).toBe(400);
    expect(deps.prepareDispatch).toHaveBeenCalledTimes(1);
  });
  it("真实历史透传cursor，续办仅接受源稿+job，不接受客户端thread和指令", async () => {
    const r = await call(`/api/derivative-dispatch/thread?content_id=${id}&job_id=job-1&cursor=page%2B2`);
    expect(r).toMatchObject({ status: 200, body: { data: { threadId: "real-thread", nextCursor: "older" } } });
    expect(deps.inspectDispatchThread).toHaveBeenCalledWith(id, "job-1", "/fixture", "page+2");
    expect(await call("/api/derivative-dispatch/resume", "POST", { content_id: id, job_id: "job-1", thread_id: "fake", prompt: "fake" })).toMatchObject({ status: 200, body: { data: { status: "unknown", error: "等待核对" } } });
    expect(deps.resumeDispatchThread).toHaveBeenCalledWith(id, "job-1", "/fixture");
  });
  it("读写均拒bearer，写入额外核同源和JSON，不调用service", async () => {
    auth = "bearer";
    expect((await call(`/api/derivative-dispatch?content_id=${id}`)).status).toBe(403);
    expect((await call("/api/derivative-dispatch/policy", "POST", { enabled: true, host: "codex" })).status).toBe(403);
    auth = "session"; origin = false;
    expect((await call("/api/derivative-dispatch/resume", "POST", { content_id: id, job_id: "job-1" })).status).toBe(403);
    origin = true;
    expect((await call("/api/derivative-dispatch/prepare", "POST", { content_id: id }, "text/plain")).status).toBe(415);
    expect((await call("/api/derivative-dispatch/policy", "POST", null)).status).toBe(400);
    expect(deps.writePolicy).not.toHaveBeenCalled(); expect(deps.resumeDispatchThread).not.toHaveBeenCalled(); expect(deps.prepareDispatch).not.toHaveBeenCalled();
  });
  it("服务读坏时显示错误，无法关联的job保持失败而不是回成空状态", async () => {
    deps.dispatchStatus.mockRejectedValueOnce(new Error("outbox损坏"));
    expect(await call(`/api/derivative-dispatch?content_id=${id}`)).toMatchObject({ status: 500, body: { ok: false, error: "outbox损坏" } });
    deps.resumeDispatchThread.mockResolvedValueOnce({ ok: false, code: "not_found", error: "没有这个任务" } as never);
    expect(await call("/api/derivative-dispatch/resume", "POST", { content_id: id, job_id: "job-other" })).toMatchObject({ status: 409, body: { ok: false, code: "not_found" } });
  });
});
