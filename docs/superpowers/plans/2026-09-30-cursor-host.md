# Cursor 反向接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AutoCrew 仓库里打开 Cursor 时，通过已提交的 `.cursor/mcp.json` 以命名宿主 `cursor` 调用本机 `:4317/mcp`，并让 Cursor 从符号链接自动发现现有 `skills/`。

**Architecture:** 不新写传输。`.cursor/mcp.json` 用 stdio 启动现成的 `bin/autocrew.mjs mcp`，环境变量 `AUTOCREW_HOST=cursor` 让转发器只读 `tokens/cursor.token`。`autocrew host cursor` 只负责发令牌和打印说明。技能正文留在 `skills/`，`.cursor/skills/<name>` 是相对符号链接。一条 `alwaysApply: false` 的规则只说明宿主身份。

**Tech Stack:** TypeScript、Vitest、Node `fs` 符号链接、Cursor 项目级 MCP（`.cursor/mcp.json`）与项目技能（`.cursor/skills`）。

**Spec:** `docs/superpowers/specs/2026-09-30-cursor-host-design.md`（2026-09-30 已确认）

## Global Constraints

- 只做反向接入。不改总编辑切换器，不引入 `@cursor/sdk`，不写 `~/.cursor/mcp.json`，设置页不加按钮。
- 不改根上的 `AGENTS.md`，不改 `mcp/host-policy.ts`，不复制或改写 `skills/` 正文。
- 令牌值不进仓库、不进 `hostInstructions` 的输出。`AUTOCREW_HOST=cursor` 时转发器只读 `tokens/cursor.token`，不回落到 `server-token`。这条已经由 `bin/mcp-forwarder.mjs` 的 `resolveForwarderToken` 实现，本计划不改转发器。
- 宿主名 `cursor` 必须匹配 `HOST_NAME_PATTERN`（`src/desktop/host-tokens.ts`：`/^[a-z][a-z0-9-]{1,31}$/`）。令牌文件 0600 由现有 `ensureHostToken` 负责，不要另写一份发令牌逻辑。
- 稿件上的 `writtenBy.host` 来自令牌文件名。不要加一张宿主别名表。
- 工作分支是 `feat/cursor-host`。提交时只 `git add` 本任务列出的路径。不要把这四个未提交文件加进去：`src/adapters/browser/wechat-video-stats.ts`、`src/adapters/browser/wechat-video-stats.test.ts`、`src/adapters/browser/xhs-stats.ts`、`src/adapters/browser/xhs-stats.test.ts`。
- 不推送，不开 PR。（2026-11-10 创始人决定改为推送到个人 fork `archlizheng/AutoCrew` 并向上游开 PR。）

---

### Task 1: `autocrew host cursor` 发令牌并打印说明

**Files:**
- Modify: `src/desktop/host-cli.ts`（`KNOWN_HOSTS`、`PERSONA_FILE`、`hostInstructions` 的 steps 分支、`personaLines`）
- Test: `src/desktop/host-cli.test.ts`

**Interfaces:**
- Consumes: `ensureHostToken(host, dataDir)`（`src/desktop/host-tokens.ts`），已有 `hostInstructions(host, options)`。
- Produces: `KNOWN_HOSTS` 含 `"cursor"`。`hostInstructions("cursor", { dataDir })` 在有 `server-token` 时创建 `tokens/cursor.token` 并返回说明；没有 `server-token` 时不创建该文件。`cursor` 加 `--dir` 不写 `AGENTS.md`。

- [ ] **Step 1: Write the failing test**

在 `src/desktop/host-cli.test.ts` 的 `describe("autocrew host")` 末尾、`describe("autocrew host --dir")` 之前加入：

```typescript
  it("prints the cursor mcp file and never the token value", () => {
    const out = hostInstructions("cursor", { dataDir: booted(), port: 4317 });
    expect(out).toContain(".cursor/mcp.json");
    expect(out).toContain("AUTOCREW_HOST=cursor");
    expect(out).toContain(path.join("tokens", "cursor.token"));
    expect(existsSync(path.join(dataDir, "tokens", "cursor.token"))).toBe(true);
    expect(out).not.toMatch(TOKEN_VALUE);
  });

  it("does not create a cursor token before the server has ever started", () => {
    const out = hostInstructions("cursor", { dataDir });
    expect(out).toContain("npm start");
    expect(existsSync(path.join(dataDir, "tokens", "cursor.token"))).toBe(false);
  });
```

在 `describe("autocrew host --dir")` 末尾、它的结束 `});` 之前加入：

