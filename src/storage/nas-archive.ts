/**
 * NAS 归档（storage-layout.md「NAS 归档（2026-09-27）」；创始人 10-25「本机只留正在做的」）：发布满 24 小时、
 * 不在做了的稿件（派生的公众号长文 / 英文版都发完或标了不出），整个项目复制到 NAS 并逐文件核对后，才删本机的素材目录。先写归档记录和路径重定位，再删；中途失败下次续跑。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Content } from "./local-store.js";
import { listContents } from "./local-store.js";
import { readLibraryLocation, getLibraryRoot, readArchiveRoot, ARCHIVE_ROOT_UNSET } from "./storage-roots.js";
import { readProjectRegistry, resolveContentProject, isMissing } from "./content-project.js";
import { productionServiceDir, readProductionDoc } from "./production-store.js";
import { writeJsonAtomic } from "./json-atomic.js";
import { writeErrorSection } from "./my-content-errors.js";
import { VIEW_DIR } from "./my-content-view.js";
import { withFileOwnership } from "./file-ownership.js";
import { copyProject, PROJECT_CACHE_DIR, REBUILDABLE_NAMES, sha256File as nasSha, walkProject, type ArchivedFile, type CopyImpl } from "./nas-archive-copy.js";
import { appendArchiveLog, formatBytes } from "./nas-archive-log.js";
import { assertTargetOutsideSource } from "./nas-safe-path.js";
import { KEPT_DIR } from "./nas-kept.js";
import { publishedSet, type PublishedSet } from "./round-publish-time.js";
import { loadUnfinishedChildren } from "./archive-in-progress.js";
import { holdsRecorded, rebuildableExcept, recordedRels } from "./recorded-files.js";

/** 归档删完后保留空骨架的素材目录（剪辑软件、技能按这些名字找位置） */
export const MEDIA_DIRS = ["02-aroll", "03-broll", "04-edit", "05-audio", "05-cover", "07-delivery"] as const;
/**
 * 归档后本机只留这些顶层目录（storage-layout.md「NAS 归档」第 7 步）+ 根目录的文件；其余顶层目录
 * （02–05、07，以及 agent 自建的 08-*、封面/、assets/ …）核对上 NAS 后全删——按保留名单删，不按写死的素材名单删。
 */
export const KEEP_TOP = new Set(["00-project", "01-script", "06-publish", PROJECT_CACHE_DIR]);
/** 发布满 24 小时、且这么久没有新事实 / 改动的已发布稿，每天清 99-cache（不看 NAS、不等可信发布时间：缓存本来就能重建） */
export const CACHE_IDLE_MS = 24 * 60 * 60_000;
/** 发布后留 24 小时给发布后核对 / 纠正；之后不在做了就搬走（不再保留最近 5 条，那是「我的内容」视图的规则） */
export const ARCHIVE_MIN_AGE_MS = 24 * 60 * 60_000;
export const ARCHIVE_MARGIN_BYTES = 1024 ** 3;
const RELOCATIONS = "00-project/autocrew/relocations.json";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface ArchiveOptions {
  archiveRoot?: string;
  now?: Date;
  copyImpl?: CopyImpl;
  /** 目标卷剩余字节；测试注入 */
  freeSpace?: (dir: string) => Promise<number>;
  marginBytes?: number;
  /** 父稿 id → 还没做完的派生稿标题；测试注入，默认按主题分组现算 */
  unfinishedChildren?: (data: string, now: Date) => Promise<Map<string, string[]>>;
}
export interface ArchivedItem { title: string; target: string; freedBytes: number }
export interface ArchiveReport { skipped?: string; archived: ArchivedItem[]; pending: number; errors: string[]; cacheFreed?: ArchivedItem[] }
interface Ctx { data: string; lib: string; root: string; now: Date; copy: CopyImpl; free: (dir: string) => Promise<number>; margin: number; children: (data: string, now: Date) => Promise<Map<string, string[]>> }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function volumeFree(dir: string): Promise<number> {
  const s = await fs.statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * 发布满 24 小时的稿件（「已归档」「还在动」「派生稿没做完」另行判断）。不看保留名单：本机只留正在做的。
 * 本体 §7：排除条件从「活认领」改成「本条有未完成的文件归属事务，或 30 分钟内有 record」（见 busyInProduction）。
 * 定不出本轮发布时间的不归档（归档会删本机文件，宁可不删），报告里列「待确认发布时间」。
 */
export function archiveCandidates(set: PublishedSet, now: Date): { due: Content[]; unknown: Content[] } {
  const due = set.published.filter((c) => c.publishedAt && now.getTime() - Date.parse(c.publishedAt) >= ARCHIVE_MIN_AGE_MS);
  return { due, unknown: set.published.filter((c) => !c.publishedAt) };
}

export const RECENT_RECORD_MS = 30 * 60_000;

/** 这条还在动：有未完成的文件归属事务日志，或 30 分钟内有 agent record 的事实 */
export async function busyInProduction(contentId: string, dataDir: string, now: Date): Promise<string | null> {
  const dir = productionServiceDir(dataDir, "txns");
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const txn = JSON.parse(await fs.readFile(path.join(dir, name), "utf8").catch(() => "{}")) as { content_id?: string };
    if (txn.content_id === contentId) return "有没完成的文件事务";
  }
  const doc = await readProductionDoc(contentId, dataDir).catch(() => null);
  const recent = doc?.facts.some((f) => f.source === "record" && now.getTime() - Date.parse(f.at) < RECENT_RECORD_MS);
  return recent ? "30 分钟内有新报的产物" : null;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try { return (await fs.readdir(dir)).length === 0; } catch (e) { if (isMissing(e)) return true; throw e; }
}

