# 1.2.3-rc 桌面验收清单

状态：**2026-11-20 用户桌面实测完成，部分通过**。冻结点为 main `dee66e28`（含之前全部代码），构建提交 `4dff9e6e`（Next 构建 `mQLVfy89bbGAyzULjJAiB`）。冻结后追加 D4 长任务（`62158e4c`）、错误提示合并（`57f0251a`）、简历证据保存（`1149f436`）均已入 Main。A 组、C4 定向复验 PASS；B 组部分通过（删除页面 FAIL，见 B-1）；C 组 FAIL（Devin 版本漂移，见 C-1）；F 组（三项追加功能）全部 NOT_RUN；详见「2026-11-20 用户桌面实测记录」节及「验收结论与发布就绪判断」节。未打 tag、未发布。2026-11-21：B-1、C-1 及验收中新发现的三项缺陷已有代码修复入 Main（`7a827cb4`、`6d9e1638`），均待新安装包桌面复验，见「修复进展与复测状态」节。

规则（摘自 RELEASE_RUNBOOK §4）：结论须标注所测安装包的构建提交；只认 Windows Electron 实测；一律使用隔离数据根，不碰用户安装版数据；台账 `passes` 只在对应 Feature 全部步骤通过后由 Main 集成 Owner 更新。

## 预验收结果 @ `0f9c4659`（2026-11-19，Windows Electron fresh-native，隔离数据根）

仅作参考，正式结论以冻结构建为准。证据在验收快照 `.worktrees/rc-1-2-3-accept/.tmp/rc-1-2-3-accept/runs/` 与 `.tmp/desktop-e2e/72d76f05-…/`。

- PASS：C4 backup-native 8/8（驱动修正后）；A1 面板 X／Esc／Header 三路径；A4 开关面板不触发模型；EXT-INTERVIEW-WEB 桌面入口隐藏与旧路由提示 ×4；AWU-DICTATION 设置页音频区存在（仅 UI）。
- FAIL → 已修复待复验：A2 停止后立即「重新生成」永久 409（停止的回合只持久化用户消息）——`a763f38e`；`/dashboard/extensions` 整页 500（服务端页面调用 `"use client"` 模块导出）——`9921b609`，阻断了 D5、Notion 卡片与 EXT-INTERVIEW-WEB 卡片检查。
- NOT_RUN：A1 右栏挤占（当前 UI 无第二个右栏持有者，路径不可达）；D1 面试准备去重；D6 `read_webpage`（需测试 URL）；D4 简历证据多轮。
- BLOCKED（需凭据或外部条件）：A4–A5 真实 `suggest_role`、D7 深度匹配真实模型、C1–C3 Codex 原生会话、B 组与 D3 Notion、D2 真实转写、EXT-INTERVIEW-WEB 目标 HTTPS 地址未定。
- 驱动修正：快照源码清单补 `release-notes`（`dee66e28`）；A 组夹具须用两段协议（decision JSON + answer）。

## A. 1.2.2-rc 缺陷修复复验（MVP / MULTI_AGENT_ONBOARDING）

复验清单原文见 `MVP_FEATURES.json` 中聊天复制/重新生成条目的 2026-11-19 记录：

1. **PASS**（2026-11-20 用户实测）四种关闭路径（面板 X、Esc、右栏挤占、Header 开关）在流式输出中关闭后，后台继续生成，重开可见续写或完成结果。
2. **PASS**（2026-11-20 用户实测）「停止」按钮仍是唯一的取消途径。
3. **PASS**（2026-11-20 定向复验）停止后立即「重新生成」，首次点击即开始，无冲突红条、无重复消息。详见 A2 记录。
4. **PASS**（2026-11-20 用户实测）跨领域请求：真实模型调用 `suggest_role`（核对工具调用记录，不信口述）→ 转交卡 → 点击切换角色，原文、粘贴卡、文件附件与手动上下文并入目标草稿，不自动发送。
5. **PASS**（2026-11-20 用户实测）目标角色使用自己的工具集与会话，附件与审批行为无回退。

