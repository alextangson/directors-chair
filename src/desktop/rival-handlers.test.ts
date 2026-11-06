import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rivalSettingsGetHandler, rivalSettingsSetHandler } from "./rival-handlers.js";
import { rivalSettingsPath } from "../modules/draft/rival-settings.js";
import { rivalKey } from "../modules/draft/rival-gemini.js";
import { saveCoverSettings } from "../modules/cover/provider.js";

let dir: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rivalhandlers-"));
  savedEnv = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnv;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("rival settings", () => {
  it("set writes rival.json with mode 0600 and get returns only the mask", async () => {
    const raw = "AIzaSECRET-rival-key-9876";
    expect(await rivalSettingsSetHandler({ _dataDir: dir, gemini_api_key: ` ${raw} ` })).toEqual({ ok: true });
    const stat = await fs.stat(rivalSettingsPath(dir));
    expect(stat.mode & 0o777).toBe(0o600);
    const r = await rivalSettingsGetHandler({ _dataDir: dir });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ configured: true, apiKeyMasked: "AIza…9876", source: "file" });
    expect(JSON.stringify(r)).not.toContain(raw);
  });

  it("set rejects empty or non-string keys and writes nothing", async () => {
    for (const v of ["", "   ", 123, undefined]) {
      const r = await rivalSettingsSetHandler({ _dataDir: dir, gemini_api_key: v });
      expect(r.ok).toBe(false);
    }
    await expect(fs.access(rivalSettingsPath(dir))).rejects.toThrow();
    const g = await rivalSettingsGetHandler({ _dataDir: dir });
    expect(g.data).toMatchObject({ configured: false, apiKeyMasked: null, source: "none" });
  });

  it("rivalKey: env beats file; get reports env source", async () => {
    await rivalSettingsSetHandler({ _dataDir: dir, gemini_api_key: "file-key-123456" });
    expect(await rivalKey(dir)).toBe("file-key-123456");
    process.env.GEMINI_API_KEY = "env-key-abcdefg";
    expect(await rivalKey(dir)).toBe("env-key-abcdefg");
    expect((await rivalSettingsGetHandler({ _dataDir: dir })).data).toMatchObject({ source: "env" });
  });

  it("rivalKey ignores a key that only lives in cover.json", async () => {
    await saveCoverSettings({ geminiApiKey: "cover-only-key-xyz" }, dir);
    expect(await rivalKey(dir)).toBeNull();
  });
});
