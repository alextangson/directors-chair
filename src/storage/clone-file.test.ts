import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloneFile } from "./clone-file.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-clone-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("cloneFile", () => {
  it("内容相同、两份互不影响，不留临时文件", async () => {
    const src = path.join(dir, "成片.mp4"), dst = path.join(dir, "副本.mp4");
    await fs.writeFile(src, "bytes");
    await cloneFile(src, dst);
    expect(await fs.readFile(dst, "utf8")).toBe("bytes");
    await fs.writeFile(dst, "changed");
    expect(await fs.readFile(src, "utf8")).toBe("bytes");
    expect((await fs.readdir(dir)).sort()).toEqual(["副本.mp4", "成片.mp4"]);
  });

  it("目标已存在就报 EEXIST，不覆盖", async () => {
    const src = path.join(dir, "a"), dst = path.join(dir, "b");
    await fs.writeFile(src, "new");
    await fs.writeFile(dst, "old");
    await expect(cloneFile(src, dst)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(dst, "utf8")).toBe("old");
    expect((await fs.readdir(dir)).sort()).toEqual(["a", "b"]);
  });

  it.runIf(process.platform === "darwin")("macOS 上走 clonefile：克隆保留源文件的修改时间（整份复制不会）", async () => {
    const src = path.join(dir, "a"), dst = path.join(dir, "b");
    await fs.writeFile(src, "x");
    const old = new Date(Date.now() - 86_400_000);
    await fs.utimes(src, old, old);
    await cloneFile(src, dst);
    expect(Math.round((await fs.stat(dst)).mtimeMs / 1000)).toBe(Math.round(old.getTime() / 1000));
  });
});
