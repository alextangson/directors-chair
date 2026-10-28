import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDispatchWorker } from "./worker.js";
import { dispatchFixture, receipts, ZH } from "./testkit.js";
import { readOutbox, writePolicy } from "./store.js";
import { getContent } from "../../storage/local-store.js";
import type { CodexHostAdapter, LaunchResult, RemoteThread, ThreadInspection } from "./types.js";

let fixture: Awaited<ReturnType<typeof dispatchFixture>>;
beforeEach(async () => { fixture = await dispatchFixture(); });
afterEach(async () => { await fixture.env.cleanup(); });

function fakeHost() {
  const threads = new Map<string, { cwd: string; view: ThreadInspection }>();
  const start = vi.fn<CodexHostAdapter["start"]>(async (input, onCreated) => {
    const id = `native-${input.jobId}`;
    threads.set(id, { cwd: input.cwd, view: { threadId: id, status: "idle", turns: [] } });
    await onCreated(id);
    const saved = (await readOutbox(fixture.source.id, fixture.env.dir)).jobs.find((j) => j.id === input.jobId);
    expect(saved).toMatchObject({ state: "dispatching", session: { threadId: id } });
    const turnId = `turn-${input.jobId}`;
    threads.get(id)!.view.turns.push({ id: turnId, status: "completed", items: [{ type: "userMessage", text: input.prompt }] });
    return { status: "started", session: { threadId: id, turnId, submittedAt: new Date().toISOString() } };
  });
  const resume = vi.fn<CodexHostAdapter["resume"]>(async (id) => ({ status: "started", session: { threadId: id, turnId: "resumed-turn", submittedAt: new Date().toISOString() } }));
  const host: CodexHostAdapter = {
    capability: vi.fn(async () => ({ ok: true, authMode: "chatgpt" })),
    lookup: vi.fn(async (cwd) => [...threads].filter(([, t]) => t.cwd === cwd).map(([id, t]): RemoteThread => ({ id, cwd: t.cwd }))),
    start, resume,
    inspect: vi.fn(async (id) => { const t = threads.get(id); if (!t) throw new Error("read unavailable"); return structuredClone(t.view); }),
    activeCount: () => 0,
    close: vi.fn(async () => undefined),
  };
  return { host, threads, start, resume };
}

async function ready() {
  await writePolicy({ enabled: true, host: "codex" }, fixture.env.dir, new Date(Date.now() - 1000));
  await receipts(fixture.env, fixture.source);
}

describe("durable derivative dispatch worker", () => {
  it("waits for every required Chinese platform", async () => {
    await writePolicy({ enabled: true, host: "codex" }, fixture.env.dir, new Date(Date.now() - 1000));
    await receipts(fixture.env, fixture.source, ZH.slice(0, 3));
    const h = fakeHost(), worker = createDispatchWorker({ adapter: () => h.host });
    expect((await worker.runSource(fixture.source.id, fixture.env.dir)).jobs).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("concurrent notifications create two distinct sessions and reuse existing sibling identities", async () => {
    await ready();
    const h = fakeHost(), worker = createDispatchWorker({ adapter: () => h.host });
    const results = await Promise.all(Array.from({ length: 5 }, () => worker.runSource(fixture.source.id, fixture.env.dir)));
    expect(h.start).toHaveBeenCalledTimes(2);
    const jobs = results[0].jobs;
    expect(jobs.map((j) => j.state)).toEqual(["started", "started"]);
    expect(new Set(jobs.map((j) => j.session!.threadId)).size).toBe(2);
    for (const j of jobs) expect((await getContent(j.derivedContentId!, fixture.env.dir))?.derivedFrom?.contentId).toBe(fixture.source.id);
    await worker.runSource(fixture.source.id, fixture.env.dir);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("keeps a lost kickoff ACK unknown, then recovers the same native session without creating again", async () => {
    await ready();
    const h = fakeHost(), original = h.start.getMockImplementation()!;
    h.start.mockImplementation(async (...args) => { await original(...args); throw new Error("lost acknowledgement"); });
    const first = createDispatchWorker({ adapter: () => h.host, owner: "before-restart" });
    const uncertain = await first.runSource(fixture.source.id, fixture.env.dir);
    expect(uncertain.jobs.every((j) => j.state === "unknown" && j.session?.threadId)).toBe(true);
    const siblingIds = uncertain.jobs.map((j) => j.derivedContentId);
    const afterRestart = createDispatchWorker({ adapter: () => h.host, owner: "after-restart" });
    const recovered = await afterRestart.runSource(fixture.source.id, fixture.env.dir);
    expect(recovered.jobs.every((j) => j.state === "started")).toBe(true);
    expect(recovered.jobs.map((j) => j.derivedContentId)).toEqual(siblingIds);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("does not retry create when no native session can be found after an ambiguous call", async () => {
    await ready();
    const h = fakeHost(); h.start.mockRejectedValue(new Error("connection lost before ACK"));
    const worker = createDispatchWorker({ adapter: () => h.host });
    await worker.runSource(fixture.source.id, fixture.env.dir);
    await worker.runSource(fixture.source.id, fixture.env.dir);
    expect(h.start).toHaveBeenCalledTimes(2);
    expect((await readOutbox(fixture.source.id, fixture.env.dir)).jobs.every((j) => j.state === "unknown")).toBe(true);
  });

  it("saves a created identity before rechecking revoked authorization and never submits its kickoff", async () => {
    await ready();
    const h = fakeHost();
    h.start.mockImplementation(async (input, onCreated): Promise<LaunchResult> => {
      await writePolicy({ enabled: false, host: "codex" }, fixture.env.dir);
      try { await onCreated(`native-${input.jobId}`); }
      catch { return { status: "unknown", code: "scope_changed", error: "scope changed", threadId: `native-${input.jobId}` }; }
      throw new Error("must not submit a turn after scope revocation");
    });
    const box = await createDispatchWorker({ adapter: () => h.host }).runSource(fixture.source.id, fixture.env.dir);
    expect(box.jobs.every((j) => j.state !== "started")).toBe(true);
    expect(box.jobs.some((j) => j.session?.threadId)).toBe(true);
  });

  it("an acknowledged different thread cannot replace the saved native identity", async () => {
    await ready();
    const h = fakeHost();
    h.start.mockImplementation(async (input, onCreated) => {
      await onCreated(`native-${input.jobId}`);
      return { status: "started", session: { threadId: "another-thread", turnId: "bad-turn" } };
    });
    const box = await createDispatchWorker({ adapter: () => h.host }).runSource(fixture.source.id, fixture.env.dir);
    expect(box.jobs.every((j) => j.state === "unknown" && j.code === "session_ack_mismatch" && j.session?.threadId !== "another-thread")).toBe(true);
  });

  it("limits each pass and allows explicit continuation of the same session after automatic dispatch is disabled", async () => {
    await ready();
    const h = fakeHost(), worker = createDispatchWorker({ adapter: () => h.host });
    const box = await worker.runSource(fixture.source.id, fixture.env.dir, false, 1);
    expect(h.start).toHaveBeenCalledTimes(1);
    const job = box.jobs.find((j) => j.state === "started")!;
    await writePolicy({ enabled: false, host: "codex" }, fixture.env.dir);
    await Promise.all([worker.resume(job.sourceId, job.id, fixture.env.dir), worker.resume(job.sourceId, job.id, fixture.env.dir)]);
    expect(h.resume).toHaveBeenCalledTimes(1);
    expect(h.resume.mock.calls[0][0]).toBe(job.session!.threadId);
  });
});