**A2 定向复验 PASS（2026-11-20）**。Windows Electron fresh-native，隔离数据，源码 `4dff9e6e`，Next 构建 `mQLVfy89bbGAyzULjJAiB`。用本地模型夹具挂起实际在途回合，点击停止后保留同一用户消息。首次点击「重新生成」返回 HTTP 200，触发新上游调用并显示回答。SQLite 核对原会话只有原用户消息和一条新回答，无重复请求或冲突提示。证据：[A2 日志](../.tmp/rc-1-2-3-a2-c4/a2.log)。

## B. Notion（EXT-NOTION）

用户已在 1.2.2-rc（a43a25b0）实测连接、AI 读写、断开。1.2.3-rc 补测剩余步骤，清单细节见 [EXTENSIONS_IMPLEMENTATION](./EXTENSIONS_IMPLEMENTATION.md) §3「发布前验收 Checklist」：

1. **PASS**（2026-11-20 用户实测）能力交集：不支持工具调用的模型/运行时明确提示，不以文本冒充执行（step 4）。
2. **PARTIAL**（2026-11-20）异常面：取消批准远端无写 PASS；读/写未分享页面错误码 PASS；撤销授权重授权、断网写、限流 NOT_RUN（step 5）。
3. **NOT_RUN** 连续两次发起连接（第一次不完成），第二次仍能完成授权、回调不被提前关闭（`b151af79`）。
4. **NOT_RUN** 凭据边界：日志无 token；导出备份无 NotionConnection，恢复后为未连接（step 6）。
5. **PASS**（2026-11-20 用户实测）外发审阅：写提案展示外发内容预览，敏感字段默认不发（step 7）。
6. **FAIL**（2026-11-20）删除页面：22 页超 `AgentNotionDeletePagesSchema.targets` `max(20)` 上限，参数校验失败，工具调用未提交（见问题 B-1）。

## C. Codex 原生会话（AGENT-NATIVE-CODEX-V1）

1. **NOT_RUN**（2026-11-20，Codex 本机不在本轮验证范围）设置 → AI 连接卡显示：在用版本与路径、原生会话所用二进制（本机应为 npm 0.170.0）、流式所用二进制（本机应为 0.165.0）、已验证版本、多重安装提示（`2043ff98`）。
2. **NOT_RUN** 普通 Codex 流式对话仍正常（未因选择逻辑退化）。
3. **NOT_RUN** 新建 Codex 原生会话，跨回合续接；完整退出重开后继续同一 thread。
4. **PASS（2026-11-20，9/9）** 备份契约：见 C4 记录。

**C4 定向复验 PASS（2026-11-20，9/9）**。同一 `4dff9e6e` 构建在 Windows Electron fresh-native 下完成快照校验和装配。用合成原生会话通过真实接口导出，并在第二套隔离数据中导入。导出排除原生绑定和 thread ID，源库绑定保留，恢复后的绑定行数为 0，会话状态为 `APP_ORCHESTRATED / NEVER_ATTEMPTED`。证据：[C4 检查记录](../.tmp/desktop-e2e/4fc1a833-acec-458a-bd0f-b86bf03a4bc5/evidence/backup-excludes-binding/check.json)。

## D. 其他已实现待验收

1. **NOT_RUN**（2026-11-20）面试准备（INTERVIEW-PREP-CONTINUITY）：桌面「继续准备」入口路由；一题提交只触发一次模型反馈、刷新恢复（`83ab41ed`）。
2. **NOT_RUN**（2026-11-20，需真实 API 凭据）语音转文字（AWU-DICTATION）：真实 API 转写、插入草稿不自动发送、失败可重试一次。
3. **NOT_RUN**（2026-11-20）持久审批（HARNESS-PERSISTENT-APPROVAL）：Electron 内 Notion 真实写入的提案→批准→执行→回执合并路径。
4. **PARTIAL**（2026-11-20）简历证据深挖（Pilot）：草稿卡 UI 存在 PASS；多轮追问路径 NOT_RUN（见问题 D-1）。
5. **NOT_RUN**（2026-11-20）扩展页三标签（`?tab=` 深链）、技能列表「打开 Pilot」、第三方技能导入为禁用的「敬请期待」（`21cb7fd0`）。
6. **NOT_RUN**（2026-11-20，需测试 URL）网页读取工具 `read_webpage`（`432b3839`）：读取你在消息中给出的招聘页并返回标题/正文；模型自行编造或页面内的链接被拒（URL_NOT_USER_SUPPLIED）；`http://127.0.0.1`、内网地址被拒（BLOCKED_ADDRESS）；结果卡显示标题、最终网址与抓取时间。
7. **NOT_RUN**（2026-11-20，需真实模型）深度匹配（HARNESS-DEEP-MATCH）：五步已在桌面以受控夹具验证，本轮补一次真实模型调用的深度匹配成功路径（与 A 组共用真实 AI 账号）。