/** 项目根下保留名单以外的顶层目录（要搬去 NAS、再删本机的） */
async function deletableTops(projectRoot: string): Promise<string[]> {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true }).catch((e) => { if (isMissing(e)) return []; throw e; });
  return entries.filter((e) => !KEEP_TOP.has(e.name) && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name);
}

/** 已归档 = 有归档记录，且保留名单以外的目录都空了（有记录但没删干净 = 上次删到一半，要续跑） */
export async function isArchived(projectRoot: string): Promise<boolean> {
  let notes: string[] = [];
  try { notes = await fs.readdir(path.join(projectRoot, "00-project/notes")); } catch (e) { if (!isMissing(e)) throw e; }
  if (!notes.some((n) => /^archive-.+\.json$/.test(n))) return false;
  for (const d of await deletableTops(projectRoot)) if (!(await isEmptyDir(path.join(projectRoot, d)))) return false;
  return true;
}

export function archiveTarget(archiveRoot: string, c: Content, projectRoot: string): string {
  const at = new Date(c.publishedAt!);
  return path.join(archiveRoot, String(at.getFullYear()), MONTHS[at.getMonth()], path.basename(projectRoot));
}

export async function isReachable(dir: string): Promise<boolean> {
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

/** 归档要删的文件：在保留名单以外的顶层目录里（根目录的文件不删） */
const isMedia = (rel: string) => rel.includes("/") && !KEEP_TOP.has(rel.split("/")[0]);

/** 归档记录 + 重定位，必须在删任何东西之前落盘 */
async function writeRecord(projectRoot: string, target: string, files: ArchivedFile[], now: Date): Promise<void> {
  const deleted = files.filter((f) => isMedia(f.rel));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(path.join(projectRoot, "00-project/notes"), { recursive: true });
  await writeJsonAtomic(path.join(projectRoot, `00-project/notes/archive-${stamp}.json`), {
    version: 1, archivedAt: now.toISOString(), target, deletedDirs: [...new Set(deleted.map((f) => f.rel.split("/")[0]))], files,
  });
  const relFile = path.join(projectRoot, RELOCATIONS);
  let relocations: Record<string, string> = {};
  try { relocations = JSON.parse(await fs.readFile(relFile, "utf8")); } catch (e) { if (!isMissing(e)) throw e; }
  for (const f of deleted) relocations[`@project/${f.rel}`] = path.join(target, f.rel);
  await fs.mkdir(path.dirname(relFile), { recursive: true });
  await writeJsonAtomic(relFile, relocations);
}

/** 封面（05-cover 下的图）和登记字幕：删本机素材前留一份小副本 */
async function keepSmallFiles(projectRoot: string, c: Content, files: ArchivedFile[]): Promise<void> {
  const srt = c.video?.final?.srt_path ? path.relative(projectRoot, c.video.final.srt_path).split(path.sep).join("/") : null;
  const keep = files.filter((f) => /^05-cover\/.+\.(png|jpe?g|webp)$/i.test(f.rel) || f.rel === srt);
  for (const f of keep) {
    const dest = path.join(projectRoot, KEPT_DIR, f.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(projectRoot, f.rel), dest);
  }
}

/**
 * 只删逐文件核对过、且此刻字节仍是核对时那份的文件（本体 §7，E36）；核对之后新出现 / 被改过的文件留着，
 * 下一轮归档再带走。删完清掉空目录，素材目录本身保留。
 */
async function deleteMedia(projectRoot: string, files: ArchivedFile[], recorded: Set<string>): Promise<{ kept: number; rebuildableBytes: number }> {
  let kept = 0;
  const verified = new Map(files.filter((f) => isMedia(f.rel)).map((f) => [f.rel, f]));
  const { files: now } = await walkProject(projectRoot, rebuildableExcept(recorded));
  for (const f of now.filter((x) => isMedia(x.rel))) {
    const v = verified.get(f.rel);
    if (v && v.size === f.size && (await nasSha(path.join(projectRoot, f.rel)).catch(() => null)) === v.sha256) await fs.rm(path.join(projectRoot, f.rel), { force: true });
    else kept++;
  }
  const rebuildableBytes = await removeRebuildables(projectRoot, "", recorded);
  const skeleton = new Set<string>(MEDIA_DIRS);
  for (const d of await deletableTops(projectRoot)) await pruneEmpty(path.join(projectRoot, d), skeleton.has(d));
  for (const d of MEDIA_DIRS) await fs.mkdir(path.join(projectRoot, d), { recursive: true });
  return { kept, rebuildableBytes };
}

/**
 * 删掉 99-cache 以外任意层的 node_modules / review-preview（可重建，不上 NAS）：是链接只删链接本身、不跟进去；
 * 是目录整棵删。返回删掉的字节数。
 */
async function removeRebuildables(projectRoot: string, rel: string, recorded: Set<string>): Promise<number> {
  const entries = await fs.readdir(path.join(projectRoot, rel), { withFileTypes: true }).catch((e) => { if (isMissing(e)) return []; throw e; });
  let freed = 0;
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (child === PROJECT_CACHE_DIR) continue;
    const p = path.join(projectRoot, child);
    if (REBUILDABLE_NAMES.has(e.name) && !holdsRecorded(child, recorded)) {
      freed += e.isDirectory() ? await treeBytes(p) : 0;
      await fs.rm(p, { recursive: true, force: true });
    } else if (e.isDirectory()) freed += await removeRebuildables(projectRoot, child, recorded);
  }
  return freed;
}

