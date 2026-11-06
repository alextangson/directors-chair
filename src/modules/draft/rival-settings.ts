/**
 * 比稿 Gemini Key 的独立配置（rival.json，0600）。
 * 11-06 创始人定：封面不用 Gemini，比稿的 key 不放进封面设置。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "../../storage/storage-roots.js";

export interface RivalSettings {
  geminiApiKey?: string;
}

const FILE = "rival.json";

export const rivalSettingsPath = (dataDir?: string) => path.join(getConfigDir(dataDir), FILE);

export async function loadRivalSettings(dataDir?: string): Promise<RivalSettings> {
  try {
    return JSON.parse(await fs.readFile(rivalSettingsPath(dataDir), "utf-8")) as RivalSettings;
  } catch {
    return {};
  }
}

export async function saveRivalSettings(updates: RivalSettings, dataDir?: string): Promise<RivalSettings> {
  await fs.mkdir(getConfigDir(dataDir), { recursive: true });
  const filePath = rivalSettingsPath(dataDir);
  const merged = { ...(await loadRivalSettings(dataDir)), ...updates };
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return merged;
}