## F. 1.2.3-rc 追加项（2026-11-19 用户决定加入）

> **全组 NOT_RUN（2026-11-20）**。三项功能均已入 Main，本轮未进行桌面实测，待下轮补验。

1. **NOT_RUN** D4 长任务（`AGENT_LONG_TASK_HARNESS_PROPOSAL` §0.1，Main `62158e4c`）：
   1. 职位机会详情页「为此机会创建求职任务」→ 创建后变为「打开任务」，在 Pilot 打开任务会话；归档职位不显示入口。
   2. Agent 窗口右上角任务卡：折叠显示任务名/阶段/完成数，展开显示验收项、受阻原因、下一步与「继续任务」；窄面板无横向溢出；多任务下拉切换，手动选择保持到切换会话。
   3. 「继续任务」真实模型回合：只推进一个下一步，任务状态与数据库一致，不虚报产物。
   4. 完整退出重开后冷启动：任务卡与绑定任务恢复，继续任务接上原进度（便签/交接生效）。
   5. 非任务会话不变：普通 Pilot/Insight/Reflect 会话的工具、审批与回答行为无回退。
2. **NOT_RUN** 错误提示合并（Harness UI 裁定 2026-11-19，已入 Main `57f0251a`）：同类错误合并为一条并更新；同时最多 3 条，其余折叠；恢复后显示「已恢复」并数秒后消失；关闭不等于连接恢复。本期仅接条件型来源：AI 账号登录需重新授权、Notion 授权过期、本机 API 密钥保护校验；一次性操作失败仍为右下角短提示，Agent 面板错误条不在本期。限制：只在设置页／扩展页读到状态时上报与恢复，不新增全局轮询。
3. **NOT_RUN** 简历证据保存（`RESUME_EVIDENCE_SKILL_CONTRACT_PROPOSAL` 2026-11-19 裁定 D4/D5/D7，已入 Main `1149f436`）：草稿经一次预览后保存为 `USER_CONFIRMED`；素材与多条证据同一事务全成或全不写；EMPLOYMENT/CUSTOM 仍只出草稿；重复点击不重复写入；含白名单外字段（blockedWrites）的草稿不可保存并说明原因；点名已有素材时只更新有变化的确认字段并追加证据，预览逐项显示原值 → 新值；GPA 等数值／是否字段可保存，格式不对时点名字段；保存后在职业资料中可见并可重新打开。需真实模型确认能产出可保存草稿（技能提示已指引）。

## E. 不在本轮

自动网申（暂停，可能重写）、网页面试练习（Web 端开发中）、托管 AI（暂缓）、MAO-AUTOROUTE（需本轮验收的误转移样本校准，排在本轮之后）、长任务卡 D/F 与材料变更弹窗。

## 维护

1.2.3-rc 新增待验收项时追加到对应分组；实测后在各条后标注 PASS / FAIL / NOT_RUN 与构建提交，再由 Main 集成 Owner 同步对应台账。

## 验收结论与发布就绪判断（2026-11-20）

**构建基准**：A2 与 C4 定向复验为 `4dff9e6e`（Next 构建 `mQLVfy89bbGAyzULjJAiB`），Windows Electron fresh-native，隔离数据根；本轮用户实测沿用同一构建的可能性高但未由用户显式确认。

