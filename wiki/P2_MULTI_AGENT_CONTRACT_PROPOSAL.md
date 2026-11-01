# MULTI-AGENT 实施合同提案（Voca Insight / Pilot / Reflect 三角色与右侧 Agent 面板）

- 基线：`main @ 23178a4c`（2026-11-01 逐条源码复核）
- 状态：**提案，未经 Owner 冻结**。除【源码事实】外，所有角色边界、交互与存储方案均为【推荐方案】；标注【待决定】的条目需 Owner 裁定后才能按冻结合同实施。本文件不授权代码修改、Schema/Migration、提交、合并、部署或真实数据操作。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行）；**【推荐方案】**＝本合同建议，未冻结；**【待决定】**＝需 Owner 裁定的产品/工程规则。
- 上游依据：`wiki/P2_IMPLEMENTATION.md` §C6（MULTI-AGENT 已确认交互与待冻结项）与 `wiki/P2_FEATURES.json`；P1 `AGENT-CAPABILITIES`（canonical `match_job` 已合入 `67a3adf6`、D1–D6 已批准，P1 台账已记录 Windows Electron fresh-native/full 真实 AI 验收通过（2bfee169）；结论限于实际覆盖运行时/模型）；归档语义遵循已冻结 `ARCHIVE_CONTRACT_PROPOSAL.md`；窗口二合同 `P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md` §11 AI 边界；首页合同 `P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md` §6 Agent 槽位。
- **交叉项（记录，不在本合同裁定）**：① 首页合同 §9 D7（V1 阶段卡 Agent 槽位=单入口现有助手）在本 Feature 落地后由同一槽位传入角色——首页结构不需改动，实施时按 §6.2 接口协调。② 窗口二合同 §13 D6「已结束」与首页合同 §9 D3 协调建议已对齐但未批准，由 Owner 同一次裁定；本合同 V1 不消费该谓词（无复盘读工具）。③ canonical `match_job` 已注册且有验收证据，是否进入 Insight 建议见 §9 D5。

## 0. 范围与边界

本合同覆盖 P2 六个 Feature 中的 **MULTI-AGENT** 一项：

- 三个专业角色（Voca Insight / Voca Pilot / Voca Reflect）的职责、工具白名单、系统提示边界与诚实降级；
- 右侧面板顶部三图标切换器（hover/焦点名称、键盘可达）；
- 每角色 4 条建议「点击只填入输入框，确认发送才调用 AI」；
- 角色切换时会话、草稿、历史与对象上下文的互斥方案；
- 首页与业务页面打开面板的接口语义（不自动发送、不自动调用模型）及页面切换/对象失效行为。

**不在本合同范围**：新增任何复盘读取/写入 Agent 工具（窗口二合同只冻结领域边界，工具合同另行）；后台自主协作、定时分析、三个独立进程或自动新增工具；CAREER-INSIGHTS 指标、NEXT-ACTIONS 规则、首页布局（另一合同）；JOB-CONNECTIONS / INTERVIEW-DEBRIEF 的领域 Schema（另一合同）；Provider 连接基础设施、凭据、Entitlement（P1 已有独立 Feature）。

**产品边界（与 P2 基线一致，不再开放讨论）**：三角色共享同一条 `/api/ai/chat` 会话管线、同一套准入/检查点/批准机械与同一份速率限制；不是三个独立模型、独立进程或自主执行服务；打开面板不发送消息、不创建会话、不调用模型；未完成/未注册的工具不得在建议或提示词中写成已可执行能力。

## 1. 源码事实总览（`main @ 23178a4c` 核实）

### 1.1 单助手与右侧面板【源码事实】

- 当前只有一个 Agent：`agent.panelTitle`＝「AI 助手」、`agent.triggerLabel`＝「询问 Vocatrya」（`src/i18n/messages/zh-CN.json`）。入口 `AgentChatTrigger`（`src/components/AgentChatTrigger.tsx:9-44`）挂于 `Header.tsx:94` 与 `TitleBarActions.tsx:35`。
- `useAgentChat().open()`（`AgentChatProvider.tsx:536-541`）＝折叠侧边栏 + `requestOpen("chat")` 占用 RightRail + `setIsOpen(true)` + `runPreflight()`。**打开面板不发送消息、不创建会话、不调用模型**；preflight 只读连接/运行时状态（`getAgentChatPreflight`，`agentChat.actions.ts:519-660`）。
- 面板为右侧非模态 Sheet（`AgentChatPanel.tsx:44-143`）：拖宽（最小 340px＝`AGENT_CHAT_PANEL_MIN_WIDTH`，默认 450px，上限视口 0.9，`constants.ts:218-219,281-283`，宽度持久化 localStorage `agent-chat-width`）、展开/还原、历史、新对话、关闭；头部含 `VocatryaMark` + `agent.panelTitle` + `AgentChatIdentity`（模型/连接徽标与草稿态模型选择器）。历史/展开/关闭图标按钮均已有 `aria-label`，为原生 `<button>`（键盘可达）。
- `AgentChatProvider` 挂在 dashboard layout（`src/app/dashboard/layout.tsx:87-114`），SSR 以 cookie `agent-chat-active-id` 调 `loadActiveChatConversation` 恢复**最近一条未归档会话**（`agentChat.actions.ts:138-161`）——打开应用还原的是上次的会话，而非新草稿。
- `RightRailContext` 保证同一时刻只有一个右侧面板持有者（`RightRailContext.tsx:18-37`）。

### 1.2 工具注册与写入批准矩阵【源码事实】

