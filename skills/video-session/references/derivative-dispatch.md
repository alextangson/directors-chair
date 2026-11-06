# 中文排期完成后的派生会话衔接

同一批中文目标平台全部有真实 `scheduled` 回执后，先检查本次明确的排除项、现有派生稿和已有会话。源稿、派生稿、会话和平台回执是不同事实；逐一核对，不用同名标题当身份。不要因单个平台失败或回执未知而认定整批排期完成。

先用 `autocrew_content action=derivative_status`，带源 `content_id` 读取策略与持久任务（summary 也会给简要指针）。`policy.enabled=true` 时，后台服务是会话创建者，前台不要再调用宿主创建工具。分别转述 queued、blocked、unknown、started 与真实 threadId；started 只表示开工消息已被接受，不表示制作或发布完成。任务暂未出现时核对本条去向、成片、字幕和真实排期回执；已有视频需在主题展开区明确「补入派生队列」。读取失败、结果不明或只有深链时都不能另开一套。查看与继续已有真实会话走主题展开区，保留原 threadId。

只有明确读到后台策略关闭时，才走下面的宿主手动接力。已存在的后台任务或会话仍须查重，不能因开关关闭就重建。新版后台 outbox 位于源项目 `00-project/autocrew/derivative-outbox.json`，由服务写；不要手工编辑它。旧的 `06-publish/derivative-dispatch.json` 仍是历史手动接力记录，应同时保留核对。

1. 从项目发布计划、AutoCrew 及宿主会话列表读已有状态。项目 `06-publish/derivative-dispatch.json` 按源 `content_id` 分别记录 `wechat_article` / `en_edition`：派生 content_id、会话 ID 或待创建标记、宿主、状态和错误。保留其他版本和已有记录；不要以空结果覆盖已记录会话。文件不是创建成功的证据，结果不明时查宿主后再决定下一步。
2. 对未排除的线调用幂等 `derive`，仅在已审过的源成片可用时继续。回 `line_not_enabled`、`no_approved_cut`、`source_deleted` 或 `derived_stale` 时照原始结果处理；不替用户开启席位，不删旧稿或抢占会话。派生稿已存在就复用。
3. 使用宿主当前支持的创建和查重工具。Codex 桌面使用 `mcp__codex_app__list_threads` / `list_projects` / `create_thread`；创建工具只在用户明确要求创建新任务、且其授权覆盖此源视频和两条线时可用。选择与项目相符的 projectId；不凭名字猜项目。Claude 桌面在其真实可用时用 `mcp__ccd_session_mgmt__list_sessions` / `mcp__ccd_session__start_session`，按宿主契约传参。工具不可用、授权不覆盖或项目对不上时记录待办，给用户具体可复制的启动说明，不换宿主或声称已开工。
4. 为每条线分别建立一个会话。brief 写源稿与派生稿 ID、项目根、已核定成片及字幕身份、用户的工作目标，以及 `video-session` 里相应的公众号或英文版步骤。要求复用现有稿、保留回执、遇付款或平台确认按实际约束处理；不得把中文排期时间或中文投稿授权当作英文发布时间和英文投稿授权。
5. 建立成功即保存实际返回的 threadId / session ID；若只返回等待初始化的 clientThreadId，仅标记创建中，不能当已启动 ID 或用于后续操作。重试前先查记录和宿主状态。成功、创建中、失败分别报告，不要把任务接受等同成片、发布包或平台回执。

公众号会话可准备稿件和整包。视频号原片未公开时，保留 `video_not_live` 等待点；可用的正规唤醒机制须有真实 ID 才能称为已设置。英文会话以 YouTube / X 为目标，但发布前按实际工作流核定授权、时间、费用、成片与发布包。不要为了减少交互伪造批准、跳过产品拦截、扫码或版权结果。