### 通过项（PASS）
- **A 组全部**：四路关闭、停止、重新生成、跨领域转交（用户实测）。
- **C4**：备份排除原生绑定（定向复验 9/9）。
- **B 组大部分**：连接、AI 读写、正文编辑、外发审阅（用户实测）。

### 阻止发布的开放问题
| 编号 | 类别 | 状态 | 建议 |
| --- | --- | --- | --- |
| **B-1** | 产品缺陷 | FAIL | Notion 删除 >20 页失败，`AgentNotionDeletePagesSchema.targets max(20)` 与 Notion 官方上限相撞；执行器分片方案已定位，需立项修复并复验 |
| **C-1** | 产品缺口 | FAIL | Devin 版本漂移（本机 `3000.14.30821`，capabilities.js 绑定 `3000.10.31`）导致新会话无法发送；需更新绑定版本或改为已验证版本列表 |
| **F 组全组** | NOT_RUN | 未验收 | D4 长任务、错误提示合并、简历证据保存三项功能已入 Main 但未实测，不能以「代码存在」计入验收 |
| **C 组 1–3** | NOT_RUN | 未验收 | Codex 原生会话显示、流式、跨回合续接未在冻结构建上实测 |

### 架构评估

**现在发布 1.2.3 正式版不合适。** 理由如下：

1. **B-1 是已知产品缺陷**：用户在实测中触发、根因已确认、当前版本必然复现，不是边缘场景。按 Runbook §4，RC 验出的缺陷须在同一 RC 内修复并完成桌面复验后才能升版；以当前状态直接升正式版等于把已知 FAIL 带入正式版。

2. **F 组三项核心功能（D4 长任务、错误合并、简历证据保存）全部 NOT_RUN**：这三项是 1.2.3 的主要交付内容，从未经桌面实测验收。正式版的台账 `passes` 条件要求「Windows Electron 实测通过」，不能因为代码已合入就绕过。

3. **C-1 Devin 新会话不可用**：影响范围确定、复现稳定，不是外部环境问题，是本版本引入的回退（版本绑定过窄）。

### 推荐路径

1. 修复 B-1（executor 分片）、C-1（版本绑定更新）。**2026-11-21 更新：代码已入 main，待桌面复验，见「修复进展与复测状态」。**
2. 对 F 组三项及 C 组 1–3 安排一次桌面实测，完成后标注 PASS。
3. D 组（D2 听写、D7 深度匹配）及 B 组剩余异常面（撤销授权、断网写）可按风险决定是否放入本轮或转下轮。
4. 上述完成后，按 Runbook §5 升正式版。

## 修复进展与复测状态（2026-11-21）

代码修复已入 main，**均只有单元测试证据，尚无 Windows Electron 桌面复验，台账 `passes` 不得据此更新**。桌面复验须在包含下列提交的新安装包上进行（上一版安装包构建提交 `89708d4e`，不含 `7a827cb4` 与 `6d9e1638`）。

| 编号 | 状态 | 修复提交 | 说明 |
| --- | --- | --- | --- |
| **B-1** | 已修复，待桌面复验 | `89708d4e` | 执行器按 20 页/批分片，确认卡上限放宽到 100；`89708d4e` 安装包上的分片复验未完成（见下） |
| **C-1** | 已修复，待桌面复验 | `7a827cb4` | Devin 版本串门禁改为按（运行时，版本）的能力缓存：PASS 持久化、FAIL/UNVERIFIED 仅内存，UNVERIFIED 5 分钟后重试，未知版本首次使用时做一次真实 `devin -p` 探针。`3000.14.30821` 流式预置 PASS，结构化待首次探针。尚未对真实 Devin CLI 跑过探针 |
| **F-1 任务选择** | 已修复，待桌面复验 | `6d9e1638` | 手动选择的任务提升到 `AgentChatProvider`，关闭再打开面板不再回到绑定任务；切换对话仍重置 |
| **Notion 回执矛盾** | 已修复，待桌面复验 | `6d9e1638` | 审批时落库的 `{saved:false,status:"queued"}` 占位输出被当作失败卡渲染，与「已写入」徽标并存；现在占位输出不渲染结果卡，由审批卡的提案状态叙述 queued→settled |
| **Codex 原生显示** | 已修复显示层，C 组仍待桌面验收 | `6d9e1638` | 本机 npm 装的是 0.171.0（未验证），已验证的 0.170.0 只是 stale 的 npm-staging 残留，native 选择按设计回落到 fail-closed 兜底；旧代码给兜底项也打 `native` 标签，才出现「native + 未验证」。现在只给合格选择打 purpose 标签。选择逻辑与 `NATIVE_VERIFIED_VERSIONS` 门禁未改动 |