`buildAgentTools`（`src/lib/agent/tools/index.ts:18-91`）每请求构建 **7** 项工具；`freshNativeFull` 时用 canonical 实现**替换** `match_job` 并**删除** `generate_cover_letter`（`tools/index.ts:81-89`）→ fresh-native/full 注册 **6** 项；`canonicalJobs`（AB_ENABLED+full，含 migrated-full）使 `add_job` 写 canonical `JobOpportunity`（`tools/index.ts:44-47`）。

| 工具 | 读/写 | 批准 | freshNativeFull | 其它运行时 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `list_jobs` | 只读（≤40，家族感知） | 无 | ✅ | ✅ | `canonicalJobRead.ts:58-70`；blocked 家族返回 `unavailable` |
| `get_job` | 只读（摘要+`jobUrl`+`appliedDate`+`dueDate`+JD 截 12k） | 无 | ✅ | ✅ | `canonicalJobRead.ts:72-111`；**不含** Attempt/Step/复盘数据；归档 canonical 职位 → `no_job` |
| `get_resume` | 只读 | 无 | ✅ | ✅ | `getResume.ts:20` 注释明确不批准 |
| `review_resume` | 嵌套生成；legacy 简历写 `reviewData`，不改 Variant | 无 | ✅ | ✅ | `reviewResume.ts:44`；嵌套生成经 `NestedGenerationGuard` 每请求串行 |
| `add_job` | 写（canonical→JobOpportunity；legacy→Job） | **条件批准**（可写才询问，`addJob.ts:61-66`） | ✅ | ✅ | 批准卡显示全部提取参数；批准后才写 |
| `match_job` | 分析+写匹配历史 | **恒需批准**（canonical，`canonicalMatchJob.ts:358`） | ✅ canonical | ✅ legacy 实现写 `Job.matchScore/matchData`，**无批准**（`matchJob.ts:48`） | canonical 只作用于会话页上下文职位（`pageJobId`），`no_job` 无职位；归档 → `OPPORTUNITY_ARCHIVED` |
| `generate_cover_letter` | 写本人文档 | 无 | ❌ 不注册 | ✅ | `tools/index.ts:88` |

- canonical `match_job` 的持久化执行：`AgentToolExecution`（`toolExecution.ts:57-125`，`schema.prisma:1770-1804`）以 `(conversationId, toolName, turnKey)` 去重、`operationKey`/`matchAnalysisId` 唯一；PENDING→COMPLETED/FAILED/ABORTED；仅在 `operation==="approval"` 且 `approvalToolCallId` 匹配的准入请求中执行（`canonicalMatchJob.ts:367-386`）。
- 批准 UX：`AgentApprovalCard`（`AgentApprovalCard.tsx:102-208`）→ `addToolApprovalResponse` → `sendAutomaticallyWhen` 发 `operation:"approval"` → `admitConversationRequest` 在事务内标记 `approval-responded` 并绑定 `approvalToolCallId`（`conversationRequest.ts:82-88`）；`APPROVAL_BOUND_TOOL_RECEIPTS={add_job, match_job}`（`conversationRequest.ts:39`）。
- 回合准入：`admitConversationRequest`（`conversationRequest.ts:46-104`）支持 `send|regenerate|approval` 三操作，`revision` CAS + `activeRequestId` 租约（300s）；归档会话拒绝一切准入；`regenerateTailHasWriteReceipt` 阻止丢弃已写事实（`writeReceipt.ts:18-20`）。`checkpointConversationTool` 同事务完成业务写入+工具回执，重放幂等（`conversationRequest.ts:127-164`）。取消：`stop()`→`cancelChatConversationRequest`；中止回合不回写。
- 系统提示词两套变体（fresh-full 六能力 / legacy 七能力）+ 闭合集 `<page-context>` 行（`prompt.ts:27-55,127-152`）；确定性路由 FAST_CHAT（无工具）/AGENT（需结构化输出就绪，`careerDialogueTurn.ts:41-98`）。
- 回合约束：`AGENT_CHAT_MAX_STEPS=4`、超时 300s、用户级 `checkRateLimit("chat")`（`route.ts:390-399,602,678`）。

### 1.3 会话持久化与生命周期【源码事实】

- `ChatConversation`（`schema.prisma:671-713`）：`messages`（UIMessage[] JSON）、`context`（`AgentConversationContextV1` JSON）、创建时锁 `resolvedConnectionId/resolvedModel/managedAiProvenance`、`archivedAt`、`revision`、`activeRequestId/expiresAt`；关联 `conversationSummary`（压缩缓存）与 `agentToolExecutions`。
- **草稿→持久化**：首次发送才建行（`dispatch`→`createPersisted`→`sendMessage`，`AgentChatProvider.tsx:766-790`）；`seedExchange` 直接持久化一条捏造的问答对且不调用 AI（`AgentChatProvider.tsx:803-847`）。
- 会话锁：创建时经 `resolveChatCreationLock`（purpose `CAREER_DIALOGUE`）或显式选择一次性固化，**之后不改写**（`chatConversationLock.ts:20-41,188-233`）；坏分配按 fail-closed 固化为锁本身。Managed 锁携带 `conversation:<id>` provenance（`chatConversationLock.ts:204-219`）。
- 历史：仅列未归档行（≤30＝`AGENT_CHAT_HISTORY_PAGE`），按今天/昨天/更早分组（`AgentChatHistory.tsx:21-47`）；归档可逆（Archive Center 恢复）、删除永久；归档会话对 AI 全读面不可见且准入拒绝（`chatConversationStore.ts:225-268`、`conversationRequest.ts:55`）。
- 归档 fail-closed：`hasArchivedJobReference` 扫描会话 context+messages 中的归档 canonical 职位 id → `CONVERSATION_ARCHIVED_CONTENT` 整段拒放（`archiveVisibility.ts:6-17`、`route.ts:420-424`）。
- 摘要：`loadFreshConversationSummary` + 回合后 `scheduleCareerDialogueSummary`（`route.ts:291-295,366-372`）。

