/**
 * 审查 10-30：英文版的读路径（「等你拍板」、看板）每次都把 GB 级成片整片重算哈希（10-06 缓存修复在 10-24 回归）。
 * 钉住：读路径传 fresh:false 一路传到 enReviewState；不传时默认仍现算（批准、导出、发布不变）。
 */
import { describe, expect, it, vi } from "vitest";

const calls: Array<{ fresh?: boolean }> = [];
vi.mock("./review.js", () => ({
  enReviewState: vi.fn(async (_id: string, _dir: string, opts: { fresh?: boolean } = {}) => {
    calls.push(opts);
    return { code: "probe", error: "probe" };
  }),
}));

describe("英文版哈希的 fresh 开关", () => {
  it("approvedEnState：默认现算；读路径显式 fresh:false 走缓存", async () => {
    const { approvedEnState } = await import("./approved.js");
    calls.length = 0;
    await approvedEnState("c1", "/tmp/x");
    await approvedEnState("c1", "/tmp/x", { fresh: false });
    expect(calls).toEqual([{ fresh: true }, { fresh: false }]);
  });

  it("enKitBinding 把开关原样往下传", async () => {
    const { enKitBinding } = await import("./kit-context.js");
    calls.length = 0;
    await enKitBinding("c1", "/tmp/x", { fresh: false });
    await enKitBinding("c1", "/tmp/x");
    expect(calls).toEqual([{ fresh: false }, { fresh: true }]);
  });
});