**验收代理在 `89708d4e` 安装包上的观察**（未写入各组 PASS/FAIL，仅作线索）：
- B-1：只创建了 rc-child-01..18，19–22 未创建，>20 页分片删除未完成验证。
- C-1：该包不含能力缓存，Devin 新会话仍被版本门禁拦截，确认修复前现象。
- C 组：连接卡显示使用中的二进制为 0.165.0 且同时标 native/streaming，native 项显示 0.165.0 未验证（见上表 Codex 原生显示）；C 组 1–3 未通过。
- F-1：手动选择任务在关闭再打开面板后回到绑定任务（见上表 F-1 任务选择）。
- F-2 错误提示合并 NOT_RUN（未触发条件型错误）；F-3 简历证据保存未开始。
- 该次验收因 Codex 账号额度耗尽中断；已在 `AGENTS.md` §7 增加「真实模型调用前询问测试账号」规则（`3d17247b`）。

**仍待办**：用最新 main 经隔离快照重建安装包 → 在新包上串行复验 B-1（含 >20 页）、C-1（Devin 新会话流式与结构化各一次，含探针 UI 自检行）、C 组 1–3、F-1/F-2/F-3、Notion 创建回执 → 记录构建提交与 PASS/FAIL → 由 Main 集成 Owner 同步 `MVP_FEATURES.json`。

## 2026-11-20 用户桌面实测记录（构建提交待标注）

原则：本轮只记录问题、不改代码；后续修复以最优方案为导向再立项。

> 构建提交待用户确认。A2 与 C4 定向复验已标注为 `4dff9e6e`（Next 构建 `mQLVfy89bbGAyzULjJAiB`），本轮用户实测沿用同一构建的可能性高但未由用户显式确认。

### 验收结果

- **A 组 PASS**（用户实测）。
- **B 组部分通过**：连接、AI 读写、编辑正文可用；**删除子页面失败**，记 FAIL 待根因（见问题 B-1）。
- **C 组 FAIL**：切到 Devin 配置后旧会话仍用旧模型（会话固定模型，预期）；新会话报「AI 运行时版本已变化或能力尚未验证」（根因见问题 C-1）。
- **D 组**：D4 简历证据多轮深挖未测（仅验证了草稿卡存在），记 NOT_RUN。
- **F 组**：全部 NOT_RUN。

### 待解决问题清单

