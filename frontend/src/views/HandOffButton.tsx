/**
 * 「交给 {默认 AI} 写 / 看 / 调研」+ 旁边一个小下拉「换一个」（spec 2026-10-15 §B4）：顶栏、对话栏、看板卡「重新交给」、选题卡调研区共用。
 * 写稿阶段 = 交给它写（记交出时刻）；其他阶段 = 交给它看（只读查看那句话）；选题 = 交给它开选题会（调研）。换一个只管这一次，不改默认。
 * 一个 AI 都没接：按钮照样能点，点了说「先接一个 AI」，不假装交出去。调研不交给总编辑（它没有搜索）。
 */
import { useState } from "react";
import { handOffContent } from "./board-api";
import { CHIEF_LABEL, settle, useWriters, WRITER_LABEL, type HandOffMode } from "./hand-off";
import type { HostId } from "./onboarding/connect-api";

type Target = { contentId: string; mode: "write" | "look" } | { topicId: string; mode: "research" };

const VERB: Record<HandOffMode, string> = { write: "写", look: "看", research: "调研" };
const TITLE: Record<HandOffMode, string> = {
  write: "把开工指令交给这个 AI，它接手接着写",
  look: "让这个 AI 看看这篇到哪一步，先不改",
  research: "让这个 AI 给这条选题开选题会：联网调研、出立意卡",
};

export function HandOffButton(p: Target & { className?: string; label?: (who: string) => string; onDone?: () => void;
  /** 主按钮交给谁（「重新交给」原来那个）；不给 = 默认写稿 AI */
  primary?: HostId }) {
  const w = useWriters();
  const [busy, setBusy] = useState(false);
  const main = p.primary ?? w?.defaultHost ?? null;
  const others = (w?.writers ?? []).filter((h) => h !== main);
  const id = p.mode === "research" ? p.topicId : p.contentId;
  const run = async (host: HostId | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await settle(await handOffContent(id, p.mode, host), p.mode, (alt) => run(alt));
      p.onDone?.();
    } finally { setBusy(false); }
  };
  const who = main ? WRITER_LABEL[main] : w?.chief && p.mode !== "research" ? CHIEF_LABEL : "AI";
  const verb = VERB[p.mode];
  // 英文名两边留空格，「总编辑」直接连写：交给 Codex 写 / 交给总编辑写
  const text = p.label ? p.label(who) : /^[\x00-\x7f]/.test(who) ? `交给 ${who} ${verb}` : `交给${who}${verb}`;
  return <span className="handoff">
    <button className={p.className} disabled={busy} title={TITLE[p.mode]} onClick={() => void run(p.primary ?? null)}>{busy ? "正在交…" : text}</button>
    {others.length > 0 && <select className="handoff-other" aria-label="换一个 AI" value="" disabled={busy} onChange={(e) => { const h = e.target.value as HostId; if (h) void run(h); }}>
      <option value="">换一个</option>
      {others.map((h) => <option key={h} value={h}>{`交给 ${WRITER_LABEL[h]} ${verb}`}</option>)}
    </select>}
  </span>;
}
