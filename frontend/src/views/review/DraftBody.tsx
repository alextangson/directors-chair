/** 普通认稿：显示全文，并核对列表出示的正文、标题和存盘版本。 */
import { useEffect, useState } from "react";
import { invoke } from "../../transport";
import { routeHash } from "../../routes";
import { relativeLabel } from "../../time-format";
import { Actions, type Act } from "./ReviewPanel";
import type { InboxItem } from "./review-model";

type Draft = { title: string; body: string; updatedAt: string; hash: string };
type Loaded = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; draft: Draft };

async function readDraft(id: string): Promise<Draft> {
  const r = await invoke("content:get", { id });
  if (!r.ok) throw new Error(r.error ?? "读取失败");
  const c = r.content as Partial<Draft> | undefined;
  if (typeof c?.body !== "string" || typeof c.title !== "string" || typeof c.updatedAt !== "string") throw new Error("稿件内容不完整");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.body));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { title: c.title, body: c.body, updatedAt: c.updatedAt, hash };
}

export function DraftBody(p: { item: InboxItem; act: Act }) {
  const cid = p.item.content_id;
  const [got, setGot] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let live = true;
    if (!cid) { setGot({ state: "error", error: "这件事没挂在稿上" }); return; }
    void readDraft(cid).then((draft) => { if (live) setGot({ state: "ok", draft }); }, (e: unknown) => {
      if (live) setGot({ state: "error", error: e instanceof Error ? e.message : String(e) });
    });
    return () => { live = false; };
  }, [cid, p.item.gen]);
  const link = cid && <p><a href={routeHash({ view: "editor", id: cid })}>打开稿件 →</a></p>;
  if (got.state === "loading") return <>{link}<p className="ri-note" role="status">稿件全文读取中…</p></>;
  if (got.state === "error") return <>{link}<p className="ri-warn" role="alert">稿件全文读不出来：{got.error}</p>
    <Actions item={{ ...p.item, blocked_reason: "看不到稿子，先不能批" }} act={p.act} /></>;
  const d = got.draft;
  const expected = p.item.detail.body_hash, at = p.item.detail.updated_at;
  const problem = !expected || !at ? "这份认稿缺少版本信息，请刷新列表再认"
    : expected !== d.hash || at !== d.updatedAt || p.item.title !== d.title ? "稿子刚改过，列表刷新后再批"
    : !d.body.trim() ? "稿子还是空的，先不能批" : p.item.blocked_reason;
  return <>
    <dl className="ri-props"><dt>稿子</dt><dd>{d.title}</dd><dt>字数</dt><dd>{String(p.item.detail.words ?? d.body.length)}</dd><dt>存稿</dt><dd>{relativeLabel(d.updatedAt)}</dd></dl>
    {link}
    <div className="ri-body">{d.body}</div>
    <Actions item={{ ...p.item, blocked_reason: problem }} act={p.act} extra={() => ({ expected_body_hash: d.hash })} />
  </>;
}
