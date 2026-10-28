import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDocOrEmpty, writeProductionDoc } from "../../storage/production-store.js";
import { observationFact, type Observation } from "../production/receipts.js";
import { registeredVideo } from "../publish/review-gate/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { makeEnv, type Env } from "../production/testkit.js";

export const ZH = ["douyin", "wechat_video", "xiaohongshu", "bilibili"];
export const SCHEDULED_AT = new Date(Date.now() + 3 * 86_400_000).toISOString();

export async function dispatchFixture() {
  const env = await makeEnv({ enabled: true });
  await initProfile(env.dir);
  await updateProfile({ platforms: [...ZH, "wechat_mp", "youtube", "x"] }, env.dir);
  const source = await registeredVideo(env);
  return { env, source };
}

export async function receipts(env: Env, source: { id: string; root: string }, platforms = ZH,
  options: { submittedAt?: string; seenAt?: string; state?: "scheduled" | "public" | "reviewing" | "rejected"; plan?: boolean; ids?: Record<string, string>; scheduledAt?: string } = {}) {
  const state = options.state ?? "scheduled";
  const schedule = options.scheduledAt ?? SCHEDULED_AT;
  if (options.plan !== false) {
    await fs.mkdir(path.join(source.root, "06-publish"), { recursive: true });
    await fs.writeFile(path.join(source.root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: platforms.map((platform) => ({ platform,
      publication: { status: state, scheduled_at: schedule, post_id: options.ids?.[platform] ?? `${platform}-id`, ...(options.submittedAt ? { submitted_at: options.submittedAt } : {}), ...(state === "public" ? { published_at: new Date().toISOString() } : {}) } })) }));
  }
  const doc = await readProductionDocOrEmpty(source.id, env.dir);
  for (const platform of platforms) {
    const obs: Observation = { source: "claim", platform, pub_state: state, accepted: true, evidence: "隔离平台排期回执", item_id: options.ids?.[platform] ?? `${platform}-id`, published_at: state === "public" ? new Date().toISOString() : schedule, ...(options.submittedAt ? { submitted_at: options.submittedAt } : {}) };
    const fact = observationFact(doc, obs, doc.round);
    if (options.seenAt) fact.seen_at = options.seenAt;
    doc.facts.push(fact);
  }
  await writeProductionDoc(source.id, env.dir, doc, doc.revision);
}