```typescript
  it("ignores --dir for cursor and writes no AGENTS.md", () => {
    const out = hostInstructions("cursor", { dataDir: booted(), dir: ws, role: "colorist", personaDir });
    expect(out).toContain(".cursor/rules/autocrew-host.mdc");
    expect(out).toContain(".cursor/skills");
    expect(out).toContain("--dir 这次被忽略");
    expect(out).not.toContain("agent.cordis.yml");
    expect(existsSync(path.join(ws, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(ws, "CLAUDE.md"))).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/desktop/host-cli.test.ts`

Expected: FAIL。`prints the cursor mcp file` 的输出含 `未知宿主：cursor`，不含 `.cursor/mcp.json`。

- [ ] **Step 3: Write minimal implementation**

`src/desktop/host-cli.ts` 顶部注释里的宿主列表改为包含 cursor：

```typescript
 * `autocrew host <codex|claude-code|dsh|workbuddy|cursor> [--dir <workspace>] [--role …]`（P3 §7.1）
```

`KNOWN_HOSTS` 改为：

```typescript
export const KNOWN_HOSTS = ["codex", "claude-code", "dsh", "workbuddy", "cursor"] as const;
```

`PERSONA_FILE` 增加一行，放在 `workbuddy` 那一项后面：

```typescript
  workbuddy: null,
  // Cursor 的人设是仓库里的 .cursor/rules 与 .cursor/skills，不写工作目录
  cursor: null,
```

在 `dshSteps` 函数前面增加：

```typescript
function cursorSteps(): string[] {
  return [
    "仓库里的 .cursor/mcp.json 已经指向转发器，不用再手写配置。",
    "它启动 node，参数是 ${workspaceFolder}/bin/autocrew.mjs 和 mcp。",
    "环境变量 AUTOCREW_HOST=cursor，转发器只读上面这份令牌，不回落到 server-token。",
    "",
    "1) 确保 AutoCrew 在跑：npm start",
    "2) 用 Cursor 打开本仓库，重载 MCP。服务器名是 autocrew。",
    "3) 写稿、改稿、审稿、发布时按 .cursor/skills 里的技能做。",
  ];
}
```

上面的 `"它启动 node，参数是 ${workspaceFolder}/bin/autocrew.mjs 和 mcp。"` 必须是普通双引号字符串，不要写成模板字符串，否则 TypeScript 会把 `${workspaceFolder}` 当成变量。

`hostInstructions` 里选择 `steps` 的三元表达式改为：

```typescript
  const steps = host === "codex"
    ? codexSteps(tokenPath, endpoint)
    : host === "claude-code"
      ? claudeCodeSteps(tokenPath, endpoint)
      : host === "cursor"
        ? cursorSteps()
        : dshSteps(tokenPath);
```

`personaLines` 在读取 `role` 之前先处理 cursor，这样非法 `--role` 也不会写文件：

```typescript
function personaLines(host: KnownHost, options: HostCliOptions, home: string): string[] {
  if (host === "cursor") {
    return [
      "Cursor 的人设在仓库里的 .cursor/rules/autocrew-host.mdc 与 .cursor/skills，",
      "不写工作目录。--dir 这次被忽略。",
    ];
  }
  const dir = options.dir as string;
  const role = options.role ?? "editor-writer";
  if (!isKnownRole(role)) {
    return [`--role ${role} 不认识。可用：${HOST_ROLES.join(" / ")}`];
  }
  if (host === "dsh" || host === "workbuddy") {
    return [
      "dsh 的人设在 preset 里（adapters/dsh/agent-presets/autocrew/agent.cordis.yml），",
      "随插件 apply 一起装，不写工作目录。--dir 这次被忽略。",
    ];
  }
  try {
    const { file, outcome } = writeHostPersona(host, dir, role, options.personaDir);
    return [
      `人设「${role}」${OUTCOME_TEXT[outcome]}：${tildify(file, home)}`,
      `段落夹在 ${PERSONA_START} / ${PERSONA_END} 之间，重跑本命令即更新这一段。`,
    ];
  } catch (err) {
    return [`人设没写成：${err instanceof Error ? err.message : String(err)}`];
  }
}
```

`home` 在函数后半段仍会用到，签名不要改。。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/desktop/host-cli.test.ts`

Expected: PASS（原有用例加上上面三条）。

- [ ] **Step 5: Commit**

```bash
git add src/desktop/host-cli.ts src/desktop/host-cli.test.ts
git commit -m "$(cat <<'EOF'
feat: register cursor as a named MCP host

