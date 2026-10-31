import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { purgeMixAudio } from "./mix-audio-purge.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-mixpurge-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const put = async (rel: string, body = "x") => { await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), body); };
const exists = (rel: string) => fs.lstat(path.join(root, rel)).then(() => true, () => false);

describe("登记后清混音中间件", () => {
  it("删 99-cache/audio 下的音频，报告和执行记录留着，别的目录不动", async () => {
    await put("99-cache/audio/mix-v001/mix.flac", "aaaa");
    await put("99-cache/audio/mix-v001/voice.wav", "bb");
    await put("99-cache/audio/mix-v001/report.json", "{}");
    await put("99-cache/audio/mix-v001/build.md", "note");
    await put("05-audio/music/bed.mp3", "keep");
    expect(await purgeMixAudio(root, new Set())).toBe(6);
    expect(await exists("99-cache/audio/mix-v001/mix.flac")).toBe(false);
    expect(await exists("99-cache/audio/mix-v001/voice.wav")).toBe(false);
    expect(await exists("99-cache/audio/mix-v001/report.json")).toBe(true);
    expect(await exists("99-cache/audio/mix-v001/build.md")).toBe(true);
    expect(await exists("05-audio/music/bed.mp3")).toBe(true);
  });

  it("登记过的文件不删", async () => {
    await put("99-cache/audio/bed-final.flac", "only copy");
    await purgeMixAudio(root, new Set(["99-cache/audio/bed-final.flac"]));
    expect(await exists("99-cache/audio/bed-final.flac")).toBe(true);
  });

  it("缓存根是指到项目外的链接：不跟进去删", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-outside-"));
    await fs.writeFile(path.join(outside, "precious.wav"), "keep");
    await fs.mkdir(path.join(root, "99-cache"), { recursive: true });
    await fs.symlink(outside, path.join(root, "99-cache/audio"));
    expect(await purgeMixAudio(root, new Set())).toBe(0);
    expect(await fs.readFile(path.join(outside, "precious.wav"), "utf8")).toBe("keep");
    await fs.rm(outside, { recursive: true, force: true });
  });
});