async function treeBytes(dir: string): Promise<number> {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await treeBytes(p);
    else if (e.isFile()) n += (await fs.lstat(p)).size;
  }
  return n;
}

async function pruneEmpty(dir: string, keepSelf: boolean): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) { if (keepSelf) await fs.mkdir(dir, { recursive: true }); return; }
  for (const e of entries) if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name), false);
  if (!keepSelf && (await fs.readdir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
}

/** 99-cache 里要留的：写稿读的口播转写（转写清单 + 旁边的 full.json，见 draft/transcripts.ts），都是小文本 */
const TRANSCRIPT_MANIFEST = "transcription-manifest.json";
const KEEP_NEXT_TO_MANIFEST = new Set([TRANSCRIPT_MANIFEST, "full.json"]);

/** 删掉目录下除转写之外的文件，返回删掉的字节数；删空的子目录一并清掉 */
async function purgeCacheDir(dir: string, projectRoot: string, recorded: Set<string>): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => { if (isMissing(e)) return null; throw e; });
  if (!entries) return 0;
  const hasManifest = entries.some((e) => e.isFile() && e.name === TRANSCRIPT_MANIFEST);
  let freed = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { freed += await purgeCacheDir(p, projectRoot, recorded); continue; }
    if (hasManifest && KEEP_NEXT_TO_MANIFEST.has(e.name)) continue;
    // 制作记录里原地登记过的文件可能是唯一一份，不当缓存删
    if (recorded.has(path.relative(projectRoot, p).split(path.sep).join("/"))) continue;
    freed += (await fs.lstat(p)).size;
    await fs.rm(p, { force: true });
  }
  if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
  return freed;
}

