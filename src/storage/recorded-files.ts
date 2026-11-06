/**
 * 制作记录或素材库里登记过的文件（项目内相对路径）。record 允许原地登记项目里任何位置的文件——包括 99-cache、
 * node_modules、review-preview 下面——登记又不再另存副本，所以这些文件可能是唯一一份：清缓存、
 * 按「可重建」跳过备份 / 删除时都得先把它们排除在外。读不出制作记录就抛错，调用方跳过这条，不猜。
 */
import path from "node:path";
import { readProductionDoc } from "./production-store.js";
import type { Content } from "./local-store.js";
import { isRebuildable } from "./nas-archive-copy.js";

export async function recordedRels(content: Content, dataDir: string, projectRoot: string): Promise<Set<string>> {
  const doc = await readProductionDoc(content.id, dataDir);
  const out = new Set<string>();
  // 制作事实的路径 + 素材库原地登记的项目内路径（autocrew_asset add 不建制作事实）
  const paths = [...(doc?.facts ?? []).map((f) => f.path), ...(content.assets ?? []).map((a) => a.projectPath)];
  for (const p of paths) {
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.join(projectRoot, p);
    const rel = path.relative(projectRoot, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) out.add(rel.split(path.sep).join("/"));
  }
  return out;
}

/** rel 本身或它下面有登记过的文件 */
export function holdsRecorded(rel: string, recorded: Set<string>): boolean {
  for (const r of recorded) if (r === rel || r.startsWith(`${rel}/`)) return true;
  return false;
}

/** 可重建、且下面没有登记过的文件：这才能跳过备份 / 归档复制、直接删 */
export const rebuildableExcept = (recorded: Set<string>) => (rel: string) => isRebuildable(rel) && !holdsRecorded(rel, recorded);
