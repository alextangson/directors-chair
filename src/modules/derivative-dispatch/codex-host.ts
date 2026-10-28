/** Official Codex AppServer child, owned by the service. No API/provider fallback. */
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultHostEnv, findOnPath } from "../../desktop/host-connect/env.js";
import { CodexClientError, createCodexClient, type CodexClientOptions, type CodexRpc, type RpcNotification, type RpcObject, type RpcServerRequest } from "./codex-client.js";
import type { CodexHostAdapter, LaunchResult, RemoteThread, ThreadInspection } from "./types.js";

export interface CodexAdapterOptions {
  client?: Omit<CodexClientOptions, "command"> & { command?: string };
  clientFactory?: () => CodexRpc;
  onAttention?: (threadId: string, reason: string) => void;
  historyPageSize?: number;
  lookupPageSize?: number;
  maxLookupPages?: number;
  now?: () => Date;
}

const object = (value: unknown): RpcObject => value && typeof value === "object" && !Array.isArray(value) ? value as RpcObject : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const terminal = (status: string) => ["completed", "failed", "interrupted"].includes(status);
const safeMethod = (value: string) => value.replace(/[^A-Za-z0-9/_-]/g, "").slice(0, 100);
const statusOf = (thread: RpcObject): string => string(object(thread.status).type) || string(thread.status) || "unknown";
const positiveLimit = (value: number | undefined, fallback: number, max: number) => Number.isInteger(value) && value! > 0 ? Math.min(value!, max) : fallback;
const promptHash = (text: string) => createHash("sha256").update(text).digest("hex");
function containsPrompt(turn: RpcObject, expected: string): boolean {
  return Array.isArray(turn.items) && turn.items.some((raw) => {
    const item = object(raw);
    if (item.type !== "userMessage" || !Array.isArray(item.content)) return false;
    const text = item.content.filter((part) => object(part).type === "text").map((part) => string(object(part).text)).join("\n");
    return promptHash(text) === expected;
  });
}

class HostBlocked extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Do not include server error text: it may contain request payloads or account details. */
function failure(error: unknown): { code: string; error: string } {
  if (error instanceof HostBlocked || error instanceof CodexClientError) return { code: error.code, error: error.message };
  return { code: "codex_failed", error: "Codex 操作未能确认，请查看会话后再继续" };
}

class Adapter implements CodexHostAdapter {
  private rpc: CodexRpc | null = null;
  private ready: Promise<CodexRpc> | null = null;
  private disposed = false;
  private authChanged = false;
  private globalAttention: string | undefined;
  private readonly active = new Map<string, Set<string>>();
  private readonly requestingTurns = new Set<string>();
  private readonly submittedTurns = new Map<string, { promptHash: string; turnId?: string }>();
  private readonly turnEvents = new Map<string, number>();
  private readonly finished = new Set<string>();
  private readonly attention = new Map<string, string>();
  private readonly knownThreads = new Set<string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly factory: () => CodexRpc;
  private readonly now: () => Date;
  private readonly historyPageSize: number;
  private readonly lookupPageSize: number;
  private readonly maxLookupPages: number;

  constructor(private readonly options: CodexAdapterOptions) {
    const host = defaultHostEnv();
    this.env = options.client?.env ?? host.childEnv;
    this.factory = options.clientFactory ?? (() => {
      const command = options.client?.command ?? findOnPath("codex", host);
      if (!command) throw new HostBlocked("codex_missing", "未找到 Codex CLI，请先安装并用 ChatGPT 登录");
      return createCodexClient({ ...options.client, command, cwd: options.client?.cwd ?? host.home, env: this.env });
    });
    this.now = options.now ?? (() => new Date());
    this.historyPageSize = positiveLimit(options.historyPageSize, 5, 20);
    this.lookupPageSize = positiveLimit(options.lookupPageSize, 50, 100);
    this.maxLookupPages = positiveLimit(options.maxLookupPages, 100, 1_000);
  }