/** 归档后清 99-cache：成片和素材已在 NAS 上核对过，这里只剩可重建的中间产物（渲染、抽音频）；口播转写留着给写稿用 */
async function purgeProjectCache(projectRoot: string, recorded: Set<string>): Promise<number> {
  const dir = path.join(projectRoot, PROJECT_CACHE_DIR);
  const st = await fs.lstat(dir).catch((e) => { if (isMissing(e)) return null; throw e; });
  // 缓存根是符号链接（指到项目外）就不跟进去删：只清项目自己的目录；子项里的链接只删链接本身
  if (!st || !st.isDirectory()) return 0;
  return purgeCacheDir(dir, projectRoot, recorded);
}

async function archiveOne(c: Content, archiveRoot: string, ctx: Ctx): Promise<ArchivedItem> {
  const projectRoot = resolveContentProject(c.id, ctx.data)!.project_root;
  const target = archiveTarget(archiveRoot, c, projectRoot);
  await assertTargetOutsideSource(target, [projectRoot, ctx.lib]);
  const recorded = await recordedRels(c.id, ctx.data, projectRoot);
  const skip = rebuildableExcept(recorded);
  const { files: listed } = await walkProject(projectRoot, skip);
  const size = listed.reduce((n, f) => n + f.size, 0), free = await ctx.free(archiveRoot);
  if (free < size + ctx.margin) {
    throw new Error(`NAS 空间不够（要 ${formatBytes(size)} + 预留 ${formatBytes(ctx.margin)}，剩 ${formatBytes(free)}），这次跳过`);
  }
  // 逐文件核对 NAS（发布时已备份的，这里只是核对；缺或不一致先补拷），全部对上才删本机
  // 可重建的（99-cache、node_modules、review-preview）不搬上 NAS、不挡归档；素材核对删完后一并清掉
  const { files, errors } = await copyProject(projectRoot, target, ctx.copy, await deletableTops(projectRoot), { exclude: skip });
  if (errors.length) throw new Error(`复制或核对出错，本机一个文件都没删，下次重试：${errors.join("；")}`);
  await keepSmallFiles(projectRoot, c, files);
  await writeRecord(projectRoot, target, files, ctx.now);
  const { kept, rebuildableBytes } = await deleteMedia(projectRoot, files, recorded);
  const freedBytes = files.filter((f) => isMedia(f.rel)).reduce((n, f) => n + f.size, 0) + rebuildableBytes + await purgeProjectCache(projectRoot, recorded);
  if (kept) console.warn(`[nas-archive] ${c.title}：${kept} 个文件是核对之后才出现 / 被改过的，留在本机，下一轮再归档`);
  await appendArchiveLog(ctx.data, { contentId: c.id, title: c.title, target, freedBytes, archivedAt: ctx.now.toISOString() });
  return { title: c.title, target, freedBytes };
}

export interface ArchiveDecision {
  content: Content;
  /** archive = 这轮搬去 NAS；purge_cache = 早先已归档、只补清缓存；stay = 留在本机（why 说为什么） */
  action: "archive" | "purge_cache" | "stay";
  why?: string;
  projectRoot?: string;
}

/**
 * 归档判断（只读，不碰 NAS、不写资料库）：哪些搬、哪些留、为什么。归档本身和真数据演练共用这一份。
 * 返回 null = 整轮判断不了（读不出派生稿进度），一条都不归档。
 */
