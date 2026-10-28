import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, videoContent, type Env } from "../modules/production/testkit.js";
import { writePolicy } from "../modules/derivative-dispatch/store.js";
import { notifyDerivativeChange, notifyDerivativePolicyChange } from "../modules/derivative-dispatch/events.js";
import { activeWorkCount, resetActiveWork } from "../modules/update/active-work.js";
import { acquireLock, releaseLock } from "../modules/update/preflight.js";
import { startDerivativeDispatchCycle } from "./derivative-dispatch-cycle.js";

let env: Env;
let other: Env | undefined;
const stops: Array<() => void> = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("等待调度周期超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const idle = () => until(() => activeWorkCount() === 0);

beforeEach(async () => {
  env = await makeEnv();
  vi.stubEnv("AUTOCREW_LOCAL_DIR", env.outside);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await idle();
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetActiveWork();
  await other?.cleanup(); other = undefined;
  await env.cleanup();
});

function start(options: Parameters<typeof startDerivativeDispatchCycle>[0]) {
  const stop = startDerivativeDispatchCycle(options); stops.push(stop); return stop;
}
const enable = (dir = env.dir) => writePolicy({ enabled: true, host: "codex" }, dir);

describe("后台派生周期", () => {
  it("默认关闭不调用派生，开启事件才开始扫描", async () => {
    const source = await videoContent(env, "默认关闭");
    const dispatch = vi.fn(async () => 0);
    const resolveDataDir = vi.fn(async () => env.dir);
    start({ resolveDataDir, dispatch, activeCount: () => 0, closeHost: async () => undefined });
    await idle();
    notifyDerivativeChange(source.id, env.dir);
    await new Promise((resolve) => setTimeout(resolve, 10)); await idle();
    expect(dispatch).not.toHaveBeenCalled();
    await enable(); notifyDerivativePolicyChange(env.dir);
    await until(() => dispatch.mock.calls.length === 1); await idle();
    expect(dispatch).toHaveBeenCalledWith(source.id, env.dir, 2);
  });

  it("只处理当前工作区，切换后扫描新工作区而不执行旧队列", async () => {
    const a = await videoContent(env, "工作区甲"); await enable();
    other = await makeEnv();
    const b = await videoContent(other, "工作区乙"); await enable(other.dir);
    let current = env.dir;
    const dispatch = vi.fn(async () => 0);
    start({ resolveDataDir: async () => current, dispatch, activeCount: () => 0, closeHost: async () => undefined });
    await until(() => dispatch.mock.calls.length === 1); await idle();
    current = other.dir;
    notifyDerivativeChange(a.id, env.dir); notifyDerivativePolicyChange(other.dir);
    await until(() => dispatch.mock.calls.length === 2); await idle();
    expect(dispatch.mock.calls).toEqual([[a.id, env.dir, 2], [b.id, other.dir, 2]]);
  });

  it("即使 ACK 不明返回 0，后续源也必须重读活跃数，不能超过两个", async () => {
    await Promise.all([videoContent(env, "容量甲"), videoContent(env, "容量乙"), videoContent(env, "容量丙")]); await enable();
    let active = 0, launched = 0;
    const dispatch = vi.fn(async (_id: string, _dir: string, limit?: number) => { launched += limit ?? 0; active += limit ?? 0; return 0; });
    start({ resolveDataDir: async () => env.dir, dispatch, activeCount: () => active, closeHost: async () => undefined });
    await until(() => dispatch.mock.calls.length === 3); await idle();
    expect(dispatch.mock.calls.map((call) => call[2])).toEqual([2, 0, 0]);
    expect(launched).toBe(2);
  });

  it("扫描之后切换工作区，执行前重新核对并转去新工作区", async () => {
    const a = await videoContent(env, "扫描后的旧工作区"); await enable();
    other = await makeEnv();
    const b = await videoContent(other, "扫描后的新工作区"); await enable(other.dir);
    const dispatch = vi.fn(async () => 0);
    let reads = 0;
    start({ resolveDataDir: async () => ++reads === 1 ? env.dir : other!.dir, dispatch, activeCount: () => 0, closeHost: async () => undefined });
    await until(() => dispatch.mock.calls.length === 1); await idle();
    expect(dispatch.mock.calls[0]).toEqual([b.id, other.dir, 2]);
    expect(dispatch.mock.calls.some((call) => call[0] === a.id)).toBe(false);
  });

  it("已有两个活跃会话时只允许 limit=0 的对账，不启动新任务", async () => {
    await videoContent(env, "已有活跃会话"); await enable();
    const dispatch = vi.fn(async () => 0);
    start({ resolveDataDir: async () => env.dir, dispatch, activeCount: () => 2, closeHost: async () => undefined });
    await until(() => dispatch.mock.calls.length === 1); await idle();
    expect(dispatch.mock.calls[0]).toEqual([expect.any(String), env.dir, 0]);
  });

  it("更新锁阻止启动，释放后由定时扫描补漏", async () => {
    await videoContent(env, "更新期间不启动"); await enable();
    const dispatch = vi.fn(async () => 0);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(acquireLock(env.outside, "cycle-update")).toBe(true);
    start({ resolveDataDir: async () => env.dir, dispatch, activeCount: () => 0, closeHost: async () => undefined, intervalMs: 10_000 });
    await idle(); expect(dispatch).not.toHaveBeenCalled();
    releaseLock(env.outside, "cycle-update");
    vi.advanceTimersByTime(10_000);
    await until(() => dispatch.mock.calls.length === 1); await idle();
  });

  it("stop 发生在工作区读取期间，不再调用派生，且只关闭宿主一次", async () => {
    await videoContent(env, "停止读取窗口"); await enable();
    const gate = deferred<string>();
    const dispatch = vi.fn(async () => 0), closeHost = vi.fn(async () => undefined);
    const stop = start({ resolveDataDir: () => gate.promise, dispatch, activeCount: () => 0, closeHost });
    stop(); stop();
    gate.resolve(env.dir);
    await until(() => closeHost.mock.calls.length === 1); await idle();
    notifyDerivativePolicyChange(env.dir); vi.advanceTimersByTime(60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dispatch).not.toHaveBeenCalled(); expect(closeHost).toHaveBeenCalledTimes(1);
  });

  it("在途派生结束后才关闭宿主，停止后不再分配后续源", async () => {
    await videoContent(env, "停止派生窗口甲"); await videoContent(env, "停止派生窗口乙"); await enable();
    const gate = deferred<number>();
    const dispatch = vi.fn(async () => gate.promise), closeHost = vi.fn(async () => undefined);
    const stop = start({ resolveDataDir: async () => env.dir, dispatch, activeCount: () => 0, closeHost });
    await until(() => dispatch.mock.calls.length === 1);
    stop(); expect(closeHost).not.toHaveBeenCalled();
    gate.resolve(1);
    await until(() => closeHost.mock.calls.length === 1); await idle();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("执行期间重复的同源事件会立即补跑，不被完成时删除吞掉", async () => {
    const source = await videoContent(env, "同源并发事件"); await enable();
    const gate = deferred<number>();
    const dispatch = vi.fn(async () => dispatch.mock.calls.length === 1 ? gate.promise : 0);
    start({ resolveDataDir: async () => env.dir, dispatch, activeCount: () => 0, closeHost: async () => undefined });
    await until(() => dispatch.mock.calls.length === 1);
    notifyDerivativeChange(source.id, env.dir); notifyDerivativeChange(source.id, env.dir);
    await new Promise((resolve) => setTimeout(resolve, 5)); gate.resolve(0);
    await until(() => dispatch.mock.calls.length === 2); await idle();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("并发的全量扫描事件不会丢失后来出现的新源", async () => {
    await videoContent(env, "并发扫描甲"); await enable();
    const gate = deferred<number>();
    const dispatch = vi.fn(async () => dispatch.mock.calls.length === 1 ? gate.promise : 0);
    start({ resolveDataDir: async () => env.dir, dispatch, activeCount: () => 0, closeHost: async () => undefined });
    await until(() => dispatch.mock.calls.length === 1);
    const added = await videoContent(env, "并发扫描乙");
    notifyDerivativePolicyChange(env.dir);
    await new Promise((resolve) => setTimeout(resolve, 5)); gate.resolve(0);
    await until(() => dispatch.mock.calls.some((call) => call[0] === added.id)); await idle();
    expect(dispatch.mock.calls.some((call) => call[0] === added.id)).toBe(true);
  });
});
