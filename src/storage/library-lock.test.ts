import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLibraryLock, machineId, provablyDead, WRITER_LOCK } from "./library-lock.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-lock-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const lockDir = () => path.join(root, WRITER_LOCK);
function staleLock(owner: Record<string, unknown>): void {
  fs.mkdirSync(lockDir());
  fs.writeFileSync(path.join(lockDir(), "owner.json"), JSON.stringify({ host: "old-host", nonce: "old-nonce", startedAt: "2026-10-01T00:00:00Z", ...owner }));
}
const esrch = () => { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; };
const alive = () => undefined;

describe("资料库写锁的陈旧接管（审查 10-30）", () => {
  const me = machineId();

  it.runIf(me)("同一台机器、原进程已不在：接管，新锁写的是自己", () => {
    staleLock({ machine: me, pid: 999_999, start: 1 });
    const release = acquireLibraryLock(root, { kill: esrch });
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir(), "owner.json"), "utf8"));
    expect(owner.pid).toBe(process.pid);
    expect(fs.readdirSync(root).filter((n) => n.includes("reclaimed"))).toEqual([]);
    release();
  });

  it.runIf(me)("pid 还在但启动时刻对不上（pid 被复用）：接管", () => {
    staleLock({ machine: me, pid: 4242, start: 1000 });
    acquireLibraryLock(root, { kill: alive, start: () => 5000 })();
  });

  it.runIf(me)("原进程还活着：不接管", () => {
    staleLock({ machine: me, pid: 4242, start: 1000 });
    expect(() => acquireLibraryLock(root, { kill: alive, start: () => 1000 })).toThrow(/占用/);
  });

  it.runIf(me)("查不到启动时刻（ps 失败）：当它活着，不接管", () => {
    staleLock({ machine: me, pid: 4242, start: 1000 });
    expect(() => acquireLibraryLock(root, { kill: alive, start: () => null })).toThrow(/占用/);
  });

  it.runIf(me)("[Codex P1] 判定陈旧之后锁被别人接管了：不挪别人的新锁", () => {
    staleLock({ machine: me, pid: 999_999, start: 1 });
    const takeover = () => {
      // 判定途中另一个进程完成了接管：锁目录还在，但已经是它的新锁
      fs.writeFileSync(path.join(lockDir(), "owner.json"), JSON.stringify({ host: "h", nonce: "someone-else", pid: 4242, machine: me, start: 9 }));
      esrch();
    };
    expect(() => acquireLibraryLock(root, { kill: takeover })).toThrow(/占用/);
    expect(JSON.parse(fs.readFileSync(path.join(lockDir(), "owner.json"), "utf8")).nonce).toBe("someone-else");
  });

  it.runIf(me)("别的进程正在接管（互斥目录在）：这一轮不接管", () => {
    staleLock({ machine: me, pid: 999_999, start: 1 });
    fs.mkdirSync(`${lockDir()}.reclaiming`);
    expect(() => acquireLibraryLock(root, { kill: esrch })).toThrow(/占用/);
    expect(JSON.parse(fs.readFileSync(path.join(lockDir(), "owner.json"), "utf8")).nonce).toBe("old-nonce");
  });

  it("别的机器的锁：永不接管", () => {
    staleLock({ machine: "another-machine", pid: 999_999, start: 1 });
    expect(() => acquireLibraryLock(root, { kill: esrch })).toThrow(/old-host/);
  });

  it("旧格式（没有 machine / start）：不接管，不写兼容分支", () => {
    staleLock({ pid: 999_999 });
    expect(() => acquireLibraryLock(root, { kill: esrch })).toThrow(/占用/);
    expect(JSON.parse(fs.readFileSync(path.join(lockDir(), "owner.json"), "utf8")).nonce).toBe("old-nonce");
  });

  it("provablyDead：kill 报 EPERM 不算死", () => {
    const eperm = () => { const e = new Error("perm") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; };
    expect(provablyDead({ pid: 1, start: 1 }, { kill: eperm })).toBe(false);
  });
});
