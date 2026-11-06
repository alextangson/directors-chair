/** 写稿比稿设置 handlers：get 只回掩码，set 只收 gemini_api_key。 */
import { loadRivalSettings, saveRivalSettings } from "../modules/draft/rival-settings.js";
import { rivalModel } from "../modules/draft/rival-gemini.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

const isObj = (p: unknown) => p !== null && typeof p === "object" && !Array.isArray(p);

export async function rivalSettingsGetHandler(payload: Payload): Promise<HandlerResult> {
  if (!isObj(payload)) return { ok: false, error: "Invalid payload: expected object" };
  try {
    const env = process.env.GEMINI_API_KEY?.trim();
    const file = (await loadRivalSettings((payload._dataDir as string) || undefined)).geminiApiKey?.trim();
    const key = env || file || null;
    const source = env ? "env" : file ? "file" : "none";
    return { ok: true, data: { configured: key !== null, apiKeyMasked: key ? maskKey(key) : null, source, model: rivalModel() } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function rivalSettingsSetHandler(payload: Payload): Promise<HandlerResult> {
  if (!isObj(payload)) return { ok: false, error: "Invalid payload: expected object" };
  const k = payload.gemini_api_key;
  if (typeof k !== "string" || k.trim() === "") return { ok: false, error: "gemini_api_key 必须是非空字符串" };
  try {
    await saveRivalSettings({ geminiApiKey: k.trim() }, (payload._dataDir as string) || undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
