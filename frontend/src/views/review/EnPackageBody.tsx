/** 英文整包审阅只展示当前条目绑定的文案与媒体，媒体仍走登记身份和 sha 校验。 */
import { useState } from "react";
import { routeHash } from "../../routes";
import { platformName } from "../board-columns";
import { Actions, type Act } from "./ReviewPanel";
import type { InboxItem } from "./review-model";
import { mediaUrl as registeredMediaUrl } from "./review-api";

interface Media { fact_id: string }
interface Preview {
  hash: string; thumbnail: Media | null; cut: Media | null;
  kits: Array<{ platform: string; title: string; caption: string; tags: string[]; chapters: Array<{ at: string; title: string }>; aiDisclosure: string | null }>;
}

function mediaUrl(cid: string, m: Media | null): string | null {
  if (!m || !/^[\w-]{1,80}$/.test(m.fact_id)) return null;
  return registeredMediaUrl(cid, m.fact_id);
}

export function EnPackageBody(p: { item: InboxItem; act: Act }) {
  const cid = p.item.content_id;
  const d = p.item.detail.preview as Preview | undefined;
  const [imageReady, setImageReady] = useState(false), [videoReady, setVideoReady] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const thumbnail = cid ? mediaUrl(cid, d?.thumbnail ?? null) : null, cut = cid ? mediaUrl(cid, d?.cut ?? null) : null;
  const problems = (p.item.detail.problems as string[] | undefined) ?? [];
  const missing = !d || !d.hash || d.hash !== p.item.detail.package_hash ? "发布包版本信息不完整，请刷新列表再看"
    : !thumbnail || !cut ? "缩略图或成片缺少已登记的预览身份，请刷新列表或补齐发布包"
    : !d.kits?.length ? "还没有平台文案" : null;
  const blocked = missing ?? mediaError ?? (problems.length ? "还差下面几样，补齐了才能批" : !imageReady || !videoReady ? "缩略图和成片读取中，先不能批" : p.item.blocked_reason);
  return <>
    {cid && <p><a href={routeHash({ view: "editor", id: cid })}>打开稿件 →</a></p>}
    {Boolean(p.item.detail.reopened) && <p className="ri-warn">批准后变更：{String(p.item.detail.reopened)}</p>}
    {thumbnail && <div className="ri-preview"><img alt="英文版 16:9 缩略图" src={thumbnail} onLoad={() => setImageReady(true)} onError={() => setMediaError("缩略图读不出来或文件已变化，先不能批")} /></div>}
    {cut && <div className="ri-preview"><video controls preload="metadata" src={cut} onLoadedMetadata={() => setVideoReady(true)} onError={() => setMediaError("成片读不出来或文件已变化，先不能批")} /></div>}
    {d?.kits?.map((k) => <section key={k.platform}>
      <h3>{platformName(k.platform)}{k.platform === "x" ? " 帖子" : ""}</h3>
      {k.title && <p><strong>{k.title}</strong></p>}
      <div className="ri-body">{k.caption}</div>
      {k.tags.length > 0 && <p className="ri-note">标签：{k.tags.join("、")}</p>}
      {k.platform === "youtube" && <p className="ri-note">AI 使用声明：{k.aiDisclosure === "yes" ? "Yes" : k.aiDisclosure === "no" ? "No" : "未填写"}</p>}
      {k.chapters.length > 0 && <><h4>章节</h4><ol>{k.chapters.map((c, i) => <li key={i}>{c.at} {c.title}</li>)}</ol></>}
    </section>)}
    {problems.length > 0 && <div className="ri-problems"><p>还不能批：</p><ol>{problems.map((x, i) => <li key={i}>{x}</li>)}</ol></div>}
    <Actions item={{ ...p.item, blocked_reason: blocked }} act={p.act} />
  </>;
}
