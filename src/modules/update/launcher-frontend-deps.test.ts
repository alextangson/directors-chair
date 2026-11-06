/**
 * 审查 10-30：照 README 首次安装（根目录 npm ci 不装前端依赖）第一次 start 必然起不来。
 * 启动器构建前先装前端依赖；装失败就停下、说清楚，不往下构建。
 * 用临时 ROOT（拷一份启动器，前端没有 node_modules / dist）+ PATH 里的假 npm 验证。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..", "..");
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-fe-deps-"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(path.join(REPO, "bin", "autocrew.mjs"), path.join(root, "bin", "autocrew.mjs"));
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(root, "package.json"));
  fs.mkdirSync(path.join(root, "frontend"));
  fs.writeFileSync(path.join(root, "frontend", "package.json"), "{}");
  fs.mkdirSync(path.join(root, "fakebin"));
  // 根目录依赖（启动器自己要用）照常在；缺的只是前端依赖
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fakeNpm(exitCode: number): void {
  const log = path.join(root, "npm-calls.log");
  fs.writeFileSync(path.join(root, "fakebin", "npm"), `#!/bin/sh\necho "$PWD|$*" >> "${log}"\nexit ${exitCode}\n`, { mode: 0o755 });
}

// 端口用一个肯定没人占的（真服务在 4317 上），启动器在构建之前不会去连它
const start = () => spawnSync(process.execPath, [path.join(root, "bin", "autocrew.mjs"), "start", "--no-open"], {
  env: { ...process.env, PATH: `${path.join(root, "fakebin")}:${process.env.PATH}`, AUTOCREW_LOCAL_DIR: path.join(root, "state"), AUTOCREW_UPDATER: "", AUTOCREW_PORT: "48731" },
  encoding: "utf-8", timeout: 30_000,
});

describe("启动器：缺前端依赖先装", () => {
  it("装失败：先在 frontend 跑 npm ci，失败就停下说原因，不往下构建", () => {
    fakeNpm(7);
    const r = start();
    const calls = fs.readFileSync(path.join(root, "npm-calls.log"), "utf-8").trim().split("\n");
    expect(calls[0]).toMatch(/frontend\|ci --prefer-offline --no-audit --no-fund$/);
    expect(calls.some((c) => c.includes("fe:build"))).toBe(false);
    expect(r.status).toBe(7);
    expect(`${r.stdout}${r.stderr}`).toContain("前端依赖没装上");
  });
});
