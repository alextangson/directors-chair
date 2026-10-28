// @vitest-environment happy-dom
/** 设置标签拆分（引擎调研下线 spec §9）：模型页只剩端点那一块，本机页收更新/存储/A-roll/剪映/转写/工作区/知识库/更多 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const stub = (name: string) => () => createElement("div", { "data-stub": name });
vi.mock("./SettingsEngine", () => ({ EngineSection: stub("engine") }));
vi.mock("./SettingsStorage", () => ({ SettingsStorage: stub("storage") }));
vi.mock("./SettingsJianying", () => ({ SettingsJianying: stub("jianying") }));
vi.mock("./SettingsArollSources", () => ({ SettingsArollSources: stub("aroll") }));
vi.mock("./SettingsAsr", () => ({ SettingsAsr: stub("asr") }));
vi.mock("./Integrations", () => ({ Integrations: stub("integrations") }));
vi.mock("./SettingsPublishGate", () => ({ SettingsPublishGate: stub("publish-gate") }));
vi.mock("./SettingsVoice", () => ({ SettingsVoice: stub("voice") }));
vi.mock("./SettingsData", () => ({ SettingsData: stub("data") }));
vi.mock("./SettingsUpdate", () => ({ SettingsUpdate: stub("update") }));
vi.mock("./SettingsPlatforms", () => ({ SettingsPlatforms: stub("platforms") }));
vi.mock("../transport", () => ({ invoke: async () => ({ ok: true, data: { dir: "/kb", count: 0, active: "default", workspaces: [] } }) }));
vi.mock("../ui", () => ({ toast: () => {}, openDialog: async () => null }));

const { Settings } = await import("./Settings");

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el);
});
afterEach(async () => { await act(async () => { root.unmount(); }); el.remove(); });

const stubs = () => [...el.querySelectorAll("[data-stub]")].map((n) => n.getAttribute("data-stub"));
async function show(tab: "models" | "local") {
  await act(async () => { root.render(createElement(Settings, { tab, nav: () => {} })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe("设置标签", () => {
  it("顺序：运营平台 · 模型 · 本机 · 接入更多 · 数据回流", async () => {
    await show("models");
    expect([...el.querySelectorAll(".set-tabs button")].map((b) => b.textContent)).toEqual(["运营平台", "模型", "本机", "接入更多", "数据回流"]);
  });

  it("模型页只放端点那一块", async () => {
    await show("models");
    expect(stubs()).toEqual(["engine"]);
    expect(el.textContent).not.toContain("工作区");
  });

  it("本机页：更新、存储、A-roll、剪映、转写 + 工作区、知识库、更多入口，不含端点", async () => {
    await show("local");
    expect(stubs()).toEqual(["update", "storage", "aroll", "jianying", "asr"]);
    for (const t of ["工作区", "知识库", "更多", "灵感收件箱"]) expect(el.textContent).toContain(t);
  });
});