  private async connection(): Promise<CodexRpc> {
    if (this.disposed) throw new HostBlocked("adapter_closed", "Codex 执行器已关闭");
    if (this.rpc && !this.rpc.closed && this.ready) return this.ready;
    const rpc = this.factory();
    this.rpc = rpc;
    this.authChanged = false;
    this.globalAttention = undefined;
    rpc.onNotification((message) => this.notification(message));
    rpc.onServerRequest((message) => this.serverRequest(rpc, message));
    rpc.onClose(() => {
      for (const threadId of new Set([...this.active.keys(), ...this.requestingTurns, ...this.submittedTurns.keys()])) this.needsAttention(threadId, "Codex 连接已中断，本轮结果待核实");
      this.active.clear(); this.requestingTurns.clear(); this.submittedTurns.clear();
    });
    this.ready = (async () => {
      await rpc.request("initialize", { clientInfo: { name: "autocrew_derivative_dispatch", title: "导演椅派生会话", version: "1" } });
      rpc.notify("initialized", {});
      return rpc;
    })();
    try { return await this.ready; }
    catch (error) { await rpc.close().catch(() => {}); throw error; }
  }

  private async account(): Promise<CodexRpc> {
    const rpc = await this.connection();
    const result = await rpc.request("account/read", { refreshToken: false });
    if (this.authChanged || object(result.account).type !== "chatgpt") throw new HostBlocked("auth_not_chatgpt", "Codex 当前未使用 ChatGPT 订阅登录；派生任务已停止，不会改用 API");
    return rpc;
  }

  private async execution(cwd?: string): Promise<CodexRpc> {
    const rpc = await this.account();
    const result = await rpc.request("config/read", { includeLayers: false, ...(cwd ? { cwd } : {}) });
    const config = object(result.config);
    if (!Object.keys(config).length) throw new HostBlocked("config_unverified", "无法核实 Codex 的有效供应商配置");
    const provider = string(config.model_provider) || "openai";
    const providers = object(config.model_providers);
    const selected = object(providers[provider]);
    // Configuration evidence only. Never expose keys or rewrite model/provider/permissions.
    if (provider !== "openai" || config.forced_login_method === "api" || Object.keys(selected).length
      || string(config.openai_base_url) || string(this.env.OPENAI_BASE_URL)) {
      throw new HostBlocked("provider_unverified", "Codex 配置不是已核实的原生 ChatGPT 供应商路径；不会切换供应商或改用 API");
    }
    if (this.globalAttention) throw new HostBlocked("needs_attention", this.globalAttention);
    return rpc;
  }

  async capability(): Promise<{ ok: boolean; reason?: string; authMode?: string }> {
    try { await this.execution(); return { ok: true, authMode: "chatgpt" }; }
    catch (error) { return { ok: false, reason: failure(error).error, ...(error instanceof HostBlocked && error.code === "provider_unverified" ? { authMode: "chatgpt" } : {}) }; }
  }

