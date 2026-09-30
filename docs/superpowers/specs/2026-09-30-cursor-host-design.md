# Cursor 反向接入：仓库内 MCP 宿主

> 日期：2026-09-30
> 状态：待审
> 范围：只做反向。正向（网页总编辑拉起 Cursor SDK 本地 agent）另开一份 spec，不在本分支。

## 1. 一句话

在 AutoCrew 仓库里打开 Cursor 时，Cursor 通过已提交的 `.cursor/mcp.json` 连上本机 `:4317/mcp`，以命名宿主 `cursor` 调用编辑部工具；写稿流程由现有 `skills/` 提供，Cursor 经符号链接自动发现它们。

## 2. 已定决策

- 配置只放项目级 `.cursor/mcp.json`。不写用户级 `~/.cursor/mcp.json`，设置页不加「连接 Cursor」按钮。
- 传输用现成的 stdio 转发器 `bin/autocrew.mjs mcp`。令牌不进仓库、不进命令输出。
- `AUTOCREW_HOST=cursor`。转发器因此只读 `~/.autocrew/tokens/cursor.token`，不回落到 `server-token`。删掉该文件后调用返回 401。
- 工具权限与 `claude-code` 相同。`mcp/host-policy.ts` 对 Codex 的写稿禁令不适用于 `cursor`。
- 根上的 `AGENTS.md` 不改。它继续只服务「开发这个仓库」。
- 技能正文只留在 `skills/`。`.cursor/skills/<name>` 是指向 `../../skills/<name>` 的相对符号链接，19 个目录各一条。
- 规则 `.cursor/rules/autocrew-host.mdc` 设 `alwaysApply: false`。正文只说明宿主身份，不复述写稿步骤。写稿步骤以技能为准，避免和 `write-script` 各写一套。

## 3. 不在本期

- 网页总编辑切换器里的「本机 Cursor」，以及 `@cursor/sdk`。
- 用户级 MCP 配置、设置页按钮、把人设写进某个 `--dir` 的 `AGENTS.md`。
- 复制或改写 `skills/` 正文。
- 把微信视频号 / 小红书统计的未提交改动带进这个分支的提交。

## 4. 使用方式

1. 在仓库里 `npm start`，等本机服务起来。
2. `npx autocrew host cursor`。服务从未启动（数据目录里没有 `server-token`）时，只提示先 `npm start`，不创建令牌。否则确保 `tokens/cursor.token` 存在（0600），并打印路径和下面三步，令牌值不出现。
3. 在 Cursor 里重载 MCP。`.cursor/mcp.json` 已在仓库中，不需要再手写配置。
4. 守护进程没起时，转发器回现有的「AutoCrew 服务没有运行，先在仓库里执行 npm start」。

`--dir` 对 `cursor` 无效。命令说明人设在 `.cursor/rules` 与 `.cursor/skills`，这次不写工作目录。

## 5. `.cursor/mcp.json`

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

`${workspaceFolder}` 是 Cursor 对项目 MCP 配置的变量。这样转发器不依赖进程的当前目录。

稿件上的 `writtenBy.host` 来自令牌文件名，记为 `cursor`。

## 6. 技能链接

对下面每个名字建立 `.cursor/skills/<name>` → `../../skills/<name>`：

`calibrate`、`content-review`、`cover-generator`、`humanizer-zh`、`manage-pipeline`、`memory-distill`、`onboarding`、`platform-rewrite`、`pre-publish`、`publish-content`、`research`、`spawn-batch-writer`、`spawn-planner`、`spawn-writer`、`style-calibration`、`topic-ideas`、`video-session`、`write-script`、`xhs-cover-review`。

链接进 Git。不把技能目录复制进 `.cursor/skills`。这些技能已有 `name` 与 `description` 前置信息，Cursor 按描述在相关对话里读取正文。在本仓库里开发时，技能列表里会出现这 19 条描述；正文仍然是用到才读。

## 7. 规则正文

`.cursor/rules/autocrew-host.mdc` 的描述写明：通过 AutoCrew 写稿、改稿、审稿或发布时使用；修改本仓库代码时不用。

正文只包含这些事实：

- 当前宿主是 `cursor`，工具面与 `claude-code` 相同。
- `adapters/codex/AGENTS.editor-writer.md` 开头的 Codex 停用说明不适用于本宿主。
- 写稿、审稿、发布的步骤以 `.cursor/skills` 里对应技能为准。
- 唯一写盘进程是本机 AutoCrew 服务。不直接改资料库里的稿件文件来绕过工具。

## 8. 代码改动

- `src/desktop/host-cli.ts`：`KNOWN_HOSTS` 加入 `cursor`。`PERSONA_FILE` 为 `null`。`hostInstructions` 增加 Cursor 的说明文字。`--dir` 走与 WorkBuddy 同类的「忽略」分支，但文案指向 `.cursor/rules` 与 `.cursor/skills`，不复用 dsh 的 preset 说明。
- `README.md`「接宿主」表增加 Cursor 一行：打开本仓库、`npm start`、`npx autocrew host cursor`、重载 MCP。

`mcp/host-policy.ts` 不用为 `cursor` 加特殊分支。未点名的命名宿主已经走与 `claude-code` 相同的策略。

## 9. 测试

- `autocrew host cursor` 在已有 `server-token` 时打印令牌路径与 `.cursor/mcp.json`，输出中不含令牌文件的内容。
- 没有 `server-token` 时不创建 `tokens/cursor.token`。
- 带 `--dir` 时不改目标目录的 `AGENTS.md`。
- 一条测试读 `.cursor/skills`：19 个条目都是符号链接，目标为 `../../skills/<同名>`，且目标目录里有 `SKILL.md`。
- 一条测试读 `.cursor/mcp.json`：`command` 为 `node`，args 含转发器与 `mcp`，`env.AUTOCREW_HOST` 为 `cursor`。

## 10. 分支

实现落在 `feat/cursor-host`，从当时的 `origin/main` 切出。本地 `origin` 仍是 `alextangson/AutoCrew`（只能拉）。推送目标是 `fork`（`archlizheng/AutoCrew`）。源仓库更新用 `git fetch origin` 再合进本分支。你确认这份 spec 之后再写实现计划。PR 打开之后由源仓库作者决定是否合并。