export async function planArchive(data: string, now: Date, children: Ctx["children"] = loadUnfinishedChildren): Promise<{ decisions: ArchiveDecision[]; errors: string[] }> {
  const decisions: ArchiveDecision[] = [], errors: string[] = [];
  // 本体稿按本轮发布时间判到点、定 NAS 月份；逐条读失败只跳过那一条
  const set = await publishedSet(await listContents(data), data);
  for (const { content, error } of set.errors) errors.push(`${content.title}（${content.id}）：读不了发布记录，这次跳过：${error}`);
  const { due, unknown } = archiveCandidates(set, now);
  for (const c of unknown) {
    errors.push(`${c.title}（${c.id}）：待确认发布时间（本轮没有可信的公开 / 定时时间），这次不归档`);
    decisions.push({ content: c, action: "stay", why: "待确认发布时间" });
  }
  const dueIds = new Set(due.map((c) => c.id));
  for (const c of set.published) if (c.publishedAt && !dueIds.has(c.id)) decisions.push({ content: c, action: "stay", why: "发布不满 24 小时" });
  if (!due.length) return { decisions, errors };
  // 主题分组读不出来就整轮不归档（判断不了派生稿做没做完，宁可不删）
  let open: Map<string, string[]>;
  try { open = await children(data, now); }
  catch (e) {
    errors.push(`读不出派生稿进度，这次不归档：${errMsg(e)}`);
    for (const c of due) decisions.push({ content: c, action: "stay", why: "读不出派生稿进度" });
    return { decisions, errors };
  }
  for (const c of due) {
    try {
      const kids = open.get(c.id);
      if (kids) { errors.push(`${c.title}（${c.id}）：这次不归档，派生稿还没发完：${kids.join("、")}`); decisions.push({ content: c, action: "stay", why: `派生稿还没发完：${kids.join("、")}` }); continue; }
      const binding = resolveContentProject(c.id, data);
      const busy = binding ? await busyInProduction(c.id, data, now) : null;
      if (busy) { errors.push(`${c.title}（${c.id}）：这次不归档，${busy}`); decisions.push({ content: c, action: "stay", why: busy }); continue; }
      if (!binding) { decisions.push({ content: c, action: "stay", why: "没有项目目录" }); continue; }
      const archived = await isArchived(binding.project_root);
      decisions.push({ content: c, action: archived ? "purge_cache" : "archive", projectRoot: binding.project_root, ...(archived ? { why: "早先已归档" } : {}) });
    } catch (e) { errors.push(`${c.title}（${c.id}）：${errMsg(e)}`); decisions.push({ content: c, action: "stay", why: errMsg(e) }); }
  }
  return { decisions, errors };
}

/** 最后一次动静：稿件改动时间与制作记录里最新事实的时间取晚的 */
async function lastActivity(c: Content, data: string): Promise<number> {
  // 读不出制作记录就抛错：判断不了最近有没有动静，这条不清（调用方记错误）
  const doc = await readProductionDoc(c.id, data);
  const times = [Date.parse(c.updatedAt), ...(doc?.facts ?? []).map((f) => Date.parse(f.at))].filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : Number.NaN;
}

/**
 * 每天清已发布稿的 99-cache，不看 NAS（没配 NAS 的用户也清）：在「已发布」栏、没有未完成的文件事务、
 * 24 小时内没有新事实或改动。只读判断，不碰文件。
 */
export async function planCachePurge(data: string, now: Date): Promise<{ purge: Array<{ content: Content; projectRoot: string }>; errors: string[] }> {
  const purge: Array<{ content: Content; projectRoot: string }> = [], errors: string[] = [];
  const set = await publishedSet(await listContents(data), data);
  for (const c of set.published) {
    try {
      const binding = resolveContentProject(c.id, data);
      if (!binding) continue;
      if (await busyInProduction(c.id, data, now)) continue;
      const last = await lastActivity(c, data);
      if (Number.isNaN(last) || now.getTime() - last < CACHE_IDLE_MS) continue;
      purge.push({ content: c, projectRoot: binding.project_root });
    } catch (e) { errors.push(`${c.title}（${c.id}）：清缓存判断出错：${errMsg(e)}`); }
  }
  return { purge, errors };
}

