/** Independent worker boundary review. Fake host/RPC only; no native sessions. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDispatchWorker } from "./worker.js";
import { dispatchFixture, receipts } from "./testkit.js";
import { mutateOutbox, readOutbox, writePolicy } from "./store.js";
import { createCodexAdapter } from "./codex-host.js";
import type { CodexRpc } from "./codex-client.js";
import type { CodexHostAdapter, DispatchJob, EligibleSource, LaunchResult } from "./types.js";

let f: Awaited<ReturnType<typeof dispatchFixture>>;
const hosts: CodexHostAdapter[] = [];
beforeEach(async () => { f = await dispatchFixture(); await writePolicy({ enabled: true, host: "codex" }, f.env.dir, new Date(Date.now() - 1000)); await receipts(f.env, f.source); });
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.close())); await f.env.cleanup(); });

function host(extra: Partial<CodexHostAdapter> = {}): CodexHostAdapter {
  return { capability: async () => ({ ok: true }), lookup: async () => [], inspect: async (threadId) => ({ threadId, status: "idle", turns: [] }),
    start: async () => { throw new Error("unexpected creation"); }, resume: async (threadId) => ({ status: "started", session: { threadId, turnId: "new-turn" } }), activeCount: () => 0, close: async () => {}, ...extra };
}
async function seeded() {
  const at = new Date().toISOString();
  const policy = await import("./store.js").then((m) => m.readPolicy(f.env.dir));
  const value: EligibleSource = { sourceId: f.source.id, sourceTitle: "test", round: 1, sourceCutHash: "sha256:review", requiredZhPlatforms: ["douyin"], receiptRefs: [], intents: [{ kind: "wechat_article", targetPlatforms: ["wechat_mp"] }] };
  const job: DispatchJob = { id: "contract-job", sourceId: f.source.id, sourceTitle: "test", round: 1, sourceCutHash: value.sourceCutHash, kind: "wechat_article", targetPlatforms: ["wechat_mp"], requiredZhPlatforms: ["douyin"], receiptRefs: [], policyId: policy.id, host: "codex", state: "started", createdAt: at, updatedAt: at, derivedContentId: "derived-test", session: { threadId: "original-thread", turnId: "old-turn" } };
  await mutateOutbox(f.source.id, f.env.dir, (box) => { box.jobs.push(job); });
  return { value, job };
}

describe("worker ACK and attention contracts", () => {
  it("requires a real turn ACK for explicit resume before reporting started", async () => {
    const { value, job } = await seeded();
    const h = host({ resume: async (threadId): Promise<LaunchResult> => ({ status: "started", session: { threadId } }) });
    const result = await createDispatchWorker({ adapter: () => h, evaluate: async () => ({ ok: true, value }) }).resume(f.source.id, job.id, f.env.dir);
    expect(result.status).not.toBe("started");
    expect((await readOutbox(f.source.id, f.env.dir)).jobs[0].state).toBe("unknown");
  });
  it("returns an uncertain result to the caller when resume ACK names another thread", async () => {
    const { value, job } = await seeded();
    const h = host({ resume: async (): Promise<LaunchResult> => ({ status: "started", session: { threadId: "another-thread", turnId: "wrong-turn" } }) });
    const result = await createDispatchWorker({ adapter: () => h, evaluate: async () => ({ ok: true, value }) }).resume(f.source.id, job.id, f.env.dir);
    expect((await readOutbox(f.source.id, f.env.dir)).jobs[0]).toMatchObject({ state: "unknown", code: "session_ack_mismatch", session: { threadId: "original-thread" } });
    expect(result.status).not.toBe("started");
  });
  it("a later durable attention flag survives the normal start ACK", async () => {
    let worker: ReturnType<typeof createDispatchWorker>;
    const h = host({ start: async (input, onCreated) => {
      const threadId = `native-${input.jobId}`;
      await onCreated(threadId);
      await worker.attention(threadId, "需要人工批准，后台已停下");
      return { status: "started", session: { threadId, turnId: "accepted-turn" } };
    } });
    worker = createDispatchWorker({ adapter: () => h });
    const box = await worker.runSource(f.source.id, f.env.dir, false, 1);
    const row = box.jobs.find((j) => j.session?.threadId)!;
    expect(row).toMatchObject({ code: "host_needs_attention", reason: "需要人工批准，后台已停下" });
  });
  it("a later durable attention flag survives the resume ACK too", async () => {
    const { value, job } = await seeded();
    let worker: ReturnType<typeof createDispatchWorker>;
    const h = host({ resume: async (threadId) => {
      await worker.attention(threadId, "续办等待人工输入");
      return { status: "started", session: { threadId, turnId: "resumed-turn" } };
    } });
    worker = createDispatchWorker({ adapter: () => h, evaluate: async () => ({ ok: true, value }) });
    await worker.resume(f.source.id, job.id, f.env.dir);
    expect((await readOutbox(f.source.id, f.env.dir)).jobs[0]).toMatchObject({ code: "host_needs_attention", reason: "续办等待人工输入" });
  });
  it("recover preserves a host attention state read with the original kickoff", async () => {
    let prompt = "", threadId = "";
    const h = host({
      start: async (input, onCreated) => { prompt = input.prompt; threadId = `native-${input.jobId}`; await onCreated(threadId); return { status: "unknown", code: "ack_lost", error: "结果未知", threadId }; },
      inspect: async (id) => ({ threadId: id, status: "idle", needsAttention: "原会话需要人工批准", turns: [{ id: "original-kickoff", status: "completed", items: [{ type: "userMessage", text: prompt }] }] }),
    });
    await createDispatchWorker({ adapter: () => h }).runSource(f.source.id, f.env.dir, false, 1);
    const box = await createDispatchWorker({ adapter: () => h }).runSource(f.source.id, f.env.dir, false, 0);
    expect(box.jobs.find((j) => j.session?.threadId === threadId)).toMatchObject({ code: "host_needs_attention", reason: "原会话需要人工批准" });
  });
  it("recovery cannot overwrite a newer attempt created while history was being read", async () => {
    let prompt = "", jobId = "", threadId = "";
    const h = host({
      start: async (input, onCreated) => { prompt = input.prompt; jobId = input.jobId; threadId = `native-${jobId}`; await onCreated(threadId); return { status: "unknown", code: "ack_lost", error: "结果未知", threadId }; },
      inspect: async (id) => {
        await mutateOutbox(f.source.id, f.env.dir, (box) => {
          const row = box.jobs.find((j) => j.id === jobId)!;
          row.state = "dispatching"; row.attempt = { id: "newer-attempt", at: new Date().toISOString(), promptHash: "new-hash" };
        });
        return { threadId: id, status: "idle", turns: [{ id: "old-turn", status: "completed", items: [{ type: "userMessage", text: prompt }] }] };
      },
    });
    await createDispatchWorker({ adapter: () => h }).runSource(f.source.id, f.env.dir, false, 1);
    const box = await createDispatchWorker({ adapter: () => h }).runSource(f.source.id, f.env.dir, false, 0);
    expect(box.jobs.find((j) => j.id === jobId)).toMatchObject({ state: "dispatching", attempt: { id: "newer-attempt" } });
  });
  it("stops kickoff if policy is disabled while thread naming awaits RPC", async () => {
    const methods: string[] = [];
    let cwd = "";
    const rpc: CodexRpc = {
      closed: false,
      request: async (method, params = {}) => {
        methods.push(method);
        if (method === "initialize") return {};
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "config/read") return { config: { model_provider: "openai", model_providers: {} } };
        if (method === "thread/start") { cwd = String(params.cwd); return { thread: { id: "real-thread", cwd }, modelProvider: "openai" }; }
        if (method === "thread/name/set") { await writePolicy({ enabled: false, host: "codex" }, f.env.dir); return {}; }
        if (method === "turn/start") return { turn: { id: "stale-kickoff", status: "inProgress" } };
        throw new Error(method);
      },
      notify: () => {}, reply: () => {}, reject: () => {}, onNotification: () => () => {}, onServerRequest: () => () => {}, onClose: () => () => {}, close: async () => {},
    };
    const h = createCodexAdapter({ clientFactory: () => rpc, client: { env: { OPENAI_BASE_URL: "" } } }); hosts.push(h);
    await createDispatchWorker({ adapter: () => h }).runSource(f.source.id, f.env.dir, false, 1);
    expect(methods).not.toContain("turn/start");
  });
});