### 1.4 上下文生命周期与对象附着【源码事实】

- `AgentConversationContextV1`：`items[]` 每项 `{kind:"job"|"resume", entityId, labelSnapshot, source:"AUTO"|"MANUAL"}`（`conversationContext.ts:4-19`）；上限 8（`conversationContext.server.ts:18`）；`labelSnapshot` 仅展示用，工具只读 `entityId`。
- **AUTO 附着只发生在草稿创建时**：`pageContextFor(pathname)` 只识别 `/dashboard/myjobs/[id]`（jobId）与 `/dashboard/profile/resume(s)/[id]`（resumeId，`pageContext.ts:6-22`）；`/dashboard` 等其它页面只带 route 无实体。`resolveDraftPageContext` 在首个挂载效应与 `startNewConversation` 中各调一次（`AgentChatProvider.tsx:547-561,644-654`）——**页面跳转不会自动更新已附着上下文**。
- **MANUAL 附着**：ContextBar 选择器 `listAgentContextOptions`（≤40 职位+≤40 简历，归属过滤，`conversationContext.server.ts:156-191`）。
- 服务端校验 `resolveOwnedContext`：全部实体归属核验；**归档 canonical 职位对 AI 不可见**（`isArchivedCanonicalJobView`→拒绝，`conversationContext.server.ts:31-39`）；不支持/未归属项报 `AGENT_TOOL_ARGUMENT_INVALID`（`conversationContext.server.ts:65-113`）。
- **回合的 pageContext 取自持久化会话上下文**（`route.ts:451` `pageContextFromConversation`），不是当前路由——`get_job`/`match_job` 的 `pageJobId` 来自会话上下文项（`tools/index.ts:48,61,85`）。含义：用户在 A 职位页附着后跳到 B 职位页发消息，工具仍作用于 A；A 以 chip 形式可见、可手动移除（`AgentChatContextBar.tsx:64-94`）。
- 上下文更新对已持久会话走 `updateChatConversationContext`（对旧 context 的 CAS + `withRestoredJobReferences` 保护，`chatConversationStore.ts:191-216`）；草稿态只更新本地状态（`AgentChatProvider.tsx:899-944`）。

### 1.5 建议与页面 CTA 的「点击即发送」现状（差异核实）【源码事实】

- `AgentChatEmptyState` 建议 `run: () => send(label)` → `sendMessage` **点击即发送**（`AgentChatEmptyState.tsx:24-32`）：有 job 上下文时 freshNativeFull 3 条（analyze/review/interview）、其它运行时 4 条（+match）；resume 上下文 3 条；无上下文 4 条伪建议（2 条开上下文选择器、1 条同、1 条 `seedExchange` 加职位，无 AI 调用）（`AgentChatEmptyState.tsx:34-82`）。
- 页面级 CTA「打开+发送」：`JobDetails.startChat`（`JobDetails.tsx:171-179`）与 `ResumeContainer.startReview`（`ResumeContainer.tsx:109-117`）＝ `openChat()` + `startNewConversation()` + `sendMessage(...)`；legacy 面 `useAutoMatch` 深链 `?match=1` 到职位详情后自动打开面板并发送（`useAutoMatch.ts:7-18`，freshNativeFull 下已禁用，`JobDetails.tsx:194`）。
- `Suggestion` 组件即 `<button type="button">`（`suggestion.tsx:39-48`），键盘可达；`preflight.ok=false` 时禁用（`AgentChatEmptyState.tsx:97`）。
- **与 P2 已确认方向的差异**：P2 要求「4 条建议点击只填入输入框」——当前实现是「点击即发送」。`composerNonce` 目前只用于清空输入框（`AgentChatInput.tsx:152-156`），无「外部写入输入框」通道——需要新增。

### 1.6 三条 AI 路径与会话锁【源码事实】

- 聊天 purpose 固定 `CAREER_DIALOGUE`（`chatConversationLock.ts:42`）；锁三种：`account`（AIConnection+model）、`managed`（Hosted provenance）、`legacy`（`settings.ai` provider/model 语义，`route.ts:479-498`）。三路径独立状态、独立验收（`P1_FEATURES.json` AI-ACCOUNT-LOGIN/AI-BYOK/AI-MANAGED）。
- preflight 按锁类型分流：account 查连接状态+桌面运行时流式探针；managed 查 provenance；legacy 查 settings 模型；blocked 返回诚实错误码（`agentChat.actions.ts:406-660`）。AGENT 路由另需结构化输出就绪（`careerDialogueTurn.ts:30-98`）。`AI_CONFIGURATION_CHANGED_EVENT` 触发面板内重跑 preflight（`AgentChatProvider.tsx:529-534`）。
- 目的解析 `resolveBusinessAIConfig`：purpose 专属→GLOBAL_DEFAULT→NOT_CONFIGURED；INVALID_ASSIGNMENT fail-closed 不静默回退（`assignments.ts`；首页合同 §1.4 同述）。

### 1.7 复盘领域能力边界（窗口二合同消费面）【源码事实】

