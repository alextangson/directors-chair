import { describe, expect, it } from "vitest";
import { detectSlivers } from "./detect.js";
import { SUPPORTED_SCHEMAS, type Json, type SnapshotAsset } from "./snapshot-types.js";

// Fields reflect the actual v33 timeline: captions live in a separate resource.
const base = { compositionWidth: 1920, compositionHeight: 1080, captionSettings: { enabled: true, captionModelPath: "captions/timeline/model.json" },
  tracks: [{ id: "a", order: 0, hidden: false }, { id: "b", order: 1, hidden: false }], relations: [],
  videoItems: [{ id: "aroll", type: "video", trackId: "a", assetId: "source", startFrame: 0, durationFrames: 90, left: 0, top: 0, width: 1920, height: 1080 }],
  imageItems: [{ id: "first", type: "image", trackId: "b", assetId: "image", startFrame: 0, durationFrames: 30, left: 0, top: 0, width: 1920, height: 1080 },
    { id: "second", type: "image", trackId: "b", assetId: "image", startFrame: 35, durationFrames: 55, left: 0, top: 0, width: 1920, height: 1080 }] };
const assets: Record<string, SnapshotAsset> = { source: { id: "source", type: "video", path: "/aroll.mov", pix_fmt: "yuv420p" }, image: { id: "image", type: "image", pix_fmt: "rgb24" } };
const run = (timeline: Json) => detectSlivers({ snap: { schemaVersion: 33, project_id: "p", timeline_id: "t", timeline, assets }, fps: { num: 30, den: 1 }, cutFrames: 90, aroll: { facts: [{ id: "f", label: "原片", paths: ["/aroll.mov"] }] } });

describe("ChatCut schema 33", () => {
  it("recognizes the version and reports the exposed five frames", () => {
    expect(SUPPORTED_SCHEMAS.has(33)).toBe(true);
    expect(run(base)).toMatchObject({ status: "slivers", slivers: [{ start_frame: 30, end_frame: 35, frames: 5 }] });
  });
  it("does not assume an unknown visual property is opaque", () => {
    const images = base.imageItems.map((x, i) => i === 0 ? { ...x, newMask: true } : x);
    expect(run({ ...base, imageItems: images })).toMatchObject({ status: "unchecked", reason: expect.stringContaining("newMask") });
  });
  it("rejects unknown visual item types", () => {
    expect(run({ ...base, futureItems: [{ id: "unknown" }] })).toMatchObject({ status: "unchecked", reason: expect.stringContaining("futureItems") });
  });
});
