# Retire engine-side research (2026-10-28, founder-confirmed)

## Why

Research now runs in the host (Claude Code / Codex) with its own search tool
(ego lite). AutoCrew only fetches pages (`read_page`) and verifies quotes
(`cite`). The background-engine research line (Bocha/Tavily key in
`search.json` + the scout endpoint) is a second, unused path that still forces
users to configure a search key and clutters settings. Remove it.

## Scope — remove / change

1. **Web research panel** (`frontend/src/views/ResearchPanel.tsx`): remove the
   "深调研 / 重跑深调研 / 重试深调研 / 重新立意" buttons and the
   `research:deep_dive` / `research:regenerate_angles` calls. Replace with a
   `HandOffButton` in a new `research` mode. Existing briefs stay readable
   ("看简报", angle cards still selectable).
2. **HandOffButton research mode**: add a third mode `"research"` next to
   `"write"` / `"look"` (front + backend `handOffContent` path). The handed-off
   instruction text is 「给《<title>》开选题会」. No AI connected → same
   behaviour as today ("先接一个 AI"), never pretends to have handed off.
3. **ChatDock / chat-router**: drop `deep_research`, `regenerate_angles`,
   `scout_inspiration` from the chief-editor tool table. If the founder asks for
   research there, the chief editor says it hands this to Claude/Codex (use the
   existing handoff, or reply in words — keep it simple).
4. **Telegram daily digest reply-a-number** (`src/desktop/digest-reply.ts`):
   instead of `triggerDeepResearch`, mark that topic as "待开选题会" (reuse an
   existing topic field/flag if one fits; otherwise smallest addition) and reply
   「已记下《X》，到 Claude 会话里说『开选题会』」. Keep: stale-list date prefix,
   out-of-range reply, no inbox entry for pure numbers.
5. **MCP**: remove `execution=engine` research from `autocrew_workflow`
   (`src/tools/workflow.ts`) and the engine-evidence branch in
   `src/tools/writer.ts` — host mode only. Remove the `SEARCH_NOT_CONFIGURED`
   hint in workflow status. Tool descriptions/guides must stop mentioning
   engine research.
6. **Legacy engine writing** (`src/modules/writing/generate-script.ts` targeted
   lookup, `targeted-research.ts`): delete the targeted-research step; engine
   ghost-writing uses existing materials only (no "未补证" note path for missing
   search — the step no longer exists).
7. **Campaign agent-runner** (`src/modules/campaign/agent-runner.ts`): remove
   the web-search tool. A task that needed search fails with a visible reason,
   never silently returns empty.
8. **Backend removal**: `research-runtime` engine job posting,
   `research-runner`, `scout-search`, the search half of `research-broker`
   (keep page fetch + cache + quote validation used by host mode),
   `search-provider` (`searchWeb`, `searchAvailable`, `SEARCH_NOT_CONFIGURED`,
   load/save), IPC channels `research:deep_dive`, `research:regenerate_angles`,
   `settings:search_get`, `settings:search_set` (channels.ts,
   channel-contracts.ts, ipc.ts, long-running.ts classification),
   `searchConfigured` in research status. Delete dead code and its tests; do not
   leave shims.
9. **Settings page**:
   - 「接入更多」: delete the 搜索 · 博查 / Tavily card.
   - 「模型」tab keeps only `EngineSection` (endpoint table, main, fallback,
     role assignments).
   - New tab 「本机」 holds: SettingsUpdate, SettingsStorage,
     SettingsArollSources, SettingsJianying, SettingsAsr, 工作区, 知识库, and the
     「更多」 page links. Tab order: 运营平台 · 模型 · 本机 · 接入更多 · 数据回流.
     Deep links that used `tab: "models"` for those sections must land on 本机.
   - Role `scout`: label 「调研专线」→「雷达专线」, note → 「雷达筛选、灵感提炼」
     (front `engine-lib.ts` and backend `ENGINE_ROLE_LABELS`, plus the
     `ROLE_PREFIX_RE` in engine-lib). Role key stays `scout` (config compat).
10. **Docs & skills**: remove "configure a search key" guidance from
    `skills/research`, `skills/topic-ideas`, `skills/manage-pipeline`,
    `skills/spawn-writer`, `skills/video-session`, README. Old dated specs under
    `docs/` are history — leave them.

## Keep untouched

- Page fetch / `read_page` / `cite` / `verify_quote` / evidence ledger.
- Radar and intelligence sources (RSS, X, Reddit, YouTube) and their keys.
- The user's `search.json` on disk: stop reading it, never delete it. Leaving it
  in `CONFIG_FILES` (library-manager) is fine.

## Edge cases (acceptance list)

- Engine research jobs queued/running at upgrade: on startup (or on read) mark
  them failed with reason 「引擎调研已下线，请交给 AI 调研」. Never left in
  "running" forever. Research status UI shows that reason.
- Old briefs: still readable; angle selection still works.
- No AI connected: research handoff button clickable, says 「先接一个 AI」.
- Double-click on the handoff button: guarded (existing `busy` pattern).
- Digest reply when the digest list is stale / number out of range: existing
  replies preserved.
- Campaign task needing search: visible failure, not empty success.
- Typecheck, lint, vitest all green; tests for removed code deleted, tests for
  new behaviour added (research handoff mode, digest reply marking, stale job
  failing, settings tab split, scout label).

## Constraints

- Functions < 50 lines, files < 500 lines.
- No feature flags, no compat shims.
- External failures surface a visible state.