- **B-1 Notion 删除子页面失败（根因已定位，Vocatrya 侧缺陷）**：目标页「测试vocatrya」下有 22 个子页面，模型正确地将全部子页面放入一个 `targets` 数组并排除了父页面与「投递记录」database，但 `AgentNotionDeletePagesSchema.targets` 上限为 `max(20)`（`src/models/agent.schema.ts:224`），参数校验失败、工具调用未提交，界面表现为「删除操作未能提交」。Notion 官方 `notion-delete-pages` 单次上限同为 20 页，schema 上限与远端上限恰好相撞：超过 20 页的批次无任何可行路径（提示词又要求整批一次调用）。**建议修法**：确认卡仍覆盖全部目标，harness executor 在 `agentWrite.ts` 派发时把 `page_ids` 按 20/批自动分片多次远端调用并聚合回执；备选是放宽 schema 上限但由执行器分片（卡片内容不变）。不推荐让模型拆成多次调用——每次调用各要一张确认卡。
- **B-2 Notion 缺恢复/整库删除能力（功能缺口，非本轮缺陷）**：Notion MCP 已提供 `notion-restore-pages`（一次最多 20 个页面/数据库回收站恢复；父级仍在回收站时须先恢复父级；workspace 顶层私有页暂不支持 API 恢复）与 `notion-delete-databases`（整库连同行进回收站，需 `user_confirmed`）。是否接入 `notion_restore_pages` / `notion_delete_databases` 及其确认卡、回执与去重语义，待评估立项。
- **C-1 Devin 运行时版本漂移导致新会话无法发送**：本机 Devin CLI `3000.14.30821`，而 `desktop/main/runtime/capabilities.js` DEVIN_RUNTIME 的 streaming/structuredOutput PASS 绑定 `3000.10.31` 精确版本，版本不等触发 fail-closed `STREAMING_NOT_VERIFIED`。门禁按设计工作，但暴露产品缺口：Devin 后台自动更新使每次升级都打断聊天，且应用内无重新验证入口（需跑 `scripts/runtime-streaming-probe.mts` / `structured-output-probe.mts` 后手工更新绑定版本）。可选方向：对新版重跑探针更新绑定；改为已验证版本列表（对齐 Codex native `NATIVE_VERIFIED_VERSIONS` 模式）；或应用内显式提示「运行时已更新，需重新验证」并给出恢复路径。
- **D-1（NOT_RUN）**：简历证据深挖多轮（Pilot 空白页入口 → 选经历 → 多轮追问 → 草稿卡校验）。
- **F-1（NOT_RUN）**：D4 长任务全组、错误提示合并、简历证据保存，均未实测。

### UI 反馈（非验收项，待排期评估）

长等待时建议在 Agent 面板展示模型的 thinking/reasoning 过程，而不是一直显示「响应比平时慢…正在生成…」；参考 craftstation 的呈现方式。

## G. 新增提案：飞书 MCP 连接与工具（2026-11-20 调研，待用户裁定）

用户提出在「连接与工具」新增飞书 MCP。以下为调研结论与建议方案，**未实现、未排期**；裁定后按 EXT-NOTION 同类流程立项。

### 官方可选底座

| 方案 | 说明 | 评估 |
| --- | --- | --- |
| 飞书远程 MCP（官方托管） | 仅「云文档」少量工具（search-doc、fetch-file 等），面向开发者代码集成 | 工具面太窄，不满足「连接与工具」预期，排除 |
| `@larksuiteoapi/lark-mcp`（官方 OpenAPI MCP，Beta） | 飞书 OpenAPI 全量封装为 MCP 工具；stdio / streamable HTTP；`--tools` 白名单、`--token-mode`、`--language zh` | **推荐底座**。npm 包带 keytar 原生依赖（Windows 用 Credential Manager），打包需 spike 验证 |
| 直连飞书 OpenAPI 自封装 | 仿 Notion service 自实现 OAuth/工具层 | 契约最可控但工作量最大，工具面需逐个封装；仅当 lark-mcp 不可用时考虑 |

### 认证与凭据

- 飞书要求用户自建应用（开放平台创建，得 App ID/Secret），权限按 API 粒度申请，企业租户可能需管理员审核——平台规则，无绕过路径。
- **首期建议：应用身份（tenant_access_token）**。能力边界=应用被授权的文档/资源范围（用户把文档分享给应用或机器人）；凭据走 Vocatrya 密封存储，可控、可撤销、可进备份排除清单。
- 用户身份（user_access_token）能力更强（个人可见文档、消息、日历），但 `lark-mcp --oauth` 自带 localhost:3000 回调与独立 token 存储（keytar），凭据不在 Vocatrya 手里，与密封存储/备份/撤销契约冲突；自实现 UAT OAuth + 刷新则工作量大。**首期不做，后续按需单独评估。**

### 首期建议范围

- 连接：设置页填 App ID/Secret（或引导创建应用），密封存储，断开即清除。
- 工具白名单（云文档域）：搜索云文档、读取文档/wiki、创建文档、追加/块级编辑内容；写操作复用 proposal→人工批准→harness task→回执链路，确认卡展示外发内容，未知结果不自动重试。
- 明确不做：IM 消息、日历、多维表格写入、任何「代用户发送」类动作。

