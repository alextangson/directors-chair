import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 技能名单从 skills/ 现读，不写死。
 * 上游 2026-10-02 用 topic-meeting 换掉了 spawn-planner，写死的名单会留一个悬空链接
 * 指向已删除的目录，Cursor 侧就发现不了那个技能。
 */
function editorialSkills(): string[] {
  return readdirSync(path.join(REPO_ROOT, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(REPO_ROOT, "skills", e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

describe("cursor workspace host", () => {
  it("points project MCP at the forwarder as the cursor host", () => {
    const cfg = JSON.parse(readFileSync(path.join(REPO_ROOT, ".cursor", "mcp.json"), "utf-8")) as {
      mcpServers: { autocrew: { command: string; args: string[]; env: { AUTOCREW_HOST: string } } };
    };
    const server = cfg.mcpServers.autocrew;
    expect(server.command).toBe("node");
    expect(server.args).toEqual(["${workspaceFolder}/bin/autocrew.mjs", "mcp"]);
    expect(server.env.AUTOCREW_HOST).toBe("cursor");
  });

  it("symlinks every editorial skill into .cursor/skills", () => {
    const dir = path.join(REPO_ROOT, ".cursor", "skills");
    const skills = editorialSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const name of skills) {
      const link = path.join(dir, name);
      expect(lstatSync(link).isSymbolicLink(), name).toBe(true);
      expect(readlinkSync(link)).toBe(`../../skills/${name}`);
      expect(existsSync(path.join(REPO_ROOT, "skills", name, "SKILL.md")), name).toBe(true);
    }
  });

  it("keeps .cursor/skills free of links that point nowhere", () => {
    const dir = path.join(REPO_ROOT, ".cursor", "skills");
    const linked = readdirSync(dir);
    expect(linked.sort()).toEqual(editorialSkills());
    for (const name of linked) {
      expect(existsSync(path.join(dir, name)), name).toBe(true);
    }
  });

  it("keeps the host rule off unless the user is doing editorial work", () => {
    const text = readFileSync(path.join(REPO_ROOT, ".cursor", "rules", "autocrew-host.mdc"), "utf-8");
    expect(text).toContain("alwaysApply: false");
    expect(text).toContain("通过 AutoCrew 写稿、改稿、审稿或发布时使用");
    expect(text).toContain("修改本仓库代码时不用");
    expect(text).toContain("当前宿主是 `cursor`，工具面与 `claude-code` 相同。");
    expect(text).toContain("`adapters/codex/AGENTS.editor-writer.md` 开头的 Codex 停用说明不适用于本宿主。");
    expect(text).toContain("写稿、审稿、发布的步骤以 `.cursor/skills` 里对应技能为准。");
    expect(text).toContain("唯一写盘进程是本机 AutoCrew 服务。不直接改资料库里的稿件文件来绕过工具。");
  });
});