- 真实面试复盘实体树已存在：`ProcessStep(INTERVIEW)` 1:1 `ApplicationInterviewDetail{reflectionText}` 1:N `ApplicationInterviewReflectionItem`（`schema.prisma:1035-1070`）；`getInterviewReflection` 只读（归档职位仍可读）、`saveInterviewReflection` 需 AB_ENABLED+full（`applicationService.ts:598-723`）。
- AI 复盘：`generateInterviewReflectionDraft`（CAREER_REFLECTION 用途、TEXT_ONLY 一次性、**服务端不落库**、仅 `isFullAbReadSurface` 可用，`interviewReflectionAi.actions.ts:46-101`）——是服务端 action，**不是 Agent 工具**，聊天面板无法调用。
- **当前没有任何读取复盘/轮次的 Agent 工具**：`get_job` 只返回职位摘要+JD（§1.2），不含 Attempt/Step/InterviewDetail。
- 窗口二合同 §11 AI 边界（仍为提案；既有归档禁读规则已冻结，本合同遵守）：AI/Agent 可在 `userId` scope 内读职位/Attempt/Step/detail/复盘/JD/提交简历摘要；产出草稿停在客户端、用户确认后走既有写路径；**不得**写 `reflectionText`/items、置 `reflectionCompletedAt`、改 `submitted*`/`submittedAt`、改 Step `status/completedAt`、替用户完成复盘或标记面试结束。

## 2. 三角色合同【推荐方案，全部待冻结】

### 2.1 角色定义（固定顺序：准备→行动→复盘）

| 角色 | 显示名 / 副标题方向 | 职责 | 定位边界 |
| --- | --- | --- | --- |
| **Voca Insight** | 求职分析师 · 准备 | 简历/JD/职位匹配与面试准备的**深度分析**：读职位、读简历、产出评分与匹配分析 | 只读+嵌套生成+批准制分析写；不新增职位（add_job 归 Pilot），保留分析结果写入及 legacy reviewData 写入 |
| **Voca Pilot** | 全局助手 · 行动 | 检索与管理工作台：**查职位、录职位**、经确认的操作 | 负责新增职位的角色（add_job 条件批准）；Insight 另有分析结果持久化；不主动投递、不做分析生成 |
| **Voca Reflect** | 复盘教练 · 复盘 | 整理真实面试经历、提炼经验与改进方向 | **零复盘工具**（§1.7）：诚实降级为「对话教练」——帮用户把叙述整理成复盘结构/问答清单/改进点草稿，产出文本由用户自行粘贴到复盘对话框；可只读定位父职位 |

阶段↔角色只是默认推荐（P2 §B2/C6），用户随时可手动切换任一角色；角色不构成 Agent 独占权限或任务状态机。

### 2.2 工具白名单矩阵【推荐方案】

**规则：角色有效工具集 = 角色白名单 ∩ 当前运行时注册集**（运行时门先裁剪，§1.2）。白名单按名称声明，不含任何未注册/未实现工具。

| 工具 | Insight | Pilot | Reflect |
| --- | --- | --- | --- |
| `list_jobs` | ✅ | ✅ | ✅（定位父职位） |
| `get_job` | ✅ | ✅ | ✅（读 JD/职位摘要） |
| `get_resume` | ✅ | — | — |
| `review_resume` | ✅ | — | — |
| `add_job` | — | ✅ | — |
| `match_job` | ✅（freshNativeFull=canonical 批准制；其它运行时=legacy 现状语义） | — | — |
| `generate_cover_letter` | — | — | —（任何角色不开放；freshNativeFull 本就不注册） |

- **写入面**：三角色可写工具包括 add_job（Pilot、条件批准）、match_job（Insight、canonical 恒需批准 / legacy 无批准）以及 review_resume（Insight、legacy reviewData 写入，无批准）。没有任何复盘写入工具开放给任何角色——与窗口二合同 §11「AI 不写复盘」一致。
- **Reflect 只读**：list_jobs/get_job 用于「复盘腾讯三面」这类按名称定位父职位、读 JD 辅助整理；不暴露 Attempt/Step/复盘数据（无工具可读，提示词如实声明，§2.4）。
- **【待决定】** Pilot 是否含 `get_resume`（D6）：推荐不含——简历读取属 Insight 域，边界干净；Owner 可选加入以支持「这份简历投过哪些职位」类问答。

### 2.3 系统提示词边界【推荐方案】

沿用现有「分节拼装」模式（`prompt.ts:7-55`）：每角色一份 `role` + `capabilities`（只枚举白名单∩运行时可用）+ `limitations` + `paste` + `safety` + 闭合 `<page-context>` 行变体。

- `role` 节定义角色名与人格边界（如 Reflect 自称「复盘教练」并声明「我看不到你保存的复盘记录，只能基于你描述/粘贴的内容整理」）。
- `capabilities` 节逐工具描述真实行为与批准语义，与 `AGENT_TOOL_DESCRIPTIONS` 同源扩为按角色取子集；不出现的工具名在提示词中不出现。
- `limitations` 节如实命名不能做之事（Reflect：不能读取已保存复盘、不能写复盘、不能改面试状态；Pilot：不能做匹配/简历分析；Insight：不能添加职位）。
- 会话的系统提示词按**会话的持久化角色**选取——角色由服务端从会话行读得，客户端请求体不携带/不信任角色字段（与现有锁/上下文同级的服务端权威）。

### 2.4 诚实降级矩阵【推荐方案】

