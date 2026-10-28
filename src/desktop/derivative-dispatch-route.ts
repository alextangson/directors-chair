/** 派生会话的浏览器端点。创建与续办只接受本地创始人会话，不接收任意 thread ID 或指令。 */
import type http from "node:http";
import { isContentId } from "../storage/entity-id.js";
import type { DispatchPolicy } from "../modules/derivative-dispatch/types.js";

export interface DerivativeDispatchRouteDeps {
  authorize(req: http.IncomingMessage): "session" | "bearer" | null;
  originAllowed(req: http.IncomingMessage): boolean;
  readBody(req: http.IncomingMessage): Promise<string>;
  resolveDataDir(): Promise<string>;
  readPolicy(dataDir: string): Promise<DispatchPolicy>;
  writePolicy(input: { enabled: boolean; host: "codex" }, dataDir: string): Promise<DispatchPolicy>;
  dispatchStatus(sourceId: string, dataDir: string): Promise<unknown>;
  prepareDispatch(sourceId: string, dataDir: string): Promise<unknown>;
  inspectDispatchThread(sourceId: string, jobId: string, dataDir: string, cursor?: string): Promise<unknown>;
  resumeDispatchThread(sourceId: string, jobId: string, dataDir: string): Promise<unknown>;
}

const ROOT = "/api/derivative-dispatch";
const PATHS = new Set([ROOT, `${ROOT}/policy`, `${ROOT}/prepare`, `${ROOT}/thread`, `${ROOT}/resume`]);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const jobId = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,200}$/.test(v);

export function createDerivativeDispatchHandler(deps: DerivativeDispatchRouteDeps) {
  return async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> => {
    const path = url.pathname;
    if (!PATHS.has(path)) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    };
    const read = req.method === "GET" && [ROOT, `${ROOT}/policy`, `${ROOT}/thread`].includes(path);
    const write = req.method === "POST" && [`${ROOT}/policy`, `${ROOT}/prepare`, `${ROOT}/resume`].includes(path);
    if (!read && !write) { send(405, { ok: false, code: "method_not_allowed", error: "method_not_allowed" }); return true; }
    if (deps.authorize(req) !== "session" || (write && !deps.originAllowed(req))) {
      send(403, { ok: false, code: "founder_workbench_required", error: "只能在工作台由创始人操作派生会话" }); return true;
    }
    try {
      let body: Record<string, unknown> = {};
      if (write) {
        if (!(req.headers["content-type"] ?? "").includes("application/json")) { send(415, { ok: false, error: "application/json required" }); return true; }
        const parsed: unknown = JSON.parse(await deps.readBody(req));
        if (!obj(parsed)) { send(400, { ok: false, error: "请求体要是 JSON 对象" }); return true; }
        body = parsed;
      }
      if (path === `${ROOT}/policy`) {
        if (write && (typeof body.enabled !== "boolean" || body.host !== "codex")) {
          send(400, { ok: false, error: "enabled 要是布尔值，host 只能是 codex" }); return true;
        }
        const dir = await deps.resolveDataDir();
        const policy = read ? await deps.readPolicy(dir) : await deps.writePolicy({ enabled: body.enabled as boolean, host: "codex" }, dir);
        send(200, { ok: true, data: policy }); return true;
      }
      const source = read ? url.searchParams.get("content_id") : body.content_id;
      if (typeof source !== "string" || !isContentId(source)) { send(400, { ok: false, error: "content_id 不对" }); return true; }
      const job = read ? url.searchParams.get("job_id") : body.job_id;
      if ([`${ROOT}/thread`, `${ROOT}/resume`].includes(path) && !jobId(job)) { send(400, { ok: false, error: "job_id 不对" }); return true; }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (cursor && (cursor.length > 8192 || [...cursor].some((c) => c.charCodeAt(0) < 32))) { send(400, { ok: false, error: "cursor 不对" }); return true; }
      const dir = await deps.resolveDataDir();
      const result = path === ROOT ? await deps.dispatchStatus(source, dir)
        : path === `${ROOT}/prepare` ? await deps.prepareDispatch(source, dir)
        : path === `${ROOT}/thread` ? await deps.inspectDispatchThread(source, job as string, dir, cursor)
        : await deps.resumeDispatchThread(source, job as string, dir);
      if (!obj(result) || typeof result.ok !== "boolean") throw new Error("派生会话服务返回了不完整的结果");
      if (!result.ok) { send(409, result); return true; }
      const { ok: _ok, ...data } = result;
      void _ok;
      send(200, { ok: true, data });
    } catch (e) {
      const invalid = e instanceof SyntaxError;
      send(invalid ? 400 : 500, { ok: false, code: invalid ? "bad_json" : "dispatch_unavailable", error: e instanceof Error ? e.message : String(e) });
    }
    return true;
  };
}
