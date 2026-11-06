# 中文排期后的 Codex 后台派生 · 设计卡

目标：本条中文目标平台完成排期后，公众号与英文版各有一条持久任务和一个真实 Codex 会话。采用确定性工作流，不增加总调度模型。用户已指定 Codex；执行器继承现有 ChatGPT 订阅登录及权限设置。

成功证据：outbox 保存源 ID、轮次、成片身份、目标集合、实际回执引用、派生稿 ID、原生 threadId 和开工 turnId。任务接受不代表文章、英文成片或投稿完成。

| 不变量 | 代码责任 | 验收场景 |
|---|---|---|
| 所有必发中文平台都有当前有效排期或公开回执 | eligibility | 3/4 不启动；纠正、驳回、旧轮次不启动 |
| 同源、轮次、成片、派生类型不重复建任务 | store/reconcile | 并发检查、重复回执、scheduled→public 不重建 |
| 先保存 dispatching，再调用宿主；先保存 threadId，再提交 turn | worker/adapter | 创建后 ACK 丢失、提交超时 |
| 创建结果不明时只核对，不自动再次创建 | worker | 唯一 cwd 查到一条则绑定，零条或多条保持 unknown |
| 复用已有派生稿，旧成片绑定需走 rebind | worker/lineage | 崩溃后复用；换版后阻断旧稿 |
| 宿主和授权不由模型猜；中文排期不授权英文投稿 | policy/brief | 未配置、停用、目标变化；brief 保留审核和发布时间边界 |
| 未读到文件不能清空旧任务或 threadId | store/status | 损坏文件显式错误 |
| 服务启动补漏，原会话关闭不影响队列 | cycle | 重启恢复 queued；持久 session 可查询与接管 |
| 远端准备结束后再核验来源，ACK 必须含相同会话及轮次 | worker/codex-host | 命名等待期间关闭策略不发 turn；错 ID / 缺 turnId 回 unknown |
| 人工等待原因不被成功 ACK 或恢复结果覆盖 | worker/service | launch、resume、recover 三条路径保留 attention |
| 并发通知不丢失，新尝试不被旧历史读回覆盖 | cycle/worker | dirty drain、当前 workspace 重核、attempt fence |
| 请求在途与回执未知仍占用并发容量 | codex-host/cycle | 无 ACK 或通知仍占位；稳定空闲、匹配终态或自有进程关闭后释放 |

状态：queued、leased、dispatching、started、blocked、unknown、cancelled。租约含 owner/epoch/到期时间；外部 I/O 在锁外。已发送任务超时不回 queued。取消或换版不停止已打开的用户会话，也不删除原稿。

预算：每轮最多启动两个任务；宿主请求有明确超时；创建调用不自动重试。低频扫描补漏，事实变更唤醒。任务从全局开关启用后的新排期产生；已有视频只在明确指定时补入，避免批量回溯旧作品。

用户界面复用设置与主题去向行。展示等待、阻断、结果未知、真实会话以及读取历史；不新增活动墙。原生桌面深链只作尽力打开，产品内历史读取才是可验证入口。

独立官方 App Server 是服务拥有的 Codex 执行进程。它使用现有登录，不复制 token、不替换模型供应商、不降低 approval/sandbox。遇到需要人工批准的宿主请求，显式记录并停下，不自动批准。

测试与接线使用隔离库和 fake transport。确定性 harness 的验证不能当作模型创作质量或原生桌面接手已验收。真实任务、输出与发表仍按各自既有工作流核验。

## 使用与兼容

在「设置 → 平台」启用自动派生。开关默认关闭。当前主题可在管线详情中检查并补齐，公众号和英文版分别保留真实 threadId。任务只处理已冻结的本条去向；两条线可同时开工，但最终文章、成片、发布时间和投稿仍各走原有确认流程。

任务窗口只展示用户与助手文字的分页预览，不展示命令或工具原始输出。服务使用独立的官方 Codex App Server child；关闭这条前台聊天不删除持久队列。原生 Codex 深链是尽力打开，不能把它当作桌面接管成功的证据。关闭自动派生不会杀掉已有会话，手动继续仍检查当前源成片、轮次与平台去向。

前台技能先读取 `autocrew_content derivative_status`。后台开启时只由服务创建会话。后台关闭时仍核对已保存任务，再决定是否走旧的手动接力。新增 MCP 动作只读，不接受自由 prompt 或任意 threadId，不提供创建入口。

## 本机只读核查与验收边界

2026-10-28 分别核查全局 Codex CLI 0.153.4 与 App 内置 CLI 0.165.0-alpha.1.2。两者均返回 ChatGPT 登录，但有效默认供应商是自定义路径。当前 adapter 会明确阻断，不改全局配置，也不自动回退到 API。真实探测只执行 initialize、account/read、config/read；没有创建线程或运行模型。探测进程已关闭，原生 App 进程未动。

订阅登录、默认配置和实际线程供应商是不同证据。只有核到原生 openai 路径才允许自动开工。若用户另行授权专用于后台会话的配置，再单独实施；本候选没有切换供应商。

确定性验收覆盖身份绑定、租约、来源与字幕、排期回执、并发、结果未知、恢复、授权窗口、人工等待原因、HTTP 会话与同源限制、UI 旧读取隔离及分页。验收报告区分测试替身和真实宿主。当前结论为 **harness verified, model behavior not evaluated**，没有声称公众号或英文版内容已经生成。

探测阶段曾因 Claude CLI 参数组合在显示帮助前误启一个空后台会话。该会话已立即停止、删除并只读确认移除，没有提交创作或模型任务。此后停止所有 Claude 探测。

Ego Lite 隔离界面验证已通过：开关关闭→启用→关闭、同源两条任务、未知结果没有重开按钮、历史第二页与分页提示、仅向已绑定的同一假 thread 续办一次。关闭策略后保留任务和会话。测试使用真实 HTTP handler、store 和本候选 frontend/dist，history/resume 使用固定假数据；浏览器 JavaScript 错误为零。TaskSpace 24 和自建测试服务已关闭，4317 与生产库未动。

最终 `npm run check` 通过：699 个文件、8,364 项测试全部通过；后端与前端类型检查通过；lint 0 错误、127 条既有警告。前端生产构建通过，保留原有大包体提示。两个修改过的技能均通过 `quick_validate.py`。新增只读 `derivative_status` 动作已同步工具契约快照；没有放宽校验或权限限制。

验证记录：`~/.cache/autocrew-yt/audits/20261028/derivative-check-release.log`、`ui-dispatch-smoke-new/result.json`、`host-sessions/codex-adapter-live-readonly.json`、`host-sessions/codex-app-cli-live-readonly.json`。本批停在独立分支候选，未合并、重启或推送。
