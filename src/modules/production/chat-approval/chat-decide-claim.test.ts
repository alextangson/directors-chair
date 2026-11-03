/**
 * 对话里认稿 / 退回修改不占写手认领（2026-11-03 真机）：写手交稿时认领随交接释放，
 * 收件箱决定曾补记一枚 local-user 认领，宿主接着 submit / citations 撞 claim_held，跨宿主接管不了，只能干等 30 分钟。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContent } from "../../../storage/local-store.js";
import { claimContent, gateClaimWrite } from "../../../storage/claims.js";
import { executeReviewInbox } from "../../../tools/review-inbox.js";
import { makeEnv, videoContent, type Env } from "../testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

type R = Record<string, any>;
const HOST = "claude-code";
const tool = (p: R): Promise<R> => executeReviewInbox({ _dataDir: env.dir, _host: HOST, _session: "sess-abcdef123", ...p });
let rid = 0;
async function decide(contentId: string, decision: string, extra: R = {}): Promise<R> {
  const it = ((await tool({ action: "list", content_id: contentId })).items as R[]).find((i) => i.type === "draft")!;
  return tool({ action: "decide", item_id: it.item_id, gen: it.gen, decision, founder_words: "原话", request_id: `rq-claim-${++rid}`, ...extra });
}
/** 宿主后续的写（writer submit / video citations 走的同一道门） */
const hostWrite = (id: string, employee: "writer" | "editor", token?: string) => gateClaimWrite(id, { host: HOST, employee, token }, env.dir);

describe("收件箱决定不占写手认领", () => {
  it.each([["revise_script", { note: "开头换一句" }], ["approve_script", {}]] as const)("交稿后认领已释放：%s 不补记 local-user 认领，宿主接着写不被挡", async (decision, extra) => {
    const c = await videoContent(env, `稿-${decision}`, "draft_ready");
    expect(await decide(c.id, decision, extra)).toMatchObject({ ok: true });
    expect((await getContent(c.id, env.dir))!.claim).toBeUndefined();
    const w = await hostWrite(c.id, decision === "approve_script" ? "editor" : "writer");
    expect(w).toMatchObject({ grant: { claim_token: expect.stringMatching(/^clm-/) } });
  });

  it.each([["revise_script", { note: "再改改" }], ["approve_script", {}]] as const)("宿主握着认领：%s 之后它那枚令牌照样能写", async (decision, extra) => {
    const c = await videoContent(env, `握着-${decision}`, "draft_ready");
    const held = await claimContent(c.id, "writer", HOST, env.dir);
    if (!held.ok) throw new Error(held.error);
    const token = held.claim.token;
    expect(await decide(c.id, decision, extra)).toMatchObject({ ok: true });
    const after = (await getContent(c.id, env.dir))!.claim!;
    expect(after.host).toBe(HOST);
    expect(await hostWrite(c.id, "writer", token)).toMatchObject({ grant: { claim_token: token } });
  });
});