| 场景 | 表现 |
| --- | --- |
| 无 AI 配置 / 连接失效 | 沿用现有 preflight/blocked 诚实态与错误横幅；三角色一致，不另造降级 |
| 运行时未注册某工具（如 freshNativeFull 无 `generate_cover_letter`） | 该工具不出现在白名单生效集、不出现在提示词与建议中（§1.2 交集规则已覆盖） |
| Reflect 无复盘读写能力 | 建议与提示词只承诺「整理文本」；涉及读写复盘的请求如实回答「我看不到也写不了复盘记录，可以把内容粘贴给我，我帮你整理成可粘贴回复盘框的结构」 |
| canonical `match_job` 已验收 | 仅在当前运行时真实注册且角色白名单允许时可列（§9 D5）；建议文案用「运行匹配分析」，不承诺结果质量 |
| jobs/resume 家族 blocked | 工具结果 `unavailable`/`no_job` 如实传达（现状语义），建议条目按能力门过滤 |
| 归档对象上下文 | 附着被拒（现状）；已持久会话引用归档对象 → `CONVERSATION_ARCHIVED_CONTENT` 诚实报错（现状） |

## 3. 顶部三图标切换器【推荐方案】

- **位置**：面板头部（`AgentChatPanel.tsx:71-125` 的 header 行内，品牌标与名称之后、Identity 之前）。**不新增占聊天宽度的左侧角色栏**——三枚图标总宽约 72–96px，保持现有 ≥340px 最小宽度内可用。
- **形态**：三个图标按钮（Insight=分析/放大镜类、Pilot=操作/罗盘类、Reflect=复盘/循环类，图标选型实现期定），固定顺序 Insight→Pilot→Reflect 对应旅程叙事。
- **可达性**：每枚按钮 `aria-label={角色名}` + `aria-current`/`aria-pressed` 标记当前角色；hover 显示名称（Tooltip/title），**焦点态同样显示**（不能只 hover）；原生 `<button>` 天然进入 Tab 序——与现有 header 图标按钮同一模式（§1.1）。
- **当前角色显示**：面板头部在标题位置显示当前角色名+一句职责简介（替代或附加于 `agent.panelTitle`）；历史/新对话/展开/关闭按钮不变。`AgentChatIdentity`（模型/连接徽标）保留——角色≠模型。
- **【待决定】** 极窄宽度（340px）下 header 元素优先级（D7）：推荐顺序＝角色图标组 > 角色名 > Identity > 历史/新对话 > 展开/关闭；推荐角色名在 <400px 收缩为仅图标。

## 4. 四条建议：点击只填输入框【推荐方案】

- **每角色固定 4 条建议**（静态文案，非动态生成）——确定性、可验收；按上下文（job/resume 上下文项）与运行时能力门做**替换式降级**：不可用的条目以同角色的下一条兜底文案替换，始终以纯对话/用户提供文本的建议兜底到 4 条，不虚构工具能力。
- **点击行为**：填入输入框并可继续编辑；**只有用户按发送键才走 `sendMessage`**。实现：Provider 新增 `fillComposer(text)` 通道（替代 `composerNonce` 的单向清空，输入框受控升级），`Suggestion.onClick` 改调 `fillComposer`。
  - `preflight.ok=false` 时**填入仍允许**（只是文本），发送键维持现状禁用+诚实横幅；推荐此口径（D8 备选：无配置时禁用建议）。
- **建议来源约束**：建议文案只能指向白名单∩运行时可用能力或纯对话能力；不得暗示复盘读写、投递、任务创建、联网检索等不存在能力。
- **`seedExchange`「加职位」伪建议**：改为「填入输入框」（如填入「帮我把这条招聘帖加入我的职位：」让用户接着粘贴）——捏造问答不再出现在建议链路；`seedExchange` 本身是否保留由实现决定（须在实施前复核全部调用方）。
- **页面级 CTA**（`JobDetails.startChat`/`ResumeContainer.startReview`/`useAutoMatch`）：属「用户显式动作」而非「建议条」，**【待决定】**（D9）：推荐 V1 保持「打开+发送」语义不动（有明确请求含义的按钮可以保留；useAutoMatch 深链自动触发需独立核对来源，不能一概当作用户在面板确认发送），备选统一为「打开+填入」与建议条一致；`useAutoMatch` 维持 legacy-only，不向 freshNativeFull 扩展。

## 5. 角色切换的会话/草稿/历史/对象上下文互斥【推荐方案】

### 5.1 角色-会话绑定（推荐：每角色独立会话槽）

- `ChatConversation` 在**创建时**固化 `agentRole`（Insight/Pilot/Reflect 之一），之后**不改写**——与会话锁同一「创建时固化」先例（§1.3）。
- 顶部切换器 = 切换**当前激活的角色槽**：每角色有自己的「当前草稿/当前会话」与独立输入框草稿。在角色 A 的会话中点角色 B → 面板显示 B 的激活会话（或 B 的空草稿），A 的会话原样留在历史——**不把一个会话的消息历史/上下文跨角色复用，也不改写 A 会话的角色**。
- 推荐存储：新可空列 `ChatConversation.agentRole` + additive migration（**【待决定】** D2；备选为 `context` JSON 信封内嵌角色字段，零 Schema 但历史过滤/徽标需 JSON 提取且上下文整写时要保字段，不推荐）。旧行 `NULL` → 显示为「通用助手」/默认归 Pilot，不回填不猜测。
- 历史列表：统一列表+每行角色徽标；选中某行即激活其角色的槽位。【待决定】是否加按角色过滤（D3 推荐 V1 不加过滤、只加徽标）。

### 5.2 草稿与输入文本

- 每角色槽位独立持有：会话 id/草稿态（未持久）、输入框文本、上下文 seed。
- 切换角色不清空别槽草稿：A 槽未发送的输入文本与未持久草稿保留在 A 槽，切回可见。
- 防误用规则：持久化会话只属于其创建角色；角色切换**不携带**另一角色的会话、消息或上下文。

### 5.3 对象上下文

