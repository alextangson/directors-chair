import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEnv, projectRoot, setContent, videoContent, type Env } from "../production/testkit.js";
import { observationFact, slotOf } from "../production/receipts.js";
import { readProductionDocOrEmpty, writeEnabledVersion, writeProductionDoc } from "../../storage/production-store.js";
import { videoChannelState } from "./slot.js";

let env: Env;
let id: string;
const PUBLIC_AT = "2026-10-24T09:00:00+08:00";

beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  id = (await videoContent(env, "视频号公开状态隔离测试")).id;
});
afterEach(async () => { await env.cleanup(); });

async function oldRecord(state: "public" | "manual" | "scheduled") {
  const dir = path.join(projectRoot(env, id), "06-publish");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "publish-plan.json"), JSON.stringify({ platforms: [{ platform: "wechat_video", publication: { status: state === "manual" ? "scheduled" : state, published_at: PUBLIC_AT, scheduled_at: "2026-10-25T18:00:00+08:00" } }] }));
  if (state === "manual") await setContent(env, id, { manualPublications: [{ platform: "wechat_video", at: PUBLIC_AT }] });
}

async function publicDoc() {
  const doc = await readProductionDocOrEmpty(id, env.dir);
  doc.facts.push(observationFact(doc, { source: "plan", platform: "wechat_video", pub_state: "public", published_at: PUBLIC_AT, evidence: "已核到公开" }, doc.round));
  return doc;
}

describe("视频号公开状态尊重当前轮次和纠正", () => {
  it("本轮定时回执不能被旧的公开计划盖回已公开", async () => {
    await oldRecord("public");
    const doc = await readProductionDocOrEmpty(id, env.dir);
    doc.facts.push(observationFact(doc, { source: "claim", platform: "wechat_video", pub_state: "scheduled", published_at: "2026-11-01T18:00:00+08:00", accepted: true, evidence: "本轮已排期" }, doc.round));
    await writeProductionDoc(id, env.dir, doc, doc.revision);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: false });
  });

  it.each(["public", "manual"] as const)("本轮纠正不能被原始 %s 计划或手动标记盖回公开", async (state) => {
    await oldRecord(state);
    const doc = await publicDoc();
    expect(slotOf(doc, doc.round, "wechat_video")?.pub_state).toBe("public");
    doc.decisions.push({ id: "correction", type: "publish_correction", round: doc.round, source: "founder", target_id: `slot:${doc.round}:wechat_video`, at: new Date(Date.now() + 1000).toISOString() });
    await writeProductionDoc(id, env.dir, doc, doc.revision);
    expect(slotOf(doc, doc.round, "wechat_video")).toBeNull();
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: false });
  });

  it.each(["public", "manual"] as const)("新一轮不能把上一轮的 %s 计划或手动标记当作已公开", async (state) => {
    await oldRecord(state);
    const doc = await publicDoc();
    doc.round++;
    doc.round_started_at = new Date().toISOString();
    await writeProductionDoc(id, env.dir, doc, doc.revision);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: false });
  });

  it("当前有效公开槽可以覆盖未更新的定时计划，缺公开时间时不猜时间", async () => {
    await oldRecord("scheduled");
    const doc = await publicDoc();
    await writeProductionDoc(id, env.dir, doc, doc.revision);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: true, at: Date.parse(PUBLIC_AT) });
    const next = await readProductionDocOrEmpty(id, env.dir);
    next.facts = [observationFact(next, { source: "metrics_id", platform: "wechat_video", pub_state: "public", evidence: "按作品 ID 核到公开" }, next.round)];
    await writeProductionDoc(id, env.dir, next, next.revision);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: true, at: null });
  });

  it("本轮创始人标记的已公开仍有效，取该决定的时间", async () => {
    const doc = await readProductionDocOrEmpty(id, env.dir);
    doc.decisions.push({ id: "published", type: "i_published", round: doc.round, source: "founder", platform: "wechat_video", at: PUBLIC_AT });
    await writeProductionDoc(id, env.dir, doc, doc.revision);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: true, at: Date.parse(PUBLIC_AT) });
  });

  it.each(["public", "manual"] as const)("未启用本体时保留 %s 旧流程兼容", async (state) => {
    await oldRecord(state);
    await writeEnabledVersion(env.dir, 0);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: true, at: Date.parse(PUBLIC_AT) });
  });

  it("资料库已启用，但这条稿被排除时仍走旧流程", async () => {
    await oldRecord("public");
    await writeEnabledVersion(env.dir, 1, [id]);
    expect(await videoChannelState(id, env.dir)).toMatchObject({ live: true, at: Date.parse(PUBLIC_AT) });
  });
});