async function purgeIdleCaches(ctx: Ctx, report: ArchiveReport): Promise<void> {
  const { purge, errors } = await planCachePurge(ctx.data, ctx.now);
  report.errors.push(...errors);
  for (const { content, projectRoot } of purge) {
    try {
      const freedBytes = await purgeProjectCache(projectRoot, await recordedRels(content.id, ctx.data, projectRoot));
      if (freedBytes > 0) (report.cacheFreed ??= []).push({ title: content.title, target: projectRoot, freedBytes });
    } catch (e) { report.errors.push(`${content.title}（${content.id}）：清缓存出错：${errMsg(e)}`); }
  }
}

async function pendingItems(ctx: Ctx, report: ArchiveReport): Promise<Content[]> {
  const { decisions, errors } = await planArchive(ctx.data, ctx.now, ctx.children);
  report.errors.push(...errors);
  const out: Content[] = [];
  for (const d of decisions) {
    if (d.action === "archive") { out.push(d.content); continue; }
    if (d.action !== "purge_cache") continue;
    // 早先归档时还没清缓存的：这里补清，NAS 不在也能做（不碰 NAS）
    try {
      const freedBytes = await purgeProjectCache(d.projectRoot!, await recordedRels(d.content.id, ctx.data, d.projectRoot!));
      if (freedBytes > 0) (report.cacheFreed ??= []).push({ title: d.content.title, target: d.projectRoot!, freedBytes });
    } catch (e) { report.errors.push(`${d.content.title}（${d.content.id}）：${errMsg(e)}`); }
  }
  return out;
}

async function runArchive(archiveRoot: string, ctx: Ctx, report: ArchiveReport): Promise<void> {
  const items = await pendingItems(ctx, report);
  if (!items.length) return;
  if (!(await isReachable(archiveRoot))) {
    report.pending = items.length;
    report.errors.push(`NAS 未连接，有 ${items.length} 条待归档（${archiveRoot}）`);
    return;
  }
  for (const c of items) {
    try { report.archived.push(await archiveOne(c, archiveRoot, ctx)); }
    catch (e) { report.pending++; report.errors.push(`${c.title}（${c.id}）：${errMsg(e)}`); }
  }
}

export async function archivePublished(dataDir?: string, opts: ArchiveOptions = {}): Promise<ArchiveReport> {
  const report: ArchiveReport = { archived: [], pending: 0, errors: [] };
  if (!readLibraryLocation()) return { ...report, skipped: "没有配置资料库（旧版 ~/.autocrew），不做 NAS 归档" };
  const libRoot = getLibraryRoot();
  const data = dataDir ?? path.join(libRoot, "workspaces", "default");
  if (!readProjectRegistry(data)) return { ...report, skipped: "工作区还没有项目目录结构，不做 NAS 归档" };
  const ctx: Ctx = {
    data, lib: libRoot, root: path.join(libRoot, VIEW_DIR), now: opts.now ?? new Date(), copy: opts.copyImpl ?? ((s, d) => fs.copyFile(s, d)),
    free: opts.freeSpace ?? volumeFree, margin: opts.marginBytes ?? ARCHIVE_MARGIN_BYTES,
    children: opts.unfinishedChildren ?? loadUnfinishedChildren,
  };
  // 与 record 落位、重开文稿同排文件归属事务（本体 §7）：归档核验到删除之间不许有新文件搬进来
  try {
    const archiveRoot = opts.archiveRoot ?? readArchiveRoot();
    await withFileOwnership(async () => {
      // 清缓存不依赖 NAS：先清，再按需归档
      await purgeIdleCaches(ctx, report);
      // 没配归档目录不归档，但要写进错误区让人看见，不静默跳过
      if (!archiveRoot) report.errors.push(ARCHIVE_ROOT_UNSET);
      else await runArchive(archiveRoot, ctx, report);
    });
  } catch (e) { report.errors.push(`归档中断：${errMsg(e)}`); }
  await fs.mkdir(ctx.root, { recursive: true });
  await writeErrorSection(ctx.root, "archive", report.errors);
  return report;
}