- AUTO 附着规则不变：仅 `/dashboard/myjobs/[id]` 与 `/dashboard/profile/resume(s)/[id]` 的对象详情页在**该角色的草稿创建时**解析附着（§1.4）。切换角色时新角色草稿按当前页面独立解析自己的 AUTO 项——**不复制**另一角色槽已附着的对象；同一对象在两角色下各自附着是用户可见且有意为之，不算「错误沿用」。
- 持久化会话的上下文跟随会话本身（属于该会话历史，不是「过期」）。
- 「错误沿用」的核心防护：**任何角色槽都不会拿到自己没有显式附着过的对象**；chip 可见可移除（现状）；实体归档/不可见时服务端校验拒绝（现状）。

### 5.4 页面切换与对象失效

- 面板跨页面保持打开（现状）；页面切换**不**自动刷新任一槽的已附着上下文——附着只发生在草稿创建时（现状语义），chips 如实展示会话持有的对象。
- 对象失效：实体被归档 → 已持久会话引用走 `CONVERSATION_ARCHIVED_CONTENT` fail-closed（现状）；上下文选择器列选项时过滤不可见项（现状）；删除实体后该 id 解析失败 → 工具结果 `no_job` 如实传达。V1 不新增主动失效监听——【待决定】是否在 ContextBar 对失效项加「已不可用」徽标（D10 备选；推荐 V1 不加，靠现有校验+chip 手动移除）。

## 6. 打开面板的接口与页面行为【推荐方案】

### 6.1 打开语义（保持并固化）

本合同建议保留 `open()` 的既有语义：**不发送消息、不创建会话、不调用模型**；仅占用 RightRail + 折叠侧边栏 + preflight 状态检查。任何入口不得引入「打开即请求」的旁路（useAutoMatch 属页面深链历史路径，按 §9 D9 裁定，不在打开接口内）。

### 6.2 打开接口扩展

- `open(options?: { role?: AgentRole })`：入口可指定目标角色（首页阶段卡→对应角色；通用入口→上次激活角色）。`role` 缺省时恢复**上次激活的角色槽**（持久化偏好，localStorage）。
- 对象页打开：沿用 AUTO 附着——新角色槽草稿从当前页面解析对象；首页/列表页打开不凭空选对象（现状 `pageContextFor` 对非详情页不返回实体）。
- 面板已开时再次 `open({role})` 不重复占用 rail；同一槽/同一会话重复打开不重复检查。切换到不同会话或草稿时，恢复目标槽状态并按其锁重新执行 preflight，采用既有 epoch/请求归属保护丢弃前槽迟到结果；状态探测不调用模型（见 §7）。

## 7. AI 路径与权限边界保留【推荐方案】

- 三角色共用 `/api/ai/chat` 回合管线、`admitConversationRequest`/`checkpointConversationTool`/`finishConversationRequest`、速率限制、取消/恢复、归档 fail-closed——角色只影响**工具子集、系统提示词、空态建议与归属标记**，不新建执行通道。
- 会话锁保持「每会话一锁、创建时固化」：**三角色统一锁 purpose `CAREER_DIALOGUE`**（【待决定】D4；备选按角色映射既有 purpose——Insight→RESUME、Reflect→CAREER_REFLECTION——不推荐：会让聊天面混入领域用途语义且 Reflect 的 CAREER_REFLECTION 与复盘草稿 action 撞语义）。显式模型选择（`ExplicitModelSelection`）照旧按会话生效。
- preflight/Identity 语义不变：按当前会话锁评估；切换角色槽＝切到该槽会话的锁并重评可用性，不能沿用前槽的 Identity/发送禁用态；不能借切槽修改真实连接状态。`AI_CONFIGURATION_CHANGED_EVENT` 刷新照旧。
- 三条 AI 路径（账号登录/BYOK/托管）独立状态、独立验收边界不变：本 Feature 不新增第四种路径、不改锁语义、不扩大凭据/权限范围；AGENT 路由的结构化输出就绪门照旧（不同 Provider 下不可用即诚实阻断，§2.4）。
- 无后台自主协作：三角色不互相调用、不共享运行时状态（`NestedGenerationGuard` 仍每请求一个）、不自动新增工具、不做定时分析。保持逐工具既有批准边界：add_job 条件批准、canonical match_job 恒需批准；legacy match_job 与 review_resume 不新增批准。AgentToolExecution 的持久化执行语义仅适用于 canonical match_job，不外推给所有写入。

## 8. 与窗口二合同（复盘领域）的依赖边界【推荐方案】

- Reflect 只依赖 `P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md` 已定义的领域契约消费面：实体树（ProcessStep(INTERVIEW) 1:1 InterviewDetail 1:N ReflectionItem）、`getInterviewReflection` 只读/`saveInterviewReflection` 全量替换写（AB_ENABLED+full）、`generateInterviewReflectionDraft` draft-only（CAREER_REFLECTION）、§11 AI 边界。
- **本合同不把任何复盘读取/写入列为 Reflect 可用能力**（§1.7：当前无此类 Agent 工具）。未来若要加 `get_interview_reflection` 等读工具：属新工具合同（单独 Owner 裁定：输入/输出、归档只读语义、谓词复用、批准需求），且必须满足 §11「AI 不写复盘/不置完成标记/不改提交与步骤事实」。
- 「待复盘」谓词（窗口二 §7 / 首页 §4.2，协调建议已对齐、尚待单点裁定）本合同 V1 不消费——Reflect 建议不承诺「找到待复盘面试」类工具行为，只承诺整理用户提供的叙述。
- 复盘对话框内既有的 AI 草稿入口（`InterviewReflectionDialog` 的 generate→Apply→Save）是**该对话框自己的 action**，不是 Reflect 聊天能力；两处 AI 用途独立（CAREER_REFLECTION vs CAREER_DIALOGUE），本合同不改它的边界。

