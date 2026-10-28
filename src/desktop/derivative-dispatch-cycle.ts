import { listContents } from "../storage/local-store.js";
import { isThemeRoot } from "../modules/theme/plan.js";
import { readPolicy } from "../modules/derivative-dispatch/store.js";
import { onDerivativeChange } from "../modules/derivative-dispatch/events.js";
import { closeDerivativeHost, derivativeActiveCount, dispatchSource } from "../modules/derivative-dispatch/service.js";
import { runUnlessUpdating } from "../modules/update/active-work.js";

export interface DerivativeCycleOptions {
  resolveDataDir(): Promise<string>;
  intervalMs?: number;
  dispatch?: typeof dispatchSource;
  activeCount?: () => number;
  closeHost?: () => Promise<void>;
  warn?: (message: string) => void;
}

export function startDerivativeDispatchCycle(options: DerivativeCycleOptions): () => void {
  let stopped = false, ticking = false, rerun = false, scanRequested = false, closing = false;
  const pending = new Map<string, { sourceId: string; dataDir: string }>();
  const report = options.warn ?? ((reason: string) => console.error(`[derivative-dispatch] ${reason}`));
  const execute = options.dispatch ?? dispatchSource;
  const active = options.activeCount ?? derivativeActiveCount;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await (options.closeHost ?? closeDerivativeHost)(); }
    catch (err) { report(`后台宿主关闭失败：${String(err)}`); }
  };
  const capacity = () => {
    const count = active();
    return Number.isFinite(count) ? Math.max(0, 2 - Math.max(0, count)) : 0;
  };
  const drain = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      do {
        rerun = false;
        const scan = scanRequested; scanRequested = false;
        await runUnlessUpdating("后台派生会话", async () => {
          if (stopped) return;
          const dataDir = await options.resolveDataDir();
          if (stopped || !(await readPolicy(dataDir)).enabled) return;
          if (scan) {
            const sources = await listContents(dataDir);
            if (stopped) return;
            for (const source of sources.filter((c) => isThemeRoot(c) && c.status !== "archived")) pending.set(`${dataDir}\0${source.id}`, { sourceId: source.id, dataDir });
          }
          let remaining = capacity();
          // Snapshot the batch. Events arriving during I/O stay queued for a coalesced follow-up pass.
          for (const [key, item] of [...pending]) {
            if (stopped) break;
            if (item.dataDir !== dataDir) { pending.delete(key); continue; }
            const currentDir = await options.resolveDataDir();
            if (stopped) break;
            if (currentDir !== dataDir) { scanRequested = true; rerun = true; break; }
            // Delete before dispatch so another event for this source cannot be swallowed by completion.
            pending.delete(key);
            try {
              const started = await execute(item.sourceId, item.dataDir, Math.min(remaining, capacity()));
              remaining = Math.max(0, remaining - Math.max(0, started));
            } catch (err) { report(`${item.sourceId}：${err instanceof Error ? err.message : String(err)}`); }
          }
        });
      } while (!stopped && rerun);
    } catch (err) { report(err instanceof Error ? err.message : String(err)); }
    finally { ticking = false; if (stopped) await close(); }
  };
  const tick = (scan: boolean) => {
    if (stopped) return;
    scanRequested ||= scan;
    rerun = true;
    void drain();
  };
  const off = onDerivativeChange((sourceId, dataDir) => {
    if (sourceId) pending.set(`${dataDir}\0${sourceId}`, { sourceId, dataDir });
    tick(sourceId === null);
  });
  const timer = setInterval(() => tick(true), Math.max(10_000, options.intervalMs ?? 60_000));
  timer.unref(); tick(true);
  return () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); off(); pending.clear();
    // Let an already-issued dispatch settle before closing the shared adapter. No later pass may reopen it.
    if (!ticking) void close();
  };
}
