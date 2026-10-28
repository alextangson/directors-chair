import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentFile } from "../storage/content-project.js";
import { executeContentSave } from "./content-save.js";
import { fitBudget } from "./content-summary.js";
import { dispatchFixture } from "../modules/derivative-dispatch/testkit.js";
import { mutateOutbox, readOutbox, writePolicy } from "../modules/derivative-dispatch/store.js";
import { hostPolicy } from "../../mcp/host-policy.js";

let fixture: Awaited<ReturnType<typeof dispatchFixture>>;
beforeEach(async () => { fixture = await dispatchFixture(); });
afterEach(async () => { await fixture.env.cleanup(); });
const run = (action: string) => executeContentSave({ action, content_id: fixture.source.id, _dataDir: fixture.env.dir, _host: "codex" });

describe("宿主读取持久派生任务", () => {
  it("策略开启但任务尚未入队时，summary 也能阻止前台再建会话", async () => {
    await writePolicy({ enabled: true, host: "codex" }, fixture.env.dir);
    expect(await run("derivative_status")).toMatchObject({ ok: true, policy: { enabled: true, host: "codex" }, jobs: [], revision: 0 });
    expect(await run("summary")).toMatchObject({ ok: true, derivative_dispatch: { enabled: true, host: "codex", jobs: [] } });
    expect(await readOutbox(fixture.source.id, fixture.env.dir)).toEqual({ version: 1, revision: 0, jobs: [] });
    expect(hostPolicy("codex", "autocrew_content", { action: "derivative_status" })).toEqual({ ok: true });
  });

  it("关闭策略不隐去已有会话，读取不推进状态", async () => {
    const stamp = new Date().toISOString();
    await mutateOutbox(fixture.source.id, fixture.env.dir, (box) => {
      box.jobs.push({ id: "kept-job", sourceId: fixture.source.id, sourceTitle: "已开工", round: 1,
        sourceCutHash: "sha256:test", kind: "wechat_article", targetPlatforms: ["wechat_mp"], requiredZhPlatforms: ["douyin"], receiptRefs: [],
        policyId: "previous-policy", host: "codex", state: "unknown", session: { threadId: "real-kept-thread" }, createdAt: stamp, updatedAt: stamp });
    });
    const before = await readOutbox(fixture.source.id, fixture.env.dir);
    expect(await run("summary")).toMatchObject({ derivative_dispatch: { enabled: false, jobs: [{ state: "unknown", thread_id: "real-kept-thread" }] } });
    expect(await run("derivative_status")).toMatchObject({ ok: true, jobs: [{ session: { threadId: "real-kept-thread" } }] });
    expect(await readOutbox(fixture.source.id, fixture.env.dir)).toEqual(before);
  });

  it("任务文件损坏显式报错，不当成空队列或覆盖原记录", async () => {
    const file = contentFile(fixture.source.id, fixture.env.dir, "derivative-outbox.json");
    await fs.writeFile(file, "{broken existing thread receipt", "utf8");
    expect(await run("derivative_status")).toMatchObject({ ok: false, code: "derivative_dispatch_failed" });
    expect(await run("summary")).toMatchObject({ ok: true, derivative_dispatch: { error: expect.any(String) } });
    expect(await fs.readFile(file, "utf8")).toBe("{broken existing thread receipt");
  });

  it("最小摘要仍保留调度开启状态和读取失败，不能降级为手动创建", () => {
    const out = fitBudget({ ok: true, id: fixture.source.id, stage: "已排期", title: "x".repeat(2000),
      derivative_dispatch: { enabled: true, error: "任务暂时读不出来" } }, null);
    expect(out).toMatchObject({ derivative_dispatch: { enabled: true, error: expect.any(String) } });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(1536);
  });
});
