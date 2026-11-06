# 比稿：Claude 和 Gemini 各写一版全文（试行）

2026-11-06 · 状态：待创始人确认

## 要回答的问题

在现在的抖音口播写稿流程里，加一个 Gemini 写同一篇全文，创始人盲选时它能不能赢。先试 5 篇，看胜率决定留不留。立意和洞察在第 3 步就定了，比稿比不到；这里比的是措辞、节奏和钩子。

## 范围

- 只接 `write-script`（抖音口播）第 5 步「写全文」，在创始人选定立意和开头之后。
- 走 Gemini 官方 API（Antigravity CLI 账号地区不可用，且只给 3.8 Flash）。
- 不做：立意和开头阶段的比稿；其他平台旧写稿流程；模型评委自动替创始人选；战绩面板；开关设置。试行结束不留的话，删掉技能里这一节和 `rival` 动作。

## 流程（write-script 第 5 步）

1. 主会话照常写自己那版并 `save` 成第 1 版（不变）。
2. 随即调 `autocrew_draft{action:"rival", content_id, base_version}` 启动 Gemini 写稿，立即返回 `rival_id`；主会话接着给自己那版做试读，不等结果。没存第 1 版时拒 `needs_host_draft`。
3. 主会话用 `rival{content_id, rival_id}` 取结果：`running` / `done{body}` / `failed{reason}`，最多等 10 分钟。
4. 两版各做一次观众试读（各起一个不继承会话的新子代理，只给正文）。
5. 主会话用同一标准检查两版：编造的亲历（不在 `firsthand` 和创始人原话里的「我/我们做过」）、证据台账以外的数字和引述、`format_warnings`。只标出来，不改。
6. 随机排成 A/B 给创始人：两版全文、各自试读、标出的问题。不说谁写的，不给推荐。
7. 创始人选：
   - 选主会话那版：`save{body:<第 1 版原文>, rival_pick:{rival_id, picked:"host", founder_words}}`
   - 选 Gemini 那版：`save{body:<Gemini 原文>, rival_pick:{rival_id, picked:"rival", founder_words}, test_read}`，这一版记为 Gemini 写的
   - 让拼：主会话按他的话拼好再存，`rival_pick.picked:"merged"`，记为主会话写的，版本备注「拼自两版」
8. 之后第 6 步照常由主会话改。
9. 回执带战绩，主会话每篇告诉创始人一句；第 5 篇后提醒他定去留。

Gemini 没配好（没 key）时整节跳过，只在本篇告诉创始人一次。

## 服务端

### `rival` 动作

- **前置**：已记立意、已选开头；否则按现有 `needs_angle` / `needs_opening` 拒。
- **简报由服务端拼**，只用锁住的依据，和主会话拿到的同源：档案底线（`rules` / `never`）、立意（主线、给谁看、论证链、为什么可能爆、创始人原话）、选定开头、锁定的体裁手册全文、锁定范文全文、锁定写法全文、`founder_edits` 改稿对照、`voice_refs`、`firsthand`、证据台账里已核验的引文和数字。写作指令：只出能直接念的正文；开头原样用；没有素材不编亲历；台账以外的数字和引述不写；开头和立意许诺的内容必须讲完。简报不含主会话的稿，只给它的字数当篇幅（上下 20%）。
  - 2026-11-06 真稿实测加的：不给篇幅时 Gemini 只写了主会话一半的字数，开头许诺的「从夯到拉排一遍」没兑现，盲选时比的就不是写法了。
  - 主会话还有对话上下文（调研过程、创始人随口说的话），Gemini 没有。这是有意的：试行要回答的是「加上 Gemini 能不能比现在更好」。
- **模型**：默认 `gemini-3.1-pro-preview`（这把 key 已实测可用），环境变量 `AUTOCREW_RIVAL_MODEL` 可换。
- **Key**：`GEMINI_API_KEY` 环境变量 → 设置·写稿比稿里的「Gemini Key（写稿比稿用）」（独立文件 `rival.json`，0600，IPC `settings:rival_get/set`，get 只回掩码）。不读 `cover.json`。
  - 11-06 创始人定：封面不用 Gemini，继续走 Codex 订阅，所以比稿的 key 不和封面设置耦合。
- **异步**：启动即返回；状态和结果落盘到这篇稿的记录里。服务重启时还在跑的标 `interrupted`，可以重新发起。
- **幂等**：同一篇、同一份简报（按简报 hash）已在跑或已完成，返回同一个 `rival_id`，不重复请求。立意或开头改过后，旧结果标 `stale`，不能被选。
- **失败要看得见**：没 key 回 `not_configured` 加去哪配；402 回「Gemini 账户余额不足」；429/5xx 按 `Retry-After` 重试一次；其他错误或 10 分钟超时回 `failed` 加原因。主会话照实告诉创始人，只交自己那版。
- **费用**：回执带 token 用量和按官网单价估的美元数，注明不是实际账单。

### `save` 新参数 `rival_pick`

- `picked:"rival"`：正文必须和存下的 Gemini 稿逐字一致，否则拒 `rival_body_mismatch`（想改就先选，再按第 6 步改）。这一版的 provenance 记 Gemini 和模型名，`founder_edits` 照常学创始人对它的修改。
- `picked:"host"` / `"merged"`：provenance 照旧是调用方。
- 记下：picked、`founder_words`、两版试读状态。同一个 `rival_id` 只能选一次；`stale` 的不能选。
- 战绩从各稿的比稿记录数出 `{total, rival_wins, host_wins, merged}`，在 `rival` 和 `rival_pick` 的回执里带上。

## 验收清单

1. 没配 key：`rival` 回 `not_configured`，主会话照常单稿，只告诉创始人一次。
2. 402、超时、连续 5xx：回 `failed` 和原因，主会话说出来；不会悄悄只给一版。
3. 重复调 `rival`：同一个 `rival_id`，Gemini 只被请求一次。
4. 立意或开头改了：旧 Gemini 稿 `stale`，选它被拒；拼简报期间改了，回 `angle_changed`，不登记旧简报。
5. 选 Gemini 版但正文改过：拒 `rival_body_mismatch`。
6. 同一比稿选第二次：拒。
7. 服务重启：`running` 变 `interrupted`，能重新发起。
8. 选中的 Gemini 版 provenance 是 Gemini；创始人之后改它，改稿对照照常记录。
9. 给创始人看的 A/B 不带作者，不带推荐。
10. 战绩数字和各稿记录一致。
11. 简报里没有主会话的稿，只有字数；锁定的写法或范文读不出来就拒，不调 Gemini。
12. 单测全部 mock Gemini HTTP；真模型验收跑一篇真实稿。
13. Gemini 没正常写完（`finishReason` 不是 `STOP`，或简报被拒）：回 `failed` 和原因，半截稿不能选。
14. 选中 Gemini 版后，正文不变只附试读或意见：作者仍记 Gemini。

## 已知取舍

- 主会话那版照常先存成第 1 版，工作台里看得到。创始人在选之前去工作台看，就会知道哪版是 Claude 的。
- 每篇多一次 Gemini 调用（按 3.1 Pro 单价，简报约 3–5 万 token、输出加思考约 1 万 token，估每篇 0.2 美元上下），多读一版稿。
- 简报（含一手素材和未发布的立意）会发给 Google，创始人已接受走官方 API。
