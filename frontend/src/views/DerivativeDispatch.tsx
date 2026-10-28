/** 派生会话沿用设置与主题详情，不新增任务墙。状态和历史只认服务端读回。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "../components/Switch";
import { codexDispatchLink, loadDispatchPolicy, loadDispatchStatus, loadDispatchThread, prepareDispatch, resumeDispatchThread, saveDispatchPolicy,
  type DispatchJobView, type DispatchPolicyView, type DispatchStatusView, type DispatchThreadView } from "./derivative-dispatch-api";
import "./derivative-dispatch.css";

export function SettingsDerivativeDispatch() {
  const [policy, setPolicy] = useState<DispatchPolicyView | null>(null);
  const [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const read = useCallback(async () => {
    const r = await loadDispatchPolicy();
    if (r.ok) { setPolicy(r.data); setError(null); } else setError(r.error);
  }, []);
  useEffect(() => { let live = true; void loadDispatchPolicy().then((r) => { if (!live) return; if (r.ok) setPolicy(r.data); else setError(r.error); }); return () => { live = false; }; }, []);
  const toggle = async () => {
    if (!policy || writing.current) return;
    writing.current = true; setBusy(true); setError(null); setNote(null);
    try {
      const r = await saveDispatchPolicy(!policy.enabled);
      if (r.ok) { setPolicy(r.data); setNote("设置已保存"); } else setError(r.error);
    } finally { writing.current = false; setBusy(false); }
  };
  return <section className="pf-card dd-policy" aria-label="自动派生会话">
    <div className="dd-policy-head"><label><strong>中文排期完成后自动开公众号/英文会话</strong>
      <Switch aria-label="中文排期完成后自动开公众号/英文会话" checked={policy?.enabled ?? false} disabled={!policy || busy || Boolean(error)} onChange={() => void toggle()} /></label></div>
    <p className="muted">由 Codex 建立制作会话。只处理启用后的排期；当前主题可在管线详情中检查并补齐。实际派生按本条去向计划和已启用的平台执行。</p>
    <p className="muted">此设置不代替付款、账号和最终投稿确认。自动派生关闭时，待办暂停，已创建会话保留，仍可手动继续原会话。</p>
    {!policy && !error && <p className="muted" role="status">读取设置中…</p>}
    {note && <p className="muted" role="status">{note}</p>}
    {error && <p className="dd-error" role="alert">自动派生设置读写失败：{error} <button onClick={() => void read()}>重读设置</button></p>}
  </section>;
}

const LINE = { wechat_article: "公众号", en_edition: "英文版（YouTube / X）" };
const STATE: Record<DispatchJobView["state"], string> = { queued: "等待启动", leased: "准备中", dispatching: "正在建立会话", started: "会话已启动", blocked: "暂不能启动", unknown: "创建结果待核对", cancelled: "已取消" };

export function DerivativeDispatchPanel(p: { sourceId: string }) {
  const [data, setData] = useState<DispatchStatusView | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [view, setView] = useState<DispatchJobView | null>(null);
  const seq = useRef(0), live = useRef(true), acting = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++seq.current;
    const r = await loadDispatchStatus(p.sourceId);
    if (!live.current || request !== seq.current) return;
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [p.sourceId]);
  useEffect(() => {
    live.current = true; setData(null); setError(null); setView(null); void refresh();
    return () => { live.current = false; ++seq.current; };
  }, [refresh]);
  const prepare = async () => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError(null);
    const request = ++seq.current;
    try {
      const r = await prepareDispatch(p.sourceId);
      if (!live.current || request !== seq.current) return;
      if (r.ok) setData(r.data); else setError(r.error);
    } finally { acting.current = false; if (live.current) setBusy(false); }
  };
  const jobs = data?.jobs ?? [];
  const unsettled = jobs.some((j) => j.state === "unknown" || j.state === "dispatching" || j.state === "leased");
  return <section className="dd-panel" aria-label="派生制作会话">
    <div className="dd-heading"><strong>派生制作会话</strong><button className="pl-link" disabled={busy} onClick={() => void refresh()}>刷新状态</button></div>
    {error && <p className="dd-error" role="alert">派生会话状态读不出来：{error}</p>}
    {!data && !error && <p className="muted" role="status">读取中…</p>}
    {data && <>
      {!data.policy.enabled && <p className="muted">自动派生关闭，待办暂停，已创建会话保留。</p>}
      {jobs.length === 0 && <p className="muted">{data.policy.enabled ? "这条还没有派生会话记录。" : "自动派生会话未开启。"} <a href="#/settings?tab=platforms">查看设置</a></p>}
      {jobs.map((job) => <div key={job.id} className="dd-job">
        <span><strong>{LINE[job.kind]}</strong> · {job.state === "started" && !job.session?.threadId ? "会话身份待核对" : STATE[job.state]}{job.reason && <small className="dd-job-reason">{job.reason}</small>}</span>
        {job.session?.threadId && <button className="pl-link" onClick={() => setView(job)}>查看/继续会话</button>}
      </div>)}
      {data.policy.enabled && !unsettled && <button className="pl-link" disabled={busy} onClick={() => void prepare()}>{busy ? "检查中…" : "检查并补齐当前主题"}</button>}
      {unsettled && <p className="muted">已有会话的创建结果尚待核对，先刷新查看，不另开会话。</p>}
    </>}
    {view && <DispatchThread sourceId={p.sourceId} job={view} close={() => setView(null)} refreshed={refresh} />}
  </section>;
}

function DispatchThread(p: { sourceId: string; job: DispatchJobView; close: () => void; refreshed: () => Promise<void> }) {
  const [data, setData] = useState<DispatchThreadView | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [note, setNote] = useState<string | null>(null);
  const seq = useRef(0), live = useRef(true), acting = useRef(false);
  const read = useCallback(async (cursor?: string) => {
    const request = ++seq.current;
    const r = await loadDispatchThread(p.sourceId, p.job.id, cursor);
    if (!live.current || request !== seq.current) return;
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    setData((old) => cursor && old ? { ...r.data, turns: [...old.turns, ...r.data.turns.filter((t) => !old.turns.some((x) => x.id === t.id))] } : r.data);
  }, [p.sourceId, p.job.id]);
  useEffect(() => { live.current = true; void read(); return () => { live.current = false; ++seq.current; }; }, [read]);
  const resume = async () => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setNote(null); setError(null);
    try {
      const r = await resumeDispatchThread(p.sourceId, p.job.id);
      if (!live.current) return;
      if (!r.ok) setError(r.error);
      else if (r.data.status !== "started") setError(r.data.error);
      else { setNote("续办已交给当前会话，请刷新查看实际回复。"); await p.refreshed(); await read(); }
    } finally { acting.current = false; if (live.current) setBusy(false); }
  };
  const linked = p.job.session?.threadId;
  const verified = Boolean(data && data.threadId === linked);
  const href = verified ? codexDispatchLink(data!.threadId) : null;
  const running = data && ["running", "active", "inProgress"].includes(data.status);
  return <div className="dd-modal-backdrop" onClick={p.close}>
    <section className="dd-modal" role="dialog" aria-modal="true" aria-label={`${LINE[p.job.kind]}真实会话记录`} onClick={(e) => e.stopPropagation()}>
      <div className="dd-heading"><strong>{LINE[p.job.kind]} · 会话记录</strong><button onClick={p.close}>关闭</button></div>
      {!data && !error && <p role="status">读取真实会话中…</p>}
      {data && !verified && <p className="dd-error" role="alert">读回的会话身份和记录不一致，先不能继续。</p>}
      {verified && <>
        <p className="muted">会话状态：{data!.status}{data!.needsAttention ? ` · ${data!.needsAttention}` : ""}</p>
        <p className="muted">以下为会话历史的分页预览，较长文字可能截短。可加载更多记录。</p>
        <div className="dd-thread-records">{data!.turns.length === 0 ? <p className="muted">暂时没有可显示的会话记录。</p> : data!.turns.map((turn) => <div key={turn.id} className="dd-turn">
          {turn.items.filter((i) => typeof i.text === "string").map((item, i) => <div key={i} className="dd-thread-text"><small>{item.type === "userMessage" ? "任务指令" : item.type === "agentMessage" ? "Codex" : "会话记录"}</small><pre>{item.text}</pre></div>)}
        </div>)}</div>
        {data!.nextCursor && <button disabled={busy} onClick={() => void read(data!.nextCursor!)}>更多历史记录</button>}
      </>}
      {error && <p className="dd-error" role="alert">{error}</p>}
      {note && <p role="status">{note}</p>}
      <div className="dd-thread-actions">
        <button disabled={busy} onClick={() => void read()}>刷新会话</button>
        {verified && !running && <button disabled={busy || Boolean(error)} onClick={() => void resume()}>{busy ? "续办中…" : "继续当前会话"}</button>}
        {href && <a href={href}>尝试在 Codex 打开</a>}
      </div>
      {href && <p className="muted">链接只尝试打开应用。实际进展以读回的会话记录为准。</p>}
    </section>
  </div>;
}
