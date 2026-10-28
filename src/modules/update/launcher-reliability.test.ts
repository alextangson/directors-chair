import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..", "..");
const CLI = path.join(REPO, "bin", "autocrew.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf-8")).version;
let dir: string, state: string, port: number;
const ownGroups = new Set<number>();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
}

function launcher(args: string[], extra: Record<string, string> = {}, cli = CLI) {
  const child = spawn(process.execPath, [cli, ...args, "--no-open"], {
    cwd: REPO, detached: true,
    env: { ...process.env, AUTOCREW_LOCAL_DIR: state, AUTOCREW_PORT: String(port), AUTOCREW_LAUNCH_TIMEOUT_MS: "5000", ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownGroups.add(child.pid!);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b; });
    child.stderr.on("data", (b) => { stderr += b; });
    child.on("error", reject);
    child.on("exit", (code) => { ownGroups.delete(child.pid!); resolve({ code, stdout, stderr }); });
  });
}

function fakeServer(delayMs = 100) {
  const file = path.join(dir, "fake-server.mjs");
  fs.writeFileSync(file, `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(path.join(process.env.AUTOCREW_LOCAL_DIR, "spawned"), process.pid + "\\n");
setTimeout(() => http.createServer((req, res) => {
  if (req.url === "/__autocrew/launch") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ nonce: process.env.AUTOCREW_LAUNCH_NONCE, via: "launcher" }));
  res.end("ok");
}).listen(Number(process.env.AUTOCREW_PORT), "127.0.0.1", () => console.log("http://127.0.0.1:" + process.env.AUTOCREW_PORT + "/?token=ab12")), ${delayMs});
`);
  return { AUTOCREW_SERVER_SCRIPT: file };
}

function rememberService() {
  const pid = Number(fs.readFileSync(path.join(state, "autocrew.pid"), "utf-8"));
  ownGroups.add(pid);
  return pid;
}

function unrelatedProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  ownGroups.add(child.pid!);
  return child;
}