- **C-2 Antigravity 图标缺失（小缺陷）**：`AiServiceIcon` 图标映射无 `Antigravity` 条目、`public/icons/ai-services/` 无对应 SVG，设置卡图标空白。修法：lobe-icons 同源补 SVG + 映射条目。
- **C-3 Antigravity 登录不可确认（设计缺口，待验证）**：适配器按 PENDING 交付。实测现象（2026-11-20）：点连接后弹出新控制台窗口，完成 Google 验证码登录后界面显示失败。机制上登录后 Vocatrya 的确认探针是 `agy models`（`registry.js` commands.status），该命令无论是否登录都打印模型表；`parseAntigravityAuthStatus` 只认明确的 signed-out 文案，其余一律 UNKNOWN → `loginFailureCode` 返回 `AUTH_METHOD_UNVERIFIED`。因此「验证码登录成功但界面报失败」与设计完全吻合——**当前实现下登录成功也无法被确认**，不排除 agy 侧本身也失败（本机 agy 已 1.5.13，适配器按 1.5.12 编写）。下一步验证：在隔离 profile 下确认 `agy acp --login` 是否真实写入凭据（`--gemini-dir`/`antigravity-cli` 目录与 OS keyring 的实际归属），并找一个可靠的 auth 判定信号（如 `agy acp` 握手应答、本地凭据文件、或官方状态输出），据此把对应 verification 置 PASS 后再评估登录链路。

- **C-4 Grok 登录同 Antigravity 一类问题（版本漂移 + 验证缺口）**：适配器按 grok 1.0.41 验证，本机已 1.0.92。登录链路是 `grok login --oauth`（stderr 打印 auth.x.ai 授权 URL → `extractGrokLoginUrl` 转发给渲染层）+ ACP 握手探针（`grok agent --no-leader stdio`，initialize + authenticate(cached_token)，靠 `_meta.auth_mode == "Oidc"` 判定 xAI OAuth 会话）。1.0.92 上 auth_mode 上报或 ACP 握手若有变化，探针只能给 UNKNOWN → `AUTH_METHOD_UNVERIFIED`，与 Antigravity 同型「登录或已成功但无法确认」。待验证：在 1.0.92 实测 ACP authenticate 应答的 auth_mode 取值与 `grok login --oauth` 的 URL 输出格式是否仍匹配。
- **C-5 Cursor 登录未弹授权页（现象待细分）**：适配器按 cursor-agent 2026.09.18-9a7762b 验证，本机已 2026.11.19-f005e9d。已实测：新版 `agent login`（含模拟托管隔离环境）仍在 stdout 正确打印 `cursor.com/loginDeepControl?...` URL，与 `CURSOR_LOGIN_URL_RE` 匹配；UI 设计是显示「打开授权页」按钮而非自动弹窗（`AiConnectionsCard` oauthUrl 分支）。因此「没弹页面」只可能是：① URL 未被转发（runtime 解析失败或登录进程在打印 URL 前退出）；② URL 已转发但用户未看到/未点按钮；③ `window.open` 被 `setWindowOpenHandler` 拦截（`main.js` 对外链走 `shell.openExternal`，正常应开系统浏览器）。待用户补充：点击连接后卡片显示什么（转圈/错误码/是否出现授权页按钮）。

- **N-1（新需求，待排期）**：去掉「AI 业务分配」中的面试练习板块。相关实现：`src/components/settings/InterviewAiSettings.tsx`，由 `AiAssignmentsCard.tsx` 挂载；删除时需同步清理其 i18n 文案、相关设置项与后端 interview AI 配置的引用关系，注意与「继续准备→扩展工具 Web 练习入口」改动（D 组）不冲突——本条只针对设置页该板块的移除。