## 9. Owner 决策表（编号；每项 2–3 互斥选项）

| # | 待决项 | 选项 | 本合同推荐 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 角色-会话绑定模型 | (a) 每角色独立会话槽（角色于创建时固化，槽间不共享会话/草稿/上下文）；(b) 单会话共享、角色仅为下一轮提示属性；(c) 切换角色＝强制新草稿（旧草稿弃入历史） | **(a)** | (a) 隔离最强、与「创建时固化」先例一致；(b) 人格漂移污染同一份转录；(c) 丢草稿体验差 |
| D2 | 角色存储 | (a) `ChatConversation.agentRole` 可空列+additive migration；(b) `context` JSON 信封内嵌角色字段（零 Schema） | **(a)** | (a) 历史徽标/过滤可直接查列、语义显式；需一条 additive migration（实现期指定唯一 Schema/备份 Owner，与复盘包顺序交接）；(b) 上下文整写路径要保字段、过滤需 JSON 提取，不推荐 |
| D3 | 历史列表角色展示 | (a) 统一列表+角色徽标；(b) 加按角色过滤；(c) 不变 | **(a)** | 徽标成本最低、向后兼容（旧行=「通用」）；过滤可后续加 |
| D4 | 三角色锁 purpose | (a) 统一 `CAREER_DIALOGUE`；(b) 按角色映射 RESUME/CAREER_DIALOGUE/CAREER_REFLECTION | **(a)** | (a) 语义最小改动、不混领域用途；(b) 给每角色独立分配模型的钩子但撞 purpose 语义 |
| D5 | canonical `match_job` 进 Insight 建议 | (a) 可列（真实注册），文案「运行匹配分析」；(b) 首版不列入建议，保留工具并换用其他真实能力建议 | **(a)** | (a) 与「未实现不得列」一致（它已实现）；(b) 仅调整首版提示密度，不把已验收工具说成不可用 |
| D6 | Pilot 白名单是否含 `get_resume` | (a) 不含；(b) 含（只读） | **(a)** | (a) 边界干净；(b) 支持「简历投过哪些职位」类问答但模糊角色分工 |
| D7 | 窄宽 header 收缩优先级 | (a) 图标组>角色名>Identity>历史/新对话>展开/关闭；(b) 角色名常驻、Identity 先收缩 | **(a)** | 仅布局；实现期可在 (a) 内微调断点 |
| D8 | 无 AI 配置时建议条行为 | (a) 可点击填入、发送键禁用+诚实横幅；(b) 建议条禁用 | **(a)** | (a) 填入只是文本、横幅解释为何发不出；(b) 更保守但隐藏功能面貌 |
| D9 | 页面级 CTA（startChat/startReview/useAutoMatch）语义 | (a) 保持「打开+发送」（显式动作）；(b) 统一为「打开+填入」；(c) 按运行时区分 | **(a)** | (a) 仅明确请求含义的按钮可按显式请求处理；useAutoMatch 深链须核对来源，不能直接等同发送确认；(b) 与建议条语义统一但多一步确认；(c) 不一致 |
| D10 | 上下文失效项 UI | (a) V1 不加失效徽标（现有校验+可移除 chip）；(b) ContextBar 加「已不可用」徽标 | **(a)** | (a) 零新增面；(b) 更友好但需每槽重校验 |

**裁定后冻结点**：D1/D2 决定是否需要一条 additive migration；D4–D6 冻结提示词与建议矩阵；D9 决定页面 CTA 是否随本包改造；其余为产品语义冻结。

## 10. 一体化开发成果边界与文件 Owner 建议【推荐方案】

### 10.1 成果边界

建议作为一个**独立实施包**交付：三角色人格层（提示词/白名单/建议）+ 顶部切换器 + 角色-会话绑定 + 「填入不发送」改造 + 双语文案 + 定向测试。它不依赖 JOB-CONNECTIONS/INTERVIEW-DEBRIEF 的领域增量（Reflect 首版即诚实降级形态），不依赖 CAREER-INSIGHTS；与首页合同的衔接只是阶段卡 `open({role})` 的槽位参数，首页结构不变（文首交叉项①）。

### 10.2 主要改动面与共享文件 Owner

| 文件/区域 | 建议 Owner | 说明 |
| --- | --- | --- |
| `src/components/agent/*`（Provider/Panel/EmptyState/History/ContextBar/Input/Identity/新角色切换器） | 本包 Owner | 角色槽、切换器、填入通道、徽标 |
| `src/components/AgentChatTrigger.tsx`、`Header.tsx`/`TitleBarActions.tsx`（入口 `open({role})` 签名） | 本包 Owner | 首页合同确认归 MULTI-AGENT |
| `src/lib/agent/prompt.ts`、`tools/index.ts`（角色白名单过滤）、`conversationContext.ts`（如需角色字段） | 本包 Owner | 提示词变体、工具裁剪 |
| `src/lib/agent/chatConversationStore.ts`、`agentChat.actions.ts`、`chatTypes.ts`、`activeConversation.ts` | 本包 Owner | 角色固化/槽位持久化/历史徽标数据 |
| `src/app/api/ai/chat/route.ts`（角色从持久会话读取、构建工具传入） | 本包 Owner | 服务端权威读角色 |
| `prisma/schema.prisma` + `prisma/migrations/<new>/` + `src/lib/backup/schema.ts`/备份版本定义（若 D2-a 裁定） | 主协调指定唯一 Schema/备份 Owner；本包与复盘包顺序交接 | additive agentRole 列及备份字段/新格式版本同步；新备份保留角色，旧备份/旧行 NULL 兼容；不改写已执行 migration |
| `src/i18n/messages/zh-CN.json` + `en.json` | **共享词典单一 Owner**——主协调指定唯一词典 Owner，首页/复盘/本包提交键清单，由该 Owner 顺序整合 | 角色名/建议/降级文案双语同步 |
| `src/components/myjobs/JobDetails.tsx`、`src/components/profile/ResumeContainer.tsx`、`useAutoMatch.ts` | 本包 Owner（仅当 D9 裁定改造时） | 页面 CTA 语义 |
| `wiki/P2_FEATURES.json`、`P2_IMPLEMENTATION.md` | Main 集成 Owner | 集成后同步状态 |
| 首页合同/窗口二合同文件、`interviewReflection*`、`applicationService.ts`、复盘对话框 | **不改**（各自 Owner） | 交叉项见 §8/§13 |