/** 让真正的服务先监听，再让身份读取失败或继续；不会拦截测试进程自己的 ps。 */
function psAfterService(fail: boolean) {
  const shim = path.join(dir, "shim");
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, "ps"), `#!/bin/sh
i=0
while [ ! -f "$AUTOCREW_LOCAL_DIR/spawned" ] && [ "$i" -lt 100 ]; do
  sleep 0.02
  i=$((i + 1))
done
sleep 0.2
${fail ? "exit 1" : 'exec /bin/ps "$@"'}
`, { mode: 0o755 });
  return { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}` };
}

function rememberSpawned() {
  const pids = fs.readFileSync(path.join(state, "spawned"), "utf-8").trim().split("\n").map(Number);
  for (const pid of pids) ownGroups.add(pid);
  return pids;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  const cache = path.join(os.homedir(), ".cache", "autocrew-yt", "tests");
  fs.mkdirSync(cache, { recursive: true });
  dir = fs.mkdtempSync(path.join(cache, "launcher-reliability-"));
  state = path.join(dir, "state");
  port = await freePort();
});

afterEach(async () => {
  for (const pid of ownGroups) {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
  }
  ownGroups.clear();
  await sleep(50);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("launcher reliability regressions", () => {
  it.each(["--version", "-v"])("%s prints package version without starting or creating state", async (arg) => {
    const result = await launcher([arg], fakeServer());
    expect(result).toMatchObject({ code: 0, stdout: `${VERSION}\n`, stderr: "" });
    expect(fs.existsSync(state)).toBe(false);
  });

  it.each(["stop", "restart"])("%s refuses a live unrelated PID without sending a signal", async (command) => {
    const foreign = unrelatedProcess();
    let signal: string | null = null;
    foreign.on("exit", (_code, s) => { signal = s; });
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, "autocrew.pid"), String(foreign.pid));
    const result = await launcher([command], fakeServer());
    await sleep(50);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("无法确认");
    expect(alive(foreign.pid!)).toBe(true);
    expect(signal).toBeNull();
    expect(fs.existsSync(path.join(state, "spawned"))).toBe(false);
  });

  it("refuses a reused PID whose recorded start time no longer matches", async () => {
    const foreign = unrelatedProcess();
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, "autocrew.pid"), String(foreign.pid));
    fs.writeFileSync(path.join(state, "autocrew.process.json"), JSON.stringify({ pid: foreign.pid, start: 1, nonce: "a".repeat(32) }));
    const result = await launcher(["stop"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("无法确认");
    expect(alive(foreign.pid!)).toBe(true);
  });

  it("cleans the actual child when identity lookup fails, even if it ignores SIGTERM", async () => {
    const env = fakeServer();
    fs.writeFileSync(env.AUTOCREW_SERVER_SCRIPT, `process.on("SIGTERM", () => {});\n${fs.readFileSync(env.AUTOCREW_SERVER_SCRIPT, "utf-8")}`);
    const foreign = unrelatedProcess();
    const result = await launcher(["start"], { ...env, ...psAfterService(true) });
    const pids = rememberSpawned();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("无法核实新进程的启动时刻");
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    expect(alive(foreign.pid!)).toBe(true);
    expect(fs.existsSync(path.join(state, "autocrew.pid"))).toBe(false);
    expect(fs.existsSync(path.join(state, "autocrew.process.json"))).toBe(false);
    expect(fs.existsSync(path.join(state, "autocrew.launch"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 15_000);

  it.each(["autocrew.process.json", "autocrew.pid"])("cleans the actual child when writing %s fails", async (failedPath) => {
    fs.mkdirSync(path.join(state, failedPath), { recursive: true });
    fs.writeFileSync(path.join(state, failedPath, "preserve"), "existing data");
    const result = await launcher(["start"], { ...fakeServer(), ...psAfterService(false) });
    const pids = rememberSpawned();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("启动失败");
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    expect(fs.readFileSync(path.join(state, failedPath, "preserve"), "utf-8")).toBe("existing data");
    expect(fs.existsSync(path.join(state, failedPath === "autocrew.pid" ? "autocrew.process.json" : "autocrew.pid"))).toBe(false);
    expect(fs.existsSync(path.join(state, "autocrew.launch"))).toBe(false);
    expect(fs.readdirSync(state).some((name) => name.includes(".new-"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 15_000);

  it("stops an older launch only after verifying its private nonce in the target process", async () => {
    const env = fakeServer();
    expect((await launcher(["start"], env)).code).toBe(0);
    rememberService();
    fs.rmSync(path.join(state, "autocrew.process.json"));
    const result = await launcher(["stop"], env);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("已停止");
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 15_000);

  it("does not trust a matching HTTP nonce when the legacy PID points elsewhere", async () => {
    const env = fakeServer();
    expect((await launcher(["start"], env)).code).toBe(0);
    rememberService();
    const foreign = unrelatedProcess();
    fs.rmSync(path.join(state, "autocrew.process.json"));
    fs.writeFileSync(path.join(state, "autocrew.pid"), String(foreign.pid));
    const result = await launcher(["stop"], env);
    expect(result.code).toBe(1);
    expect(alive(foreign.pid!)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  }, 15_000);

  it("restarts an owned service with a new PID and launch generation", async () => {
    const env = fakeServer();
    expect((await launcher(["start"], env)).code).toBe(0);
    const previousPid = rememberService();
    const previousNonce = fs.readFileSync(path.join(state, "autocrew.launch"), "utf-8");
    const restarted = await launcher(["restart"], env);
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(rememberService()).not.toBe(previousPid);
    expect(fs.readFileSync(path.join(state, "autocrew.launch"), "utf-8")).not.toBe(previousNonce);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect((await launcher(["stop"], env)).code).toBe(0);
  }, 15_000);

  it("serializes concurrent starts into one live managed service, then stops it normally", async () => {
    const env = fakeServer(1200);
    const first = launcher(["start"], env);
    for (let i = 0; i < 150 && !fs.existsSync(path.join(state, "spawned")); i++) await sleep(20);
    expect(fs.existsSync(path.join(state, "spawned"))).toBe(true);
    const second = launcher(["start"], env);
    const results = await Promise.all([first, second]);
    rememberService();
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(results.map((r) => r.stdout).join("\n")).toContain("已在运行");
    expect(fs.readFileSync(path.join(state, "spawned"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    const record = JSON.parse(fs.readFileSync(path.join(state, "autocrew.process.json"), "utf-8"));
    expect(record.pid).toBe(Number(fs.readFileSync(path.join(state, "autocrew.pid"), "utf-8")));
    expect(record.nonce).toBe(fs.readFileSync(path.join(state, "autocrew.launch"), "utf-8").trim());
    const stopped = await launcher(["stop"], env);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(fs.existsSync(path.join(state, "autocrew.pid"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  }, 15_000);

  it("keeps the launch lock during a frontend build longer than the lock expiry", async () => {
    const install = path.join(dir, "install");
    for (const folder of ["bin", "scripts", "desktop", "frontend/dist"]) fs.mkdirSync(path.join(install, folder), { recursive: true });
    fs.copyFileSync(CLI, path.join(install, "bin/autocrew.mjs"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(install, "node_modules"), "dir");
    fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ type: "module", scripts: { "fe:build": "node build.mjs" } }));
    fs.writeFileSync(path.join(install, "scripts/storage.mts"), "process.exit(0);\n");
    fs.writeFileSync(path.join(install, "build.mjs"), `import fs from "node:fs";
fs.appendFileSync("builds", "build\\n");
setTimeout(() => fs.writeFileSync("frontend/dist/index.html", "ok"), 11_500);
`);
    const server = fs.readFileSync(fakeServer().AUTOCREW_SERVER_SCRIPT, "utf-8");
    fs.writeFileSync(path.join(install, "desktop/server.ts"), server);
    const cli = path.join(install, "bin/autocrew.mjs");
    const first = launcher(["start"], {}, cli);
    for (let i = 0; i < 200 && !fs.existsSync(path.join(install, "builds")); i++) await sleep(20);
    expect(fs.existsSync(path.join(install, "builds"))).toBe(true);
    const second = launcher(["start"], {}, cli);
    const results = await Promise.all([first, second]);
    rememberService();
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(install, "builds"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(state, "spawned"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    const stopped = await launcher(["stop"], {}, cli);
    expect(stopped.code, stopped.stderr).toBe(0);
  }, 25_000);
});
