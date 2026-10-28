/** Service-owned JSONL transport. Never logs raw protocol or stderr payloads. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type RpcObject = Record<string, unknown>;
export interface RpcNotification { method: string; params: RpcObject }
export interface RpcServerRequest extends RpcNotification { id: number | string }
export interface CodexRpc {
  readonly closed: boolean;
  request(method: string, params?: RpcObject): Promise<RpcObject>;
  notify(method: string, params?: RpcObject): void;
  reply(id: number | string, result: RpcObject): void;
  reject(id: number | string, code: number, message: string): void;
  onNotification(listener: (message: RpcNotification) => void): () => void;
  onServerRequest(listener: (message: RpcServerRequest) => void): () => void;
  onClose(listener: (error: CodexClientError) => void): () => void;
  close(): Promise<void>;
}

export class CodexClientError extends Error {
  constructor(readonly code: string, message: string, readonly rpcCode?: number) { super(message); }
}

export interface CodexClientOptions {
  command: string;
  /** Tests may substitute a fake executable. Production uses the official arguments below. */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  closeGraceMs?: number;
}

interface Pending {
  resolve: (value: RpcObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const object = (value: unknown): value is RpcObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeMethod = (value: string) => value.replace(/[^A-Za-z0-9/_-]/g, "").slice(0, 100);
const callSafely = <T>(listeners: Set<(value: T) => void>, value: T) => {
  for (const listener of listeners) { try { listener(value); } catch { /* Consumers cannot break the transport. */ } }
};

export class CodexClient implements CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Set<(message: RpcNotification) => void>();
  private readonly serverRequests = new Set<(message: RpcServerRequest) => void>();
  private readonly closes = new Set<(error: CodexClientError) => void>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly exited: Promise<void>;
  private buffer = "";
  private nextId = 1;
  private failure: CodexClientError | null = null;
  private closing: Promise<void> | null = null;
  readonly requestTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly closeGraceMs: number;

  constructor(options: CodexClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
    this.closeGraceMs = options.closeGraceMs ?? 1_000;
    this.child = spawn(options.command, options.args ?? ["app-server", "--listen", "stdio://"], {
      cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stderr.on("data", () => { /* Drain without retaining credentials or private diagnostics. */ });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    this.child.stdout.on("end", () => {
      this.receive(this.decoder.end());
      if (this.buffer.trim()) this.fail(new CodexClientError("protocol_invalid", "Codex 返回了不完整的协议消息"));
    });
    this.child.stdin.on("error", () => this.fail(new CodexClientError("transport_closed", "Codex 连接已中断，结果待核实")));
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      this.fail(new CodexClientError(error.code === "ENOENT" ? "codex_missing" : "spawn_failed", "Codex 执行器未能启动"));
    });
    this.child.on("close", () => this.fail(new CodexClientError("transport_closed", "Codex 执行器已退出，结果待核实")));
  }

  get closed(): boolean { return this.failure !== null || this.closing !== null; }

  private send(message: RpcObject): void {
    if (this.closed || !this.child.stdin.writable) throw this.failure ?? new CodexClientError("transport_closed", "Codex 连接已关闭");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: RpcObject = {}): Promise<RpcObject> {
    if (this.closed) return Promise.reject(this.failure ?? new CodexClientError("transport_closed", "Codex 连接已关闭"));
    if (this.pending.size >= 128) return Promise.reject(new CodexClientError("client_busy", "Codex 待回应请求过多"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexClientError("request_timeout", `Codex ${safeMethod(method)} 回应超时，结果待核实`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        this.pending.delete(id); clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method: string, params: RpcObject = {}): void { this.send({ method, params }); }
  reply(id: number | string, result: RpcObject): void { this.send({ id, result }); }
  reject(id: number | string, code: number, message: string): void { this.send({ id, error: { code, message } }); }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    let split: number;
    while ((split = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, split); this.buffer = this.buffer.slice(split + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxMessageBytes) { this.protocolFailure("Codex 协议消息超过读取上限"); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.protocolFailure("Codex 返回了无法解析的协议消息"); return; }
      if (!object(message)) { this.protocolFailure("Codex 返回了无效的协议消息"); return; }
      if (typeof message.method === "string") {
        const params = object(message.params) ? message.params : {};
        if (typeof message.id === "string" || typeof message.id === "number") {
          const request = { id: message.id, method: message.method, params };
          if (this.serverRequests.size) callSafely(this.serverRequests, request);
          else this.reject(message.id, -32601, "This client cannot approve or execute server requests");
        } else callSafely(this.notifications, { method: message.method, params });
        continue;
      }
      if (typeof message.id !== "number") { this.protocolFailure("Codex 回应缺少请求编号"); return; }
      const pending = this.pending.get(message.id);
      if (!pending) continue; // Late responses to timed-out requests are not another request's ACK.
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (object(message.error)) {
        const code = typeof message.error.code === "number" ? message.error.code : undefined;
        pending.reject(new CodexClientError("rpc_rejected", `Codex 拒绝了请求${code === undefined ? "" : `（代码 ${code}）`}`, code));
      } else if (object(message.result)) pending.resolve(message.result);
      else pending.reject(new CodexClientError("protocol_invalid", "Codex 回应缺少有效结果"));
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) this.protocolFailure("Codex 协议消息超过读取上限");
  }

  private protocolFailure(message: string): void {
    this.fail(new CodexClientError("protocol_invalid", message));
    void this.close().catch(() => {});
  }

  private fail(error: CodexClientError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    callSafely(this.closes, error);
    if (!this.closing) void this.close().catch(() => {});
  }

  onNotification(listener: (message: RpcNotification) => void): () => void { this.notifications.add(listener); return () => this.notifications.delete(listener); }
  onServerRequest(listener: (message: RpcServerRequest) => void): () => void { this.serverRequests.add(listener); return () => this.serverRequests.delete(listener); }
  onClose(listener: (error: CodexClientError) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Publish the closing state before callbacks can re-enter close().
    this.closing = Promise.resolve().then(() => this.shutdown());
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.fail(new CodexClientError("transport_closed", "Codex 连接已关闭，未完成结果需核实"));
    const wait = () => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.closeGraceMs);
      this.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    this.child.stdin.end();
    if (await wait()) return;
    this.child.kill("SIGTERM");
    if (await wait()) return;
    this.child.kill("SIGKILL");
    if (!(await wait())) throw new CodexClientError("close_failed", "Codex 自有执行器未能退出");
  }
}

export const createCodexClient = (options: CodexClientOptions): CodexRpc => new CodexClient(options);
