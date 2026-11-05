/**
 * 比稿简报（spec 2026-11-06 §服务端）：只用锁住的依据，和主会话 start 拿到的同源；不含主会话的稿。
 */
import { createHash } from "node:crypto";
import { getTopic, type Content } from "../../storage/local-store.js";
import { contrastContext, firsthandContext, profileContext } from "./draft-context.js";
import { pinnedPlaybook } from "../playbook/read.js";
import { lockedContext } from "../../tools/draft-locks.js";
import type { DraftAngle } from "./draft-types.js";

export const RIVAL_SYSTEM = [
  "You write the full script for one Douyin talking-head video (口播), in the creator's own voice. The creator has already chosen the angle, the opening, the genre playbook, the exemplars and the writing method in the brief; write within them.",
  "Output: only the Chinese body text he will read aloud, ready to record. No title, headings, bullet labels, shot / B-roll / subtitle / music / pause notes, and no commentary before or after the body.",
  "Start with the chosen opening exactly as given. Deliver everything the opening and the angle promise: if the opening promises a ranking, a list or an answer, the body gives all of it before it ends.",
  "Length: aim for the character count in the 篇幅 section (±20%). It is a size for this material, not a quota to pad — but stopping at half of it means something promised was left out.",
  "Hard limits: first-person experience (我/我们做过、见过、遇到) may only come from the 一手材料 section — if it isn't there, don't write it. Numbers and quotes may only come from the 已核验证据 section — anything else stays out. The profile's rules and never-list are not negotiable.",
  "voice_refs and 改稿对照 show how he talks: learn the cadence and word choice, don't copy their content and don't treat them as his experiences.",
].join("\n\n");

const block = (title: string, v: unknown) => `## ${title}\n\n${typeof v === "string" ? v : "```json\n" + JSON.stringify(v, null, 2) + "\n```"}`;

export const chosenOpening = (angle: DraftAngle) => angle.opening_pick?.chosen ?? angle.opening;

/** 立意或开头的指纹：变了，旧比稿就 stale */
export function angleKey(angle: DraftAngle): string {
  const { main_line, for_whom, chain, why_viral, founder_words, playbook } = angle;
  return createHash("sha256").update(JSON.stringify({ main_line, for_whom, chain, why_viral, founder_words, playbook, opening: chosenOpening(angle) })).digest("hex").slice(0, 16);
}

export const briefHash = (brief: string) => createHash("sha256").update(RIVAL_SYSTEM).update(brief).digest("hex").slice(0, 16);

const verifiedEvidence = (c: Content) => (c.evidenceLedger?.entries ?? [])
  .filter((e) => e.source === "verified_quote")
  .map((e) => ({ id: e.id, quote: e.quote, source_url: e.sourceUrl, ...(e.claim ? { claim: e.claim } : {}) }));

async function playbookText(angle: DraftAngle, dataDir?: string): Promise<unknown> {
  if (!angle.playbook) return "（这篇的立意没记体裁手册）";
  const book = await pinnedPlaybook(angle.playbook, dataDir);
  return `《${book.name}》第 ${book.version} 版\n\n${book.text}`;
}

function anglePart(angle: DraftAngle) {
  return { main_line: angle.main_line, for_whom: angle.for_whom, chain: angle.chain, why_viral: angle.why_viral, founder_words: angle.founder_words, ...(angle.chosen_option ? { chosen_option: angle.chosen_option } : {}) };
}

/** 篇幅只给主会话那版的字数（不含空白），不给它的正文 */
export const targetChars = (hostBody: string) => [...hostBody.replace(/\s/g, "")].length;

/** lockedContext 读不了锁定的写法 / 范文时不抛错而是带 error：这里拦下，不把错误文本当依据发出去 */
function lockErrors(locks: Record<string, unknown>): string[] {
  const method = locks.method as { error?: string } | undefined;
  const ex = locks.exemplars as { errors?: Array<{ id?: string; error?: string }> } | undefined;
  return [...(method?.error ? [`写法：${method.error}`] : []), ...(ex?.errors ?? []).map((e) => `范文 ${e.id ?? "?"}：${e.error ?? "读不了"}`)];
}

/** 拼简报；读不了的依据直接抛错（调用方回 failed，不悄悄少给） */
export async function buildRivalBrief(c: Content, dataDir?: string): Promise<string> {
  const angle = c.draftPath!.angle!;
  const topic = c.topicId ? await getTopic(c.topicId, dataDir) : null;
  const [profile, own, edits, locks, book] = await Promise.all([
    profileContext(dataDir), firsthandContext(topic, dataDir, c.draftPath?.inspiration), contrastContext(dataDir), lockedContext(c, dataDir), playbookText(angle, dataDir),
  ]);
  const broken = lockErrors(locks as Record<string, unknown>);
  if (broken.length) throw new Error(`锁住的依据读不了：${broken.join("；")}`);
  const p = profile as Record<string, unknown>;
  return [
    block("篇幅", `这条稿约 ${targetChars(c.body ?? "")} 字（不含空白，上下 20%）`),
    block("档案底线", { positioning: p.positioning ?? null, audience: p.audience ?? null, rules: p.rules ?? [], never: p.never ?? [] }),
    block("立意", anglePart(angle)),
    block("选定的开头（原样用）", chosenOpening(angle)),
    block("体裁手册", book),
    block("锁定的范文", (locks as Record<string, unknown>).exemplars ?? "（无）"),
    block("写法", (locks as Record<string, unknown>).method ?? "（无）"),
    block("改稿对照（学口吻，不是规则）", edits),
    block("voice_refs（学口吻，不是亲历）", own.voice_refs),
    block("一手材料（亲历只能来自这里）", own.firsthand),
    block("已核验证据（数字和引述只能来自这里）", verifiedEvidence(c)),
  ].join("\n\n");
}
