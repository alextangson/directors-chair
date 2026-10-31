/**
 * 成片登记之后清混音中间件（2026-10-30 存储审查）：`99-cache/audio` 里每轮混音检查导出的整混 / 口播
 * 音频到这时就没用了（报告留着）。全库最大的单类占用就是它（16.9G，一条片最多 7G）。
 * 登记过的文件（制作事实、素材库原地登记）一律不动；不跟随链接；目录结构和报告保留。
 */
import fs from "node:fs/promises";
import path from "node:path";

export const MIX_AUDIO_DIR = "99-cache/audio";
const AUDIO = /\.(flac|wav|m4a|mp3|aiff?|caf)$/i;

export async function purgeMixAudio(projectRoot: string, recorded: Set<string>): Promise<number> {
  // 路径上每一级（99-cache、99-cache/audio）都要是真目录：任何一级是链接（指到共享或项目外的目录）就不碰（Codex 审）
  let rel = "";
  for (const seg of MIX_AUDIO_DIR.split("/")) {
    rel = rel ? `${rel}/${seg}` : seg;
    const st = await fs.lstat(path.join(projectRoot, rel)).catch(() => null);
    if (!st?.isDirectory()) return 0;
  }
  return purgeDir(projectRoot, MIX_AUDIO_DIR, recorded);
}

async function purgeDir(projectRoot: string, rel: string, recorded: Set<string>): Promise<number> {
  let freed = 0;
  for (const e of await fs.readdir(path.join(projectRoot, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) { freed += await purgeDir(projectRoot, child, recorded); continue; }
    if (!AUDIO.test(e.name) || recorded.has(child)) continue;
    const p = path.join(projectRoot, child);
    freed += e.isFile() ? (await fs.lstat(p)).size : 0;
    await fs.rm(p, { force: true });
  }
  return freed;
}
