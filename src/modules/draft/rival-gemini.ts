/**
 * 比稿（spec 2026-11-06）：调 Gemini 官方 API 写一版全文。
 * key 只放请求头 x-goog-api-key，不进 URL。402 = 余额不足；429/5xx 按 Retry-After 重试一次；其他错误和超时如实回原因。
 */
import { loadCoverSettings } from "../cover/provider.js";

export const DEFAULT_RIVAL_MODEL = "gemini-3.1-pro-preview";
const API = "https://generativelanguage.googleapis.com/v1beta/models";
/** 3.1 Pro 官网单价（提示 ≤200k）：输入 $2/M，输出（含思考）$12/M */
const PRICE_IN = 2 / 1e6;
const PRICE_OUT = 12 / 1e6;
const RETRY_CAP_MS = 60_000;

type Fetch = typeof fetch;
let fetchOverride: Fetch | undefined;
let timeoutMs = 10 * 60_000;
/** 只给测试：替换真实 HTTP / 缩短超时 */
export function setRivalFetch(fn: Fetch | undefined): void { fetchOverride = fn; }
export function setRivalTimeoutMs(ms: number | undefined): void { timeoutMs = ms ?? 10 * 60_000; }

export const rivalModel = () => process.env.AUTOCREW_RIVAL_MODEL?.trim() || DEFAULT_RIVAL_MODEL;
export const NOT_CONFIGURED_HINT = "没配 Gemini Key：在 设置·封面生成 填「Gemini Key」（封面和比稿共用），或设环境变量 GEMINI_API_KEY。这篇只交主会话那一版";

/** 环境变量优先，再看设置里封面那把 */
export async function rivalKey(dataDir?: string): Promise<string | null> {
  const env = process.env.GEMINI_API_KEY?.trim();
  if (env) return env;
  return (await loadCoverSettings(dataDir)).geminiApiKey?.trim() || null;
}

export interface RivalUsage { prompt_tokens: number; output_tokens: number; thought_tokens: number; total_tokens: number }
export type RivalResult =
  | { ok: true; body: string; usage: RivalUsage; cost_usd_estimate: number }
  | { ok: false; reason: string };

export const estimateCost = (u: RivalUsage) => Math.round((u.prompt_tokens * PRICE_IN + (u.output_tokens + u.thought_tokens) * PRICE_OUT) * 10_000) / 10_000;

function usageOf(m: Record<string, unknown> | undefined): RivalUsage {
  const n = (k: string) => (typeof m?.[k] === "number" ? m[k] as number : 0);
  return { prompt_tokens: n("promptTokenCount"), output_tokens: n("candidatesTokenCount"), thought_tokens: n("thoughtsTokenCount"), total_tokens: n("totalTokenCount") };
}

function parseReply(json: Record<string, unknown>): RivalResult {
  const blocked = (json.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
  if (blocked) return { ok: false, reason: `Gemini 拒绝了这份简报（blockReason: ${blocked}）` };
  const cand = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  const parts = ((cand?.content as { parts?: Array<{ text?: string; thought?: boolean }> } | undefined)?.parts ?? []);
  const body = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("").trim();
  // 只认正常写完：MAX_TOKENS / SAFETY 等停下的半截稿不能当成写完、被拿去盲选
  if (cand?.finishReason !== "STOP") return { ok: false, reason: `Gemini 没写完（finishReason: ${String(cand?.finishReason ?? "无")}${body ? `，只写了 ${body.length} 字` : ""}）` };
  if (!body) return { ok: false, reason: "Gemini 没返回正文（finishReason: STOP）" };
  const usage = usageOf(json.usageMetadata as Record<string, unknown> | undefined);
  return { ok: true, body, usage, cost_usd_estimate: estimateCost(usage) };
}

const retryable = (s: number) => s === 429 || s >= 500;
function retryDelay(res: Response): number {
  const h = res.headers.get("retry-after");
  const s = h === null || !h.trim() ? NaN : Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, RETRY_CAP_MS) : 2000;
}

async function errorText(res: Response): Promise<string> {
  const t = await res.text().catch(() => "");
  return `Gemini 请求失败（HTTP ${res.status}）：${t.slice(0, 300) || res.statusText}`;
}

async function post(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return (fetchOverride ?? fetch)(url, { ...init, signal });
}

/** system = 写作指令，brief = 锁住的依据；整次调用（含重试）最多 10 分钟 */
export async function callGemini(apiKey: string, model: string, system: string, brief: string): Promise<RivalResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const url = `${API}/${encodeURIComponent(model)}:generateContent`;
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: brief }] }] }) };
  try {
    let res = await post(url, init, ctl.signal);
    if (retryable(res.status)) {
      await new Promise((r) => setTimeout(r, retryDelay(res)));
      res = await post(url, init, ctl.signal);
    }
    if (res.status === 402) return { ok: false, reason: "Gemini 账户余额不足" };
    if (!res.ok) return { ok: false, reason: await errorText(res) };
    return parseReply(await res.json() as Record<string, unknown>);
  } catch (err) {
    if (ctl.signal.aborted) return { ok: false, reason: `Gemini 超过 ${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟没写完（超时），已放弃` };
    return { ok: false, reason: `Gemini 调用出错：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
