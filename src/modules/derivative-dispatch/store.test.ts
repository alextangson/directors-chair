import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentFile } from "../../storage/content-project.js";
import { getConfigDir } from "../../storage/storage-roots.js";
import { makeEnv, videoContent, type Env } from "../production/testkit.js";
import { mutateOutbox, readOutbox, readPolicy, writePolicy } from "./store.js";
import type { DispatchJob } from "./types.js";

let env: Env;
let id: string;
const NOW = new Date("2026-10-28T12:00:00+08:00");
beforeEach(async () => { env = await makeEnv(); id = (await videoContent(env, "调度存储测试")).id; });
afterEach(async () => { await env.cleanup(); });

function job(index = 1): DispatchJob {
  return { id: `job-${index}`, sourceId: id, sourceTitle: "测试", round: 1, sourceCutHash: "sha256:abc", kind: "wechat_article",
    targetPlatforms: ["wechat_mp"], requiredZhPlatforms: ["douyin"], receiptRefs: [], policyId: "policy-1", host: "codex",
    state: "queued", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
}

describe("派生调度持久存储", () => {
  it("缺配置默认关闭，重复启用不重置时间，重新启用才换授权代次", async () => {
    expect(await readPolicy(env.dir)).toMatchObject({ enabled: false, host: "codex" });
    const enabled = await writePolicy({ enabled: true, host: "codex" }, env.dir, NOW);
    expect(enabled).toMatchObject({ enabled: true, enabledAt: NOW.toISOString() });
    expect(await writePolicy({ enabled: true, host: "codex" }, env.dir, new Date(NOW.getTime() + 1000))).toEqual(enabled);
    await writePolicy({ enabled: false, host: "codex" }, env.dir, new Date(NOW.getTime() + 2000));
    const again = await writePolicy({ enabled: true, host: "codex" }, env.dir, new Date(NOW.getTime() + 3000));
    expect(again.id).not.toBe(enabled.id);
    expect(again.enabledAt).toBe(new Date(NOW.getTime() + 3000).toISOString());
  });

  it("并发原子更新没有丢任务，空更新不增加 revision", async () => {
    expect(await readOutbox(id, env.dir)).toEqual({ version: 1, revision: 0, jobs: [] });
    await Promise.all(Array.from({ length: 12 }, (_, index) => mutateOutbox(id, env.dir, (box) => { box.jobs.push(job(index)); })));
    const box = await readOutbox(id, env.dir);
    expect(box.jobs).toHaveLength(12);
    expect(box.revision).toBe(12);
    expect(await mutateOutbox(id, env.dir, () => undefined)).toEqual(box);
  });

  it("失败更新不覆盖原任务，重读保留真实会话 ID", async () => {
    await mutateOutbox(id, env.dir, (box) => { box.jobs.push({ ...job(), state: "started", session: { threadId: "native-thread-1", turnId: "turn-1" }, derivedContentId: "derived-1" }); });
    const before = await readOutbox(id, env.dir);
    await expect(mutateOutbox(id, env.dir, (box) => { box.jobs = []; throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    expect(await readOutbox(id, env.dir)).toEqual(before);
  });

  it.each(["{broken", JSON.stringify({ version: 1, revision: 1, jobs: [{ id: "old-thread-record", session: { threadId: "keep-me" } }] })])("损坏 outbox 必须报错，不清除已有字节或线程记录", async (raw) => {
    const file = contentFile(id, env.dir, "derivative-outbox.json");
    await fs.writeFile(file, raw);
    await expect(readOutbox(id, env.dir)).rejects.toThrow("派生任务读不出来");
    await expect(mutateOutbox(id, env.dir, (box) => { box.jobs = []; })).rejects.toThrow("派生任务读不出来");
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it("损坏配置不能被一次设置请求覆盖成默认配置", async () => {
    const file = path.join(getConfigDir(env.dir), "derivative-dispatch.json");
    await fs.writeFile(file, "{bad-policy");
    await expect(readPolicy(env.dir)).rejects.toThrow("派生调度配置读不出来");
    await expect(writePolicy({ enabled: true, host: "codex" }, env.dir)).rejects.toThrow("派生调度配置读不出来");
    expect(await fs.readFile(file, "utf8")).toBe("{bad-policy");
  });
});