- **N-2（新需求，待排期）**：设置 → 听写（语音转文字）板块调整——API key 按钮文案/跳转提示指向 `https://aistudio.google.com/api-keys` 配置 Gemini key；供应商只保留 Gemini，删除 OpenAI 选项；默认模型改为 `gemini-3.5-flash-lite`。相关实现：`src/components/settings/DictationSettingsControls.tsx`（及 `AudioSettings.tsx` 挂载点）；需同步检查后端听写转写的 provider/model 白名单与默认值、i18n 文案，以及已有 OpenAI 配置用户的兼容表现（保留旧配置可读但不可新选，还是直接迁移，待定）。

- **N-3（性能提案，待排期，非本轮验收项）**：Agent 回复提速。经代码复查属实的现状：① Codex 原生会话刻意保持 ephemeral-per-turn（`native-session.js` 注释），每轮重新 spawn+握手+查配置；`codex-persistent-runtime.js` 已有进程池可借鉴（须保留隔离与版本门禁）。② 流式回合除正文外还跑 structured decision step（`streaming-execution.ts`），工具调用后继续决策——"模型决策→模型回答"两段式属实；可对支持原生工具调用的连接改同请求输出正文或工具调用，其余保留兼容路径。③ 普通聊天分流保守，AMBIGUOUS→AGENT（`careerDialogueRoute.ts`）；放宽需保证读个人数据/保存/修改仍走工具流程。④ 上下文按 `contextBudget.ts` 装配，可按任务裁剪工具与材料、保持前缀稳定、摘要后台生成。⑤ 按任务选模型/推理强度属推测项，需先确认各连接实际支持。**建议顺序**：先做分段计时（发送→请求、请求→首字、工具耗时、总耗时）+ 原生进程复用，再优化快聊分流；用同一组问题对比首次与连续追问，无实测数据前不承诺倍数。

### 待定问题

1. lark-mcp 在 Electron 安装包内的运行形态：后端 spawn stdio 子进程 vs streamable HTTP 本地服务；原生依赖打包验证。
2. 应用凭据的录入 UX：手动填 App ID/Secret vs 引导式创建向导。
3. 工具命名与参数：lark-mcp 工具名为 OpenAPI 路径风格（如 `docx.v1.documentBlock.list`），需决定 agent-facing 工具的封装粒度（粗粒度语义工具 vs 透传）。
4. 与 Notion 的一致性：错误分类、限流 Retry-After、object_not_found 类错误码对齐。


## 2026-11-21 并行任务集成收口

- N-1 已集成 Main `8451fdc4`：移除设置页旧面试练习 AI 分配板块及专用写入口，保留仍使用旧配置的消费者。
- N-2 已集成 Main `870175fe`：听写仅 Gemini，默认 `gemini-3.5-flash-lite`，API key 入口指向 Google AI Studio；旧 OpenAI 配置不静默改写或转用密钥，按未配置处理。待真实转写与桌面复验。
- C-3/C-4 登录适配已集成 Main `f8947e9c`：含 `f729880c`、`1aa8ad10` 与本轮安全修复 `f59dc921`。Antigravity 交互认证仅限显式登录/重新登录后；普通状态检查返回 UNKNOWN，不发起 OAuth。超时与进程异常退出保持 UNKNOWN。Grok/Cursor 的完整真实登录和授权页问题不据此判通过，C-5 继续待核。
- B-1 定向回归已集成 Main `65e6cb8b`：补一张整批确认卡、20+2 派发、取消、部分完成与未知结果不重发的隔离测试。不能替代真实 Notion / Electron 验收。
- Main 组合定向检查：应用侧 12 文件/200 项、桌面主进程单元测试 8 文件/151 项通过（测试宿主 Node，非 Electron 桌面 E2E）。本轮无真实模型调用、无真实凭据操作、无生产构建或安装包验证。Feature 验收结论不变。
- 类型检查：原始全目录命令触及 Node 默认约 4GB 堆上限，未完成；随后用临时 tsconfig 排除 `.tmp`、`.worktrees`、`.codegraph`、`.codex-tmp`，保留源码和测试检查，并设 8GB 堆上限，`tsc --noEmit` 通过。临时配置位于 `.tmp/rc-integration/tsconfig.json`，不提交。