Issue a cursor token and print the repo-local MCP steps without writing a workspace persona.
EOF
)"
```

只添加这两个文件。

---

### Task 2: 提交 MCP 配置、技能链接、宿主规则和 README

**Files:**
- Create: `.cursor/mcp.json`
- Create: `.cursor/rules/autocrew-host.mdc`
- Create: `.cursor/skills/<name>`（相对符号链接，无文件副本；名单从 `skills/` 现读，不写死）
- Create: `src/desktop/cursor-workspace.test.ts`
- Modify: `README.md`（「接宿主」一节）

**Interfaces:**
- Consumes: Task 1 的命令文案。本任务不调用 `hostInstructions`。
- Produces: `.cursor/mcp.json` 的 `env.AUTOCREW_HOST === "cursor"`。`.cursor/skills` 下每个链接目标为 `../../skills/<同名>`。规则文件含 spec §7 的四句事实，且 `alwaysApply: false`。

- [ ] **Step 1: Write the failing test**

新建 `src/desktop/cursor-workspace.test.ts`：

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/desktop/cursor-workspace.test.ts`

Expected: FAIL。读 `.cursor/mcp.json` 时报 ENOENT。

- [ ] **Step 3: Add the MCP config, the rule, and the skill links**

写入 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "autocrew": {
      "command": "node",
      "args": ["${workspaceFolder}/bin/autocrew.mjs", "mcp"],
      "env": {
        "AUTOCREW_HOST": "cursor"
      }
    }
  }
}
```

写入 `.cursor/rules/autocrew-host.mdc`：

```markdown
---
description: 通过 AutoCrew 写稿、改稿、审稿或发布时使用。修改本仓库代码时不用。
alwaysApply: false
---

当前宿主是 `cursor`，工具面与 `claude-code` 相同。

`adapters/codex/AGENTS.editor-writer.md` 开头的 Codex 停用说明不适用于本宿主。

写稿、审稿、发布的步骤以 `.cursor/skills` 里对应技能为准。

唯一写盘进程是本机 AutoCrew 服务。不直接改资料库里的稿件文件来绕过工具。
```

在仓库根执行（已存在的同名链接先删掉再链，避免 ln 把新链接塞进旧目录）：

```bash
mkdir -p .cursor/skills
for name in $(ls skills/); do
  [ -f "skills/$name/SKILL.md" ] || continue
  rm -rf ".cursor/skills/$name"
  ln -s "../../skills/$name" ".cursor/skills/$name"
done
```

名单从 `skills/` 现读，新增或删除技能时不用改这份名单，也不会留下指向已删除目录的悬空链接。

`git add` 这些路径时，Git 应记录符号链接本身（`120000`），而不是把 `skills/` 里的文件再存一份。提交前用 `git ls-files -s .cursor/skills | head` 看模式是否为 `120000`。若某条是 `100644`，说明链成了普通文件，删掉重做 `ln -s`。

- [ ] **Step 4: Document the host in the README**

`README.md` 三处：

标题改为：

```markdown
### 接宿主（Claude Code / Codex / WorkBuddy / dsh / Cursor）
```

命令示例改为：

```bash
npm start                 # 先起服务（令牌目录由它创建）
autocrew host codex       # 或 claude-code / workbuddy / dsh / cursor
```

宿主表在 dsh 那一行后面增加：

```markdown
| Cursor | 用 Cursor 打开本仓库。`npm start` 之后执行 `npx autocrew host cursor` 发令牌，再重载 MCP。配置已在 `.cursor/mcp.json`，技能经 `.cursor/skills` 链到 `skills/` |
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/desktop/cursor-workspace.test.ts src/desktop/host-cli.test.ts`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add .cursor/mcp.json .cursor/rules/autocrew-host.mdc .cursor/skills src/desktop/cursor-workspace.test.ts README.md
git commit -m "$(cat <<'EOF'
feat: expose AutoCrew to Cursor inside this repo

Commit the project MCP entry, editorial skill symlinks, and an on-demand host rule.
EOF
)"
```

只添加上面这些路径。

---

## Self-review

- Spec §4 使用方式、无 `server-token` 不发令牌、`--dir` 忽略：Task 1。
- Spec §5 `.cursor/mcp.json` 与 `AUTOCREW_HOST`：Task 2。
- Spec §6 技能链接：Task 2 的测试与 `ln` 循环都从 `skills/` 现读名单，一致。
- Spec §7 规则四句与 `alwaysApply: false`：Task 2。
- Spec §8 `host-cli` 与 README：Task 1 与 Task 2。`host-policy.ts` 明确不改。
- Spec §9 五条测试：Task 1 三条，Task 2 两条（链接与 mcp.json）；规则断言是 §7 的锁，多出来的不是第二套流程。
- Spec §3 不做的事项写在 Global Constraints。转发器与令牌权限不新写代码。

## 不做

正向接入（网页总编辑拉起 Cursor SDK）没有 spec，也不在本计划里。讨论完正向之后另写一份 spec 和计划。