### 10.3 不做（Non-goals）

不新增工具、不改 Provider/凭据/Entitlement、不改 ChatConversation 既有锁与批准机械、不动归档中心、不改复盘对话框 action、不实现后台分析或跨角色调用、不改路由表。

## 11. 最小验证矩阵（仅定义，不执行）

| # | 场景 | 验证点 |
| --- | --- | --- |
| V1 | 顶部切换器 | 三图标按固定顺序渲染；hover 与焦点均显示角色名；Tab 可达并激活；`aria-current` 正确；340px 最小宽下聊天区不被角色栏挤占 |
| V2 | 建议填入不发送 | 每角色空态恰为 4 条建议（能力不可用时以不依赖工具的真实对话建议替换）；点击只填充输入框——断言无 `/api/ai/chat` 请求、无会话创建；编辑后发送正常；preflight 失败时按 D8 裁定表现 |
| V3 | 角色-会话绑定 | 在 Insight 下创建会话→行持久化 `agentRole=Insight`；切到 Pilot 显示 Pilot 槽而非 Insight 会话；切回 Insight 原会话/草稿仍在；刷新/重开面板恢复上次激活角色槽 |
| V4 | 历史徽标与旧行 | 历史行显示角色徽标；旧行（NULL）显示「通用」/Pilot 归属；选中历史会话激活对应角色槽 |
| V5 | 打开不发送 | 首页与各业务页 `open()`/`open({role})`：断言 0 次 `/api/ai/chat`、0 次会话创建；仅 preflight 状态检查 |
| V6 | 白名单生效 | 服务端断言各角色注册工具集＝白名单∩运行时集（Insight 无 add_job、Pilot 无 match_job/review_resume、Reflect 仅 list_jobs/get_job）；提示词枚举与注册集一致；模型被要求调用越权工具时无该工具可用 |
| V7 | 批准边界不变 | 按 §1.2 逐运行时验证批准矩阵：可写 add_job 与 canonical match_job 走批准，拒绝不落库；legacy match_job/review_resume 保持既有无批准语义；仅 canonical match_job 验证 AgentToolExecution 重放幂等 |
| V8 | 上下文互斥 | 角色 A 附着 job-A；切角色 B 的草稿不携带 job-A（除非 B 槽在同页自行 AUTO 附着）；持久会话上下文不跨角色；归档对象会话→`CONVERSATION_ARCHIVED_CONTENT` |
| V9 | Reflect 诚实降级 | Reflect 建议与提示词不含复盘读写承诺；要求「读/写我的复盘」时如实拒绝并引导手动复盘入口；可只读定位父职位 |
| V10 | 三 AI 路径不变 | account/managed/legacy 锁行为、preflight 与 blocked 诚实码在切换角色后一致；AGENT 路由结构化输出门照旧；无静默回退 |
| V11 | CTA 语义（按 D9） | JobDetails/ResumeContainer 按钮行为符合裁定；`useAutoMatch` 仍 legacy-only |
| V12 | Schema（若 D2-a） | 隔离库 additive migration 后 `agentRole` 可空、旧行 NULL；新格式备份必须保存/恢复 agentRole，不得丢角色后降为 Pilot；仅旧行/旧格式缺字段时 NULL 兼容；覆盖 Insight/Reflect 导出恢复及工具集一致性 |

## 12. 待核实/待协调项汇总

| 项 | 现状 | 需要 |
| --- | --- | --- |
| 「已结束」谓词双合同口径 | 两合同均推荐仅 COMPLETED，尚未批准 | Owner 同一次裁定两处；本合同 V1 不消费 |
| agentRole 备份兼容 | ChatConversation 已在备份内（backup/schema.ts、ordering.ts MODEL_SPECS）；D2-a 若获批必须同步角色字段 | 新格式保留角色；仅旧行/旧格式缺字段兼容 NULL；唯一 Schema/备份 Owner 随 migration 一并实现 |
| 角色名/图标/副标题文案 | 未定稿 | 实现期 i18n 双语定稿 |
| Reflect 复盘读工具（如 `get_interview_reflection`） | 不存在 | 不在本合同；未来单独工具合同+窗口二 Owner |
| `seedExchange` 去留 | 仅空态加职位建议使用 | 建议改填入后由实现决定 |
| 首页阶段卡槽位（D7-A 单入口） | 首页合同推荐 V1 单入口，D7 尚未裁定 | MULTI-AGENT 落地时同槽位改传 `open({role})`，协调首页 Owner |

## 13. 授权声明

本提案仅为评审与冻结候选；标注【推荐方案】/【待决定】的内容**不是已冻结决定**，实施前须经 Owner 逐项裁定 §9 决策表。本文件不构成代码修改、Schema/Migration、提交、合并、推送、发布、真实数据操作或真实 AI/凭据调用授权。
