import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv, videoContent, type Env } from "../production/testkit.js";
import { mutateOutbox, writePolicy } from "./store.js";
import { createDispatchWorker } from "./worker.js";
import type { CodexHostAdapter, DispatchJob, EligibleSource } from "./types.js";

let env: Env;
let sourceId: string;
beforeEach(async () => { env = await makeEnv({ enabled: true }); sourceId = (await videoContent(env, "恢复窗口隔离测试")).id; });
afterEach(async () => { await env.cleanup(); });

describe("派生 worker 独立复核", () => {
  it("inspect 期间来源失效，不能再向原会话提交继续消息", async () => {
    const policy = await writePolicy({ enabled: true, host: "codex" }, env.dir);
    const stamp = new Date().toISOString();
    const value: EligibleSource = { sourceId, sourceTitle: "恢复测试", round: 1, sourceCutHash: "sha256:test", requiredZhPlatforms: ["douyin"], receiptRefs: [], intents: [{ kind: "wechat_article", targetPlatforms: ["wechat_mp"] }] };
    const job: DispatchJob = { id: "resume-review", sourceId, sourceTitle: value.sourceTitle, round: value.round, sourceCutHash: value.sourceCutHash,
      kind: "wechat_article", targetPlatforms: ["wechat_mp"], requiredZhPlatforms: ["douyin"], receiptRefs: [], policyId: policy.id, host: "codex",
      state: "started", createdAt: stamp, updatedAt: stamp, derivedContentId: "derived-review", session: { threadId: "native-review", turnId: "old-turn" } };
    await mutateOutbox(sourceId, env.dir, (box) => { box.jobs.push(job); });
    let valid = true;
    const resume = vi.fn(async () => ({ status: "started" as const, session: { threadId: "native-review", turnId: "new-turn" } }));
    const adapter: CodexHostAdapter = {
      capability: async () => ({ ok: true }), lookup: async () => [],
      start: async () => { throw new Error("unexpected create"); },
      inspect: async () => { valid = false; return { threadId: "native-review", status: "idle", turns: [] }; },
      resume, activeCount: () => 0, close: async () => undefined,
    };
    const worker = createDispatchWorker({ adapter: () => adapter, evaluate: async () => valid ? { ok: true, value } : { ok: false, code: "source_changed", error: "来源已重开" } });
    await expect(worker.resume(sourceId, job.id, env.dir)).rejects.toThrow("来源已重开");
    expect(resume).not.toHaveBeenCalled();
  });
});
