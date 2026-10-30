import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLibraryLocation, assertLibraryAvailable } from "./storage-roots.js";
import { startEpoch } from "../modules/update/process-start.js";

interface Owner { host: string; pid: number; nonce: string; startedAt: string; machine?: string; start?: number }

let machineCache: string | null | undefined;
/**
 * 稳定的本机身份（硬件 UUID 的 sha256）：主机名会随网络变，不能拿来判断「是不是同一台机器」。
 * 读不到就是 null——没法证明同一台，就永远不接管。
 */
export function machineId(): string | null {
  if (machineCache !== undefined) return machineCache;
  let raw = "";
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
      raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? "";
    } else raw = readFileSync("/etc/machine-id", "utf8").trim();
  } catch { raw = ""; }
  machineCache = raw ? createHash("sha256").update(raw).digest("hex") : null;
  return machineCache;
}

/** 能证明持锁进程已经不在：pid 不存在，或 pid 在但启动时刻对不上（被复用）。查不清一律当它还活着 */
export function provablyDead(owner: Pick<Owner, "pid" | "start">, deps: { kill?: (pid: number) => void; start?: (pid: number) => number | null } = {}): boolean {
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 0));
  try { kill(owner.pid); }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  const now = (deps.start ?? startEpoch)(owner.pid);
  return now !== null && typeof owner.start === "number" && Math.abs(now - owner.start) > 1;
}

/**
 * 陈旧锁接管（Mac 重启、SIGKILL、断电留下的）：同一台机器、且能证明原进程已死才接管。
 * 先把旧目录改名挪开（并发接管者只有一个改名成功），核对挪开的就是刚才判定的那把，再删掉。
 * 旧格式（没有 machine / start）和别的机器的锁一律不接管。
 */
function reclaimStale(dir: string, old: Partial<Owner>, deps?: Parameters<typeof provablyDead>[1]): boolean {
  const me = machineId();
  if (!me || old.machine !== me || typeof old.pid !== "number" || typeof old.start !== "number" || !old.nonce) return false;
  if (!provablyDead({ pid: old.pid, start: old.start }, deps)) return false;
  const aside = `${dir}-reclaimed-${old.nonce}`;
  try { renameSync(dir, aside); } catch { return false; }
  try {
    const moved = JSON.parse(readFileSync(path.join(aside, "owner.json"), "utf8")) as Partial<Owner>;
    if (moved.nonce !== old.nonce) { renameSync(aside, dir); return false; }
  } catch { return false; }
  rmSync(aside, { recursive: true, force: true });
  console.warn(`[library-lock] 接管了上次异常退出留下的资料库写锁（${old.host} pid ${old.pid}，${old.startedAt}）`);
  return true;
}

export const WRITER_LOCK = ".autocrew-writer";
const held = new Map<string, string>();
/** A disconnected/replaced writer never regains authority merely because the NAS is back. */
export function assertLibraryWriter(root: string): void {
  const nonce = held.get(path.resolve(root));
  let owner: { nonce?: string; pid?: number };
  try { owner = JSON.parse(readFileSync(path.join(root, WRITER_LOCK, "owner.json"), "utf8")); }
  catch { throw new Error("library_writer_lost: 无有效资料库写入占用；请停止写入并检查原服务。"); }
  // 只核 nonce 和 pid（nonce 本进程随机生成，足够了）；主机名会随网络变，比它只会误报失去写入权
  if (!nonce || owner.nonce !== nonce || owner.pid !== process.pid) {
    throw new Error("library_writer_lost: 当前服务已失去资料库写入权；不会自动抢占。");
  }
}
/** mkdir is the cross-host exclusion primitive; never steal another host's lock. */
export function acquireLibraryLock(root?: string, deps?: Parameters<typeof provablyDead>[1]): () => void {
  const location = readLibraryLocation();
  if (!root && !location) return () => {};
  if (!root) assertLibraryAvailable(location);
  const dir = path.join(root ?? location!.root, WRITER_LOCK);
  const owner: Owner = {
    host: os.hostname(), pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString(),
    ...(machineId() ? { machine: machineId()! } : {}), ...(startEpoch(process.pid) !== null ? { start: startEpoch(process.pid)! } : {}),
  };
  try { mkdirSync(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let old: Partial<Owner>;
    try { old = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8")); }
    catch { throw new Error(`资料库正在被占用或占用记录不完整（${dir}）；请确认原服务已停止。`); }
    if (!reclaimStale(dir, old, deps)) {
      throw new Error(`资料库已被 ${old.host} 的导演椅（pid ${old.pid}）占用（${dir}）；若原进程异常退出，请先确认没有其他写入方，再清理占用记录。`);
    }
    try { mkdirSync(dir); }
    catch { throw new Error(`资料库写锁刚被别的进程占走（${dir}）`); }
  }
  writeFileSync(path.join(dir, "owner.json"), JSON.stringify(owner));
  held.set(path.resolve(root ?? location!.root), owner.nonce);
  return () => {
    const key = path.resolve(root ?? location!.root);
    if (held.get(key) === owner.nonce) held.delete(key);
    try {
      const current = JSON.parse(readFileSync(path.join(dir, "owner.json"), "utf8"));
      if (current.nonce === owner.nonce) {
        // Release the entire canonical lock in one rename. Deleting owner.json
        // first can leave an empty busy lock on SMB when shutdown is interrupted.
        const retired = `${dir}-released-${owner.nonce}`;
        renameSync(dir, retired);
        rmSync(retired, { recursive: true });
      }
    } catch { /* An unavailable NAS must never cause a replacement lock to be removed. */ }
  };
}

/** 服务进程占着的资料库写入权：启动时占一次；引导里当场建库后再占新库的（§7.3 建库立即生效）。退出时一起放。 */
const processReleases: Array<() => void> = [];
export function holdProcessLibraryLock(): void {
  processReleases.push(acquireLibraryLock());
}
export function releaseProcessLibraryLocks(): void {
  while (processReleases.length) processReleases.pop()!();
}