  async lookup(cwd: string): Promise<RemoteThread[]> {
    if (!path.isAbsolute(cwd)) throw new HostBlocked("bad_cwd", "会话工作目录必须是绝对路径");
    const rpc = await this.account();
    const matches = new Map<string, RemoteThread>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < this.maxLookupPages; page++) {
      const result = await rpc.request("thread/list", { cwd, sourceKinds: ["appServer"], limit: this.lookupPageSize, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new HostBlocked("lookup_invalid", "Codex 未返回有效的会话列表，不能据此新建会话");
      for (const raw of result.data) {
        const thread = object(raw);
        if (thread.cwd !== cwd) continue; // Keep exact server filtering as a client invariant too.
        const id = string(thread.id);
        if (!id) throw new HostBlocked("lookup_invalid", "Codex 会话缺少编号，结果待核实");
        matches.set(id, { id, cwd, ...(string(thread.name) ? { name: string(thread.name) } : {}), status: statusOf(thread) });
        this.knownThreads.add(id);
      }
      const next = string(result.nextCursor);
      if (!next) return [...matches.values()];
      if (cursors.has(next)) throw new HostBlocked("lookup_incomplete", "Codex 会话分页重复，查重尚未完成");
      cursors.add(next); cursor = next;
    }
    throw new HostBlocked("lookup_incomplete", "Codex 会话查重超过分页上限，不能据此新建会话");
  }

  async start(input: { jobId: string; cwd: string; title: string; prompt: string }, onCreated: (threadId: string) => Promise<void>, beforeTurn?: () => Promise<void>): Promise<LaunchResult> {
    if (!path.isAbsolute(input.cwd) || !input.jobId.trim() || !input.prompt.trim()) return { status: "blocked", code: "bad_input", error: "派生会话缺少有效的工作目录或开工指令" };
    let rpc: CodexRpc;
    try { rpc = await this.execution(input.cwd); }
    catch (error) { return { status: "blocked", ...failure(error) }; }
    let threadId: string | undefined;
    try {
      const created = await rpc.request("thread/start", { cwd: input.cwd, threadSource: "autocrew_derivative_dispatch" });
      const thread = object(created.thread);
      threadId = string(thread.id) || undefined;
      if (!threadId) return { status: "unknown", code: "thread_create_unknown", error: "Codex 未返回会话编号，请先按工作目录查重" };
      this.knownThreads.add(threadId);
      // This callback durably saves identity and rechecks source authorization before any turn.
      await onCreated(threadId);
      if (created.modelProvider !== "openai" || thread.cwd !== input.cwd) return { status: "blocked", code: "effective_config_unverified", error: "新会话的有效供应商或工作目录与已核配置不符，尚未发送模型指令", threadId };
      try { await rpc.request("thread/name/set", { threadId, name: input.title.slice(0, 160) }); }
      catch (error) { if (!(error instanceof CodexClientError && error.code === "rpc_rejected")) throw error; }
      return await this.turn(rpc, threadId, input.prompt, beforeTurn);
    } catch (error) {
      return { status: "unknown", code: threadId ? "thread_start_unknown" : "thread_create_unknown", error: failure(error).error, ...(threadId ? { threadId } : {}) };
    }
  }

  private async turn(rpc: CodexRpc, threadId: string, prompt: string, beforeTurn?: () => Promise<void>): Promise<LaunchResult> {
    const priorAttention = this.attention.get(threadId) ?? this.globalAttention;
    if (this.authChanged || priorAttention) return { status: "blocked", code: "needs_attention", error: priorAttention ?? "Codex 登录方式已改变，尚未发送模型指令", threadId };
    this.requestingTurns.add(threadId);
    try {
      // The final await must recheck current policy/source after name/resume/config round trips.
      try { await beforeTurn?.(); }
      catch { return { status: "blocked", code: "before_turn_blocked", error: "开工前核验未通过，尚未发送模型指令", threadId }; }
      const attention = this.attention.get(threadId) ?? this.globalAttention;
      if (this.authChanged || attention) return { status: "blocked", code: "needs_attention", error: attention ?? "Codex 登录方式已改变，尚未发送模型指令", threadId };
      if (!rpc.closed) this.submittedTurns.set(threadId, { promptHash: promptHash(prompt) });
      const result = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
      const turn = object(result.turn);
      const id = string(turn.id), status = string(turn.status);
      if (!id || !["inProgress", "completed", "failed", "interrupted"].includes(status)) return { status: "unknown", code: "turn_start_unknown", error: "Codex 未返回有效轮次，不能自动重发指令", threadId };
      const submitted = this.submittedTurns.get(threadId);
      if (submitted) submitted.turnId = id;
      this.observeTurn(threadId, turn);
      if (this.finished.has(`${threadId}:${id}`)) this.submittedTurns.delete(threadId);
      const afterAckAttention = this.attention.get(threadId);
      if (afterAckAttention) return { status: "blocked", code: "needs_attention", error: afterAckAttention, threadId };
      return { status: "started", session: { threadId, turnId: id, submittedAt: this.now().toISOString() } };
    } catch (error) { return { status: "unknown", code: "turn_start_unknown", error: failure(error).error, threadId }; }
    finally { this.requestingTurns.delete(threadId); }
  }

  async inspect(threadId: string, cursor?: string): Promise<ThreadInspection> {
    if (!threadId.trim()) throw new HostBlocked("bad_thread", "缺少 Codex 会话编号");
    const rpc = await this.account();
    const eventVersion = this.turnEvents.get(threadId) ?? 0;
    const read = await rpc.request("thread/read", { threadId, includeTurns: false });
    const thread = object(read.thread);
    if (thread.id !== threadId) throw new HostBlocked("thread_mismatch", "Codex 返回的会话编号不符");
    this.knownThreads.add(threadId);
    const status = statusOf(thread);
    if (status !== "active" && eventVersion === (this.turnEvents.get(threadId) ?? 0)) this.active.delete(threadId);
    const flags = object(thread.status).activeFlags;
    if (Array.isArray(flags) && flags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")) this.needsAttention(threadId, "Codex 正在等待人工批准或输入");
    if (status === "systemError") this.needsAttention(threadId, "Codex 会话出现系统错误，请人工查看");
    const history = await rpc.request("thread/turns/list", { threadId, limit: this.historyPageSize, itemsView: "full", ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(history.data)) throw new HostBlocked("history_invalid", "Codex 未返回有效历史记录");
    let budget = 64_000;
    const turns = history.data.slice(0, this.historyPageSize).map((raw) => {
      const turn = object(raw);
      this.observeTurn(threadId, turn, status === "active");
      const items = (Array.isArray(turn.items) ? turn.items : []).slice(0, 100).map((rawItem) => {
        const item = object(rawItem), type = string(item.type) || "unknown";
        let text = type === "agentMessage" ? string(item.text) : type === "userMessage" && Array.isArray(item.content)
          ? item.content.filter((part) => object(part).type === "text").map((part) => string(object(part).text)).join("\n") : "";
        text = text.slice(0, Math.min(8_000, budget)); budget -= text.length;
        return { type, ...(text ? { text } : {}) };
      });
      return { id: string(turn.id), status: string(turn.status) || "unknown", items };
    });
    const needsAttention = this.attention.get(threadId) ?? this.globalAttention;
    if (status === "idle" && !this.requestingTurns.has(threadId) && eventVersion === (this.turnEvents.get(threadId) ?? 0)) this.submittedTurns.delete(threadId);
    return { threadId, status, turns, nextCursor: string(history.nextCursor) || null, ...(needsAttention ? { needsAttention } : {}) };
  }

  async resume(threadId: string, prompt: string, beforeTurn?: () => Promise<void>): Promise<LaunchResult> {
    if (!threadId.trim() || !prompt.trim()) return { status: "blocked", code: "bad_input", error: "恢复会话必须指定原会话编号和明确的新指令" };
    let rpc: CodexRpc;
    try {
      const current = await this.inspect(threadId);
      if (current.status === "active" || this.active.has(threadId) || this.requestingTurns.has(threadId) || this.submittedTurns.has(threadId)) return { status: "blocked", code: "thread_active", error: "原会话仍在执行或回执待核实；先查看结果，不能重复发送", threadId };
      const connected = await this.account();
      const read = await connected.request("thread/read", { threadId, includeTurns: false });
      rpc = await this.execution(string(object(read.thread).cwd));
    } catch (error) { return { status: "blocked", ...failure(error), threadId }; }
    try {
      const resumed = await rpc.request("thread/resume", { threadId });
      if (object(resumed.thread).id !== threadId || resumed.modelProvider !== "openai") return { status: "blocked", code: "resume_mismatch", error: "Codex 恢复结果的会话或供应商不符，尚未发送新指令", threadId };
      if (statusOf(object(resumed.thread)) === "active" || this.active.has(threadId)) return { status: "blocked", code: "thread_active", error: "原会话已开始执行，尚未发送新指令", threadId };
      this.attention.delete(threadId);
      return await this.turn(rpc, threadId, prompt, beforeTurn);
    } catch (error) { return { status: "unknown", code: "resume_unknown", error: failure(error).error, threadId }; }
  }

  private observeTurn(threadId: string, turn: RpcObject, recordActive = true): void {
    const id = string(turn.id), status = string(turn.status);
    if (!id) return;
    const key = `${threadId}:${id}`;
    if (terminal(status)) {
      this.finished.add(key);
      if (this.finished.size > 1_000) this.finished.delete(this.finished.values().next().value!);
      this.active.get(threadId)?.delete(id);
      if (!this.active.get(threadId)?.size) this.active.delete(threadId);
      const submitted = this.submittedTurns.get(threadId);
      if (submitted && (submitted.turnId === id || containsPrompt(turn, submitted.promptHash))) this.submittedTurns.delete(threadId);
      if (status !== "completed") this.needsAttention(threadId, status === "failed" ? "Codex 本轮执行失败，请查看会话" : "Codex 本轮已中断，请查看后再继续");
    } else if (recordActive && status === "inProgress" && !this.finished.has(key)) {
      const submitted = this.submittedTurns.get(threadId);
      if (submitted && !submitted.turnId) submitted.turnId = id;
      const turns = this.active.get(threadId) ?? new Set<string>(); turns.add(id); this.active.set(threadId, turns);
    }
  }

  private notification(message: RpcNotification): void {
    const threadId = string(message.params.threadId);
    if (message.method === "account/updated" && "authMode" in message.params) {
      this.authChanged = message.params.authMode !== "chatgpt";
      if (this.authChanged) {
        for (const id of new Set([...this.active.keys(), ...this.requestingTurns])) this.needsAttention(id, "Codex 登录方式已改变；后台已停止发送新指令，并请求中断原轮次");
        for (const [id, turns] of this.active) for (const turnId of turns) void this.rpc?.request("turn/interrupt", { threadId: id, turnId }).catch(() => {});
      }
    } else if (message.method === "turn/started" || message.method === "turn/completed") {
      if (threadId) { this.turnEvents.set(threadId, (this.turnEvents.get(threadId) ?? 0) + 1); this.observeTurn(threadId, object(message.params.turn)); }
    } else if (message.method === "error" && threadId) this.needsAttention(threadId, "Codex 报告执行错误，请查看会话");
    else if (message.method === "thread/status/changed" && threadId) {
      const status = object(message.params.status);
      if (Array.isArray(status.activeFlags) && status.activeFlags.length) this.needsAttention(threadId, "Codex 正在等待人工批准或输入");
    }
  }

  private needsAttention(threadId: string, reason: string): void {
    if (this.attention.get(threadId) === reason) return;
    this.attention.set(threadId, reason);
    try { void Promise.resolve(this.options.onAttention?.(threadId, reason)).catch(() => {}); } catch { /* Persistence callback cannot break protocol handling. */ }
  }

  private serverRequest(rpc: CodexRpc, request: RpcServerRequest): void {
    const direct = string(request.params.threadId) || string(request.params.conversationId);
    const pending = new Set([...this.active.keys(), ...this.requestingTurns]);
    const threads = direct ? [direct] : pending.size ? [...pending] : this.knownThreads.size === 1 ? [...this.knownThreads] : [];
    const reason = `Codex 需要人工处理：${safeMethod(request.method)}；后台未自动批准`;
    if (!threads.length) this.globalAttention = reason;
    for (const threadId of threads) this.needsAttention(threadId, reason);
    try {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval": rpc.reply(request.id, { decision: "decline" }); break;
        case "execCommandApproval":
        case "applyPatchApproval": rpc.reply(request.id, { decision: "abort" }); break;
        case "item/permissions/requestApproval": rpc.reply(request.id, { permissions: {}, scope: "turn" }); break;
        case "item/tool/requestUserInput": rpc.reply(request.id, { answers: {} }); break;
        case "mcpServer/elicitation/request": rpc.reply(request.id, { action: "decline" }); break;
        case "item/tool/call": rpc.reply(request.id, { success: false, contentItems: [{ type: "inputText", text: "This background client cannot perform interactive client tools." }] }); break;
        default: rpc.reject(request.id, -32601, "This background client requires human attention for this request");
      }
    } catch { /* A closed connection has already rejected pending requests. */ }
  }

  activeCount(): number { return new Set([...this.active.keys(), ...this.requestingTurns, ...this.submittedTurns.keys()]).size; }
  async close(): Promise<void> { this.disposed = true; await this.rpc?.close(); }
}

export const createCodexAdapter = (options: CodexAdapterOptions = {}): CodexHostAdapter => new Adapter(options);
