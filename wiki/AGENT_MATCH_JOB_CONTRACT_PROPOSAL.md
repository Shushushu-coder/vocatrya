# AGENT `match_job` 工具合同提案（P1 AGENT-CAPABILITIES）

- 基线：`main @ 39a5a1d3`；分支 `codex/p1-match-job-contract`；工作树 `.worktrees/p1-match-job-contract`。
- 状态：**D1–D6 已获 Owner 批准；canonical 实现已于 2026-10-31 合入 Main**（`67a3adf6`，merge `393155fc`）。freshNativeFull 注册 canonical `match_job`（需批准、复用 FAST_SCREENING / MatchAnalysisService、`AgentToolExecution` 台账）。尚未完成真实 AI 调用与 Windows Electron 验收；`AGENT-CAPABILITIES` 保持 OWNER_DECISION / PARTIAL / `passes: false`。下文部分【源码事实】仍描述合入前的基线 `39a5a1d3`，与当前 Main 不一致处以 P1 台账为准。
- 依据：`wiki/P1_FEATURES.json`、`wiki/P1_IMPLEMENTATION.md`（AGENT-CAPABILITIES 节，只读）及基线源码只读核查。本仓库无 `.codegraph`。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行）；**【推荐】**＝本合同建议；**【待决定】**＝需 Owner 冻结的产品规则。标注不一致处以 P1 台账与本文件决策清单为准。

## 1. 范围与边界

### 1.1 P1 台账现状与本任务定位【源码事实】

- `AGENT-CAPABILITIES` 在 `wiki/P1_FEATURES.json:120-133` 为 **OWNER_DECISION / PARTIAL / passes:false**。台账已写明：
  - fresh-native/full 当前开放五项工具：`list_jobs`、`get_job`、`add_job`、`get_resume`、`review_resume`；`add_job` 需要批准且不代表投递；`review_resume` 不自动保存至 Resume Variant；`match_job`、`generate_cover_letter` 未开放。
  - `match_job` 登记为**候选 Agent Tool 工作项**：未来接入必须**复用独立 canonical 匹配业务服务和可追溯的简历版本输入**，**禁止直接启用 Legacy 工具**；写工具仍须单独确认**批准、权限、失败恢复、幂等**。
  - canonical `FAST_SCREENING`/`MatchAnalysisService` 是独立可复用业务能力；其实现状态**不能外推成 Agent `match_job` 可用**。Deep Match 不在已交付能力中。
- `wiki/P1_IMPLEMENTATION.md:130-146` 同样声明：不能“直接解除旧 Legacy `match_job` 门控”，也“不能只修改提示词就宣称支持匹配”。

### 1.2 本合同回答的问题

1. 现有五项工具与候选 `match_job` 的注册、权限、确认、模式门与返回契约（§2）。
2. canonical `FAST_SCREENING → MATCH_ANALYSIS → MatchAnalysisService` 的真实调用、持久化、历史与 stale 规则（§3）。
3. Resume Builder 可提供的结构化版本、职位绑定与追溯能力（§3.4）。
4. 归档/跨用户/受限模式/不可用模型的拒绝边界（§3.5）。
5. `match_job` 的合同提案：输入、写入语义、确认与幂等、模型与失败、输出与呈现、复用边界（§4）。
6. 最小 Owner 裁定集（§6）。

### 1.3 明确排除（非目标）【推荐，沿用 P1 台账】

- 不实现工具；不修改产品代码；不修改 `wiki/P1_FEATURES.json` / `wiki/P1_IMPLEMENTATION.md`。
- 不扩展其他 Agent 新工具；`generate_cover_letter` 同样被 fresh-native 隐藏，但本合同不处理其接入。
- 不包含自动投递/自动申请（`add_job` 合同已声明“不代表实际投递”，`prompt.ts:20,22`）。
- 不包含自动修改简历/Resume Variant/版本。
- 不包含 Deep Match（`createDeepMatch`、`linkMatchEvidence` 仅为休眠服务方法，见 §3.6）。
- 不允许绕过运行时模式/能力门（`assertFullAbWritable`、`assertMatchSurfaceEnabled` 保持权威）。
- 不把 Legacy `Job.matchData` 当作 canonical 历史；不把旧 `match_job`、旧 prompt、旧 automation matcher 视为已交付能力。

## 2. 源码事实：Agent 工具现状

### 2.1 注册与模式门【源码事实】

- `buildAgentTools`（`src/lib/agent/tools/index.ts:17-84`）每次请求构造 **7** 项工具：`add_job`、`list_jobs`、`get_job`、`get_resume`、`review_resume`、`match_job`、`generate_cover_letter`；`ctx.freshNativeFull === true` 时 `delete tools.match_job` 与 `delete tools.generate_cover_letter`（`:79-82`）。
- `canonicalJobs = ctx.canonicalJobs === true || ctx.freshNativeFull === true`（`:42`）只决定 `add_job` 是否用 canonical writer（`:44`）；**不改变 `match_job` 的任何行为**。
- 路由侧旗标（`src/app/api/ai/chat/route.ts:453-461`）：`freshNativeFull = isFreshNativeFullSurface(careerRuntime)`（fresh 数据起源 + `AB_ENABLED` + full scope，`src/lib/career/freshSurfacePolicy.ts:31-38`）；`canonicalJobs = isFullAbCapabilityEnabled(mode, scope)`（含 migrated-full，`src/lib/career/capabilities.ts:36-43`）。
- 工具上下文：`pageContext` 来自**持久化会话上下文** `pageContextFromConversation(contextOfRow(conversation))`（`route.ts:451`；`chatConversationStore.ts:318-322`；`conversationContext.ts:158-168`）——即会话绑定的 `kind:"job"|"resume"` 实体项（`source: AUTO|MANUAL`），不是请求时的实时路由。客户端页面与持久化上下文的同步由 `updateOwnedChatConversationContext` CAS 完成（`chatConversationStore.ts:191-199`）。
- `userId`、`pageJobId`/`pageResumeId` 一律为路由闭包参数；模型输入中同名字段被忽略（各工具注释与 `agentMatchJobTool.spec.ts:104-110` 专测）。
- 测试基线：`agentFreshFullTools.spec.ts:18-71` 断言 fresh+full 下恰好五项、migrated-full（`canonicalJobs:true`）下七项且 `match_job` 保留。

### 2.2 现有五项工具逐项【源码事实】

| 工具 | 注册/构建 | 输入 Schema | 读/写 | needsApproval | 模式门 | 返回契约（`agent.model.ts`） |
|---|---|---|---|---|---|---|
| `add_job` | `buildAddJobTool(userId, pastedText, {canonical, request})`（`tools/addJob.ts:42-181`） | `AgentAddJobSchema`（canonical 全量；legacy `omit({deadlineOn})`，`tools/addJob.ts:54-56`） | 写：canonical→`createAgentOpportunity[InTransaction]`；legacy→`createJobFromNames` | 是：函数式，canonical 要求 company+jobTitle 非空（`:61-66`） | `canonicalJobs` 旗标选 writer | `AgentAddJobResult`（`agent.model.ts:50-68`）`created/jobId/jobOpportunityId/.../validationError/displayError` |
| `list_jobs` | `buildListJobsTool(userId)`（`tools/listJobs.ts:8-24`） | `AgentListJobsSchema = {}` | 只读：`listJobsForAgent` → `listJobs` dispatch | 否 | blocked 读族 → `unavailable` | `AgentListJobsResult`（`agent.model.ts:90-92`）`ok{jobs,total,truncated}`/`unavailable` |
| `get_job` | `buildGetJobTool(userId, pageJobId)`（`tools/getJob.ts:8-25`） | `AgentGetJobSchema {jobId?}`（`agent.schema.ts:107-115`；id 须来自 `list_jobs`） | 只读：`getJobForAgent` → `getJob` dispatch | 否 | blocked → `unavailable`；**归档 canonical 职位→`no_job`**（`canonicalJobRead.ts:94-95`） | `AgentGetJobResult`（`agent.model.ts:94-108`）`ok/no_job/unavailable`；description 截断 `AGENT_CHAT_RESUME_MAX_CHARS`（`canonicalJobRead.ts:96-97`） |
| `get_resume` | `buildGetResumeTool(userId, pageResumeId)`（`tools/getResume.ts:16-71`） | `AgentGetResumeSchema {resumeTitle?}`（`agent.schema.ts:70-74`；注释明示不接受 id） | 只读：`resolveCanonicalResumeForAgent`（legacy Resume 或 AB variant 投影） | 否 | blocked 读族 → `unavailable` | `AgentGetResumeResult`（`agent.model.ts:110-124`）`ok/needs_selection/no_resumes/unreadable/unavailable` |
| `review_resume` | `buildReviewResumeTool({userId,pageResumeId,model,...,guard})`（`tools/reviewResume.ts:40-148`） | `AgentReviewResumeSchema {resumeTitle?}` | 生成+条件写：legacy Resume 存 `reviewData`；**AB variant 不保存**（`saved:false`+提示，`:130-134`） | 否（`:44-45` 注释：写调用者自身数据且全程可见流） | 读族 dispatch | `AgentReviewResumeResult`（`agent.model.ts:137-151`）`ok/needs_selection/no_resumes/unreadable/generation_failed/unavailable` |

共同点：失败以**判别联合结果**返回而非抛出（`ConversationRequestError` 例外，会 `request.abort?.()` 中止整轮，`conversationRequest.ts:150-153`）；结果卡确定性渲染（`AgentResultCard/index.tsx:63-81`），`output-denied`/`output-error` 分别渲染“已取消”与通用失败文案（`:27-59`）。

### 2.3 `match_job` / `generate_cover_letter` 现状【源码事实】

- `match_job`（`tools/matchJob.ts:44-183`）是 **Legacy 实现**：
  - 职位解析 `resolveJobForAgent(userId, pageJobId)` 只查 **legacy `Job` 表**（`jobLookup.ts:13-28`，注释明确为防 canonical id 被 legacy writer 持久化）；canonical `JobOpportunity` id 一律解析为 `no_job`。
  - 简历解析 `resolveResumeForAgent` 走 **legacy `Resume` 表**（`resumeLookup.ts:66-112`）；选择顺序：具名标题 → `job.resumeId` 充当 page 槽位 → `defaultResumeId` → 唯一 → `needs_selection`。
  - 生成：`runNestedGeneration` 用**会话锁模型**发 `JOB_MATCH_SYSTEM_PROMPT` 流式子调用（`matchJob.ts:91-112`），`parseJobMatch` 提取 `SCORES:` 行+markdown body（`:135-144`）。
  - 写入：`Job.matchScore`/`Job.matchData` **覆盖式**更新（`saveJobMatchResult`/`saveMatchInTransaction`，`:146-166`），`Job.matchScore Int?`、`Job.matchData String?`（`schema.prisma:458-459`）。`JobMatchData` 含 `matchScore/recommendation/body/resumeId/resumeTitle/matchedAt/provider/model/surface="chat"`（`ai.schemas.ts:33-76`）。
  - 确认：**无 `needsApproval`**（`:48-49` 注释：只写调用者自己职位上的 matchData 且全程可见流）。
  - 幂等：`ctx.request` 存在时写路径包 `checkpointConversationTool`（`:157-160`）——同一 `toolCallId`+toolName+input 的重放返回既有输出，不重复写。
  - 结果 `AgentMatchJobResult`（`agent.model.ts:155-172`）：`ok{jobId,jobTitle,company,resumeId,resumeTitle,scores,body,saved,saveError}` / `no_job` / `needs_selection{resumes}` / `no_resumes` / `unreadable{what,title,reason}` / `generation_failed{jobTitle,reason}`。
- `match_job` 已列入：`AGENT_NESTED_TOOLS`（`agent.model.ts:201-205`，瞬态流部分+并发闸语义）、`AGENT_CHAT_TERMINAL_TOOLS`（`:216-219`，调用即终轮）、写收据集合（`writeReceipt.ts:7-19`，`saved===true` 阻断 regenerate）、工具标签键（`toolLabels.ts:7`）、evals 注册面（`evals/agent-chat/tools.ts:57-63`）。
- `generate_cover_letter`（`tools/generateCoverLetter.ts:45-182`）同构 Legacy 实现，写入生成信件文档；本合同不扩展。
- **关键边界**：fresh-native/full 删除两者（`tools/index.ts:79-82`）；`canonicalJobs`（含 migrated-full）下 `match_job` 仍以 **Legacy 实现注册**——但它只对 legacy `Job`/`Resume` 行生效；在 AB 读族下页面上下文给的 `JobOpportunity` id 解析为 `no_job`，即 **migrated-full 上该工具对可见职位实际不可用**。
- Prompt 面：legacy 七能力文案宣传 `match_job`（`prompt.ts:9,93`），fresh-full 五能力文案把 “run a match analysis” 列入 **cannot**（`prompt.ts:20-22`）；fresh-full 页面上下文行不得引导 `match_job`/`generate_cover_letter`（`prompt.ts:132-139`；`agentFreshFullTools.spec.ts:119-141`）。工具描述 `AGENT_TOOL_DESCRIPTIONS.match_job`（`prompt.ts:93`）描述的是 legacy 语义（“score”“save the result to that job”“streams it”）。

### 2.4 会话、确认、幂等、取消机制【源码事实】

- 准入 `admitConversationRequest`（`conversationRequest.ts:45-103`）：会话归属 `userId`；`archivedAt` → `CONVERSATION_ARCHIVED`；活跃请求锁 `activeRequestId/ExpiresAt`（schema 字段 `prisma/schema.prisma:670-708`）；`revision` CAS；`send` 遇挂起 approval 冲突拒绝；`regenerate` 拒绝末尾含写收据的尾段（`writeReceipt.ts:18-20`）。
- 归档内容门：`hasArchivedJobReference`（`archiveVisibility.ts:6-17`）在 `route.ts:420-424` 扫描会话 context+messages+新消息——**任何位置引用已归档 `JobOpportunity` id 即整轮拒绝** `CONVERSATION_ARCHIVED_CONTENT`（对应归档合同 D6：AI 无权读取归档内容）。
- 工具幂等 `checkpointConversationTool`（`conversationRequest.ts:126-160`）：事务内先 CAS 会话锁，再按 `toolCallId`+`tool-`+toolName+input 精确匹配查找既有 `output-available` receipt；命中即**重放输出、不执行 mutate**；input 不匹配 → `CONVERSATION_TURN_CONFLICT`。`operation==="approval"` 时硬编码校验 `receipt.toolName === "add_job"` 且 `toolCallId === approvalToolCallId`（`:139`）。
- 回合信号：legacy 路径 `turnSignal = any(executionAbort, req.signal, timeout(300s))`（`route.ts:593-603`），工具的 `execute` 收到 `abortSignal`；account 路径同样（`accountTurn.ts:807-812`）。`AGENT_CHAT_TIMEOUT_MS=300_000`、`AGENT_CHAT_MAX_STEPS=4`、`AGENT_CHAT_NUM_CTX=16384`、`AGENT_CHAT_RESUME_MAX_CHARS=12_000`、`AI_JOB_MATCH_TIMEOUT_MS=180_000`、`AGENT_CHAT_MATCH_SURFACE="chat"`（`constants.ts:81-86,165-207`）。
- `runNestedGeneration`（`nestedGeneration.ts:50-156`）：每请求 `nestedGuard` 单并发（busy→`generation_failed`）；`AbortSignal.timeout(timeoutMs)` + 外层 abort 合并；token 以 `data-nested-stream` 瞬态部分写出；`providerOptions.vocatrya.toolCallId` 让 Managed 适配器以 toolCallId 铸造幂等 invocationKey（`accountLanguageModel` 侧嵌套身份），崩溃/重放走 INVOCATION 语义而非重复计费。
- Account/Managed 路径：`runAccountAgentTurn`（`accountTurn.ts:459-846`）以 `createAccountRuntimeLanguageModel` 包锁定的 connection+model 作 `nestedModel`（`:478-485`），`buildAgentTools` 复用同一 `freshNativeFull`/`canonicalJobs` 旗标（`:486-497`）；`needsApproval` 暂停回合、approval 响应后按 `approvalToolCallId` 续跑（`:775-796,861-870`）；`isTerminalOutcome` 终轮（`:850-859`）；结构化决策要求 verified structured output（`careerDialogueTurn.ts:41-98`）。
- ChatConversation 创建期 AI 锁：`resolveChatCreationLock`（`chatConversationLock.ts:188-233`）按 `CAREER_DIALOGUE` purpose 解析；Managed 先绑定 `conversation:<id>` 再写行；`INVALID_ASSIGNMENT` 仍持久化为“坏锁”使每轮显式失败（fail-closed，`:38-40`）。**该锁与 `MATCH_ANALYSIS` 分配是两条独立解析链**。

### 2.5 前端呈现边界【源码事实】

- 结果卡：`AgentResultCard/index.tsx` 按工具名分发；`match_job` → `MatchJobResult.tsx`（渲染 `scores` 径向图+`body` markdown；`saved:false` 时显示 `matchNotSaved`）。
- 职位详情：`JobDetails.tsx:345-363`——`freshNativeFull` 时 match 页签渲染 `<MatchAnalysisPanel jobId={job.id}/>`；否则渲染 legacy `MatchDetails`（`job.matchData` 解析）或空态按钮 `onMatch`（`requestChat("Match my resume to …")`，`:190`）。`useAutoMatch` 的 `?match=1` 自动触发**在 fresh-native 禁用**（`:194`，条件 `!freshNativeFull && jobMutationsEnabled && !isArchived`）。
- i18n：`agent.tools.matchJob` 键已存在（`toolLabels.ts:7`）；`matchAnalysis.*` 系列键覆盖 verdict/stale/errors（面板 `:95-138` 的 `errorMessageKey`/`verdictLabel` 映射）。

## 3. 源码事实：canonical 匹配链路

### 3.1 `runFastScreening` 调用链【源码事实】

`src/lib/career/fastScreening.ts` 顶部注释（`:32-44`）即契约：`source selection → material/preference snapshot → deterministic JobDescriptionParse (raw-text pass-through) → MATCH_ANALYSIS assignment resolution → structured TEXT_ONLY execution → MatchAnalysisService persistence → stale marking`。失败运行不持久化任何行（只存在 `COMPLETED` 行）。

逐步（`runFastScreening` `:455-581`）：

1. `requireOwnedOpportunity(db,userId,jobOpportunityId)`（`:148-173`）：`{id,userId}`+`currentJdVersion`。**不检查 `archivedAt`**（见 §3.5 边界）。
2. JD 文本：`currentJdVersion.rawContent`（HTML→`removeHtmlTags`）；缺失/空 → `{kind:"failed", code:"MATCH_JD_MISSING"}`（`:470-474`）。
3. `loadPreferenceSnapshot`（`:188-219`）：求职偏好 7 字段快照+文本。
4. 素材源：`{kind:"career-profile"}` → `buildCareerProfileMaterial`（CareerMaterial 列表全文）；`{kind:"resume-version",versionId}` → `buildResumeVersionMaterial` → `ResumeVariantService.getVersion` + `projectResumeVariantText`（`:255-280`）。空素材且无偏好 → `MATCH_INSUFFICIENT_MATERIAL`（`:488-495`）。
5. `ensureRawTextParse`（`:306-341`）：`inputHash = hash(schemaVersion+parserVersion"jd-raw-text-v1"+jdContentHash)`；同哈希复用既有 `JobDescriptionParse`，否则**创建行并回写 `jobDescriptionVersion.currentParseId`**（注意：这是写操作）。
6. `executeStructuredForAssignment`（`src/lib/ai/structured-execution.ts:137-255`）：`purpose:"MATCH_ANALYSIS"`，schema `FAST_SCREENING_RESULT_SCHEMA`（required 包含全部五键，`verdict∈{PASS,BORDERLINE,FAIL}`，`hardRequirements/coreMatch/preferenceMatch` 必须出现但可为 null（2026-10-31 strict schema 修复），`additionalProperties:false`，`fastScreening.ts:52-63`）；`runId=randomUUID()` → `operationId:"match-analysis:${runId}"`、`managedResource:{business:"MATCH_ANALYSIS",resourceKey:"match-analysis:${runId}"}`（`:502-522`）；注释声明**每次运行铸造新身份，重击不会重放旧收据**（`:515-516`）。
7. 执行结果：`NOT_CONFIGURED`→`{failed,"NOT_CONFIGURED"}`；非 OK→`{failed, executed.code, issueSummary}`（`:526-535`）。
8. `MatchAnalysisService.createFastScreening`（`matchAnalysisService.ts:108-191`）：写 `MatchAnalysis`（`status=COMPLETED`、`resumeVariantVersionId:null`、provider/model/`resolvedConnectionId`/`managedAiProvenance` 快照）+ `FastScreeningDetail`（`inputSnapshot=canonicalize(hashInput)`，含完整素材/偏好快照文本）。
9. `markSupersededAnalysesStale`（`fastScreening.ts:364-400`）：对同机会非 stale `FAST_SCREENING` 行，按各自 `inputSnapshot` 比较 `jdContentHash`/`careerMaterialSnapshot`/`preferenceSnapshot`，差异→对应 `JD_CHANGED/CAREER_MATERIAL_CHANGED/PREFERENCE_CHANGED`；**输入相同则旧行保持非 stale**（不判重，允许重复新鲜行）。
10. `getAnalysis` 回读 → `MatchAnalysisListItem`（`fastScreeningContract.ts:41-52`：id/type/status/createdAt/completedAt/provider/model/isStale/staleReasonCodes/fastScreeningDetail{verdict,hardRequirements,coreMatch,preferenceMatch,reasons}）。

### 3.2 `MatchAnalysisService` 契约【源码事实】

`src/lib/career/matchAnalysisService.ts`：

- `gate()` = `assertFullAbWritable`（`:68-70`）——**读与写全部方法**都要求 `AB_ENABLED`+full scope；不满足抛 `CareerRuntimeError("AB_WRITES_NOT_ENABLED")`。即受限模式下连历史读取都不可用。
- `getAnalysis` `{id,userId}` include 明细（`:72-86`）；`listAnalysesForOpportunity` 归属校验+`createdAt desc`（`:88-106`）。
- `createFastScreening`：**禁止** `resumeVariantVersionId`（`FAST_SCREENING_FORBIDS_RESUME`，`:129-134`）→ `MatchAnalysis.resumeVariantVersionId` 对 FAST_SCREENING 恒空；简历版本仅以 `careerMaterialSnapshot.resumeVariantVersionId` 字段留在 `inputSnapshot` JSON 内（`fastScreening.ts:271-276`）。
- `requireWritableOpportunity`（`:383-392`）：`archivedAt!==null` → `OPPORTUNITY_ARCHIVED`；`requireOwnedParse`（`:394-415`）先过此门再校验 parse↔version↔opportunity 链。`markAnalysesStaleForInputChange` 同用可写门（`:345-370`）。
- `createDeepMatch`（`:193-281`）**要求** `resumeVariantVersionId`（`DEEP_MATCH_REQUIRES_RESUME`）；`linkMatchEvidence`（`:283-317`）；两者**无任何调用方**——休眠代码，不等于已交付。
- stale：`markStale`（`:319-343`）幂等（已 stale 直接返回）、reason codes 去重排序 JSON；`markAnalysesStaleForInputChange` 供 JD 版本等输入变更批量打标。
- `requireOwnedVersion`（`:417-429`）：`resumeVariant.userId` 归属链；`requireOwnedAnalysis/Evidence/Expression` 同理。

### 3.3 服务端 Action 与面板【源码事实】

- `matchAnalysis.actions.ts`：`assertMatchSurfaceEnabled`（`:32-40`）`isFullAbCapabilityEnabled` 否则 `MATCH_UNAVAILABLE`；`parseSource`（`:42-57`）非法 source → `MATCH_SOURCE_INVALID`；三个 action 薄封装 lib（`:59-108`）。
- `MatchAnalysisPanel.tsx`：source 选择器 `career-profile`/`resume-version:{versionId}`（`:38-40,140-145`）；preflight 展示 assignment 状态（`:290-301`）；Run 按钮每次点击完整重跑、成功后刷新历史（`:211-238`）；错误码分桶 `CONNECTION_CODES/ASSIGNMENT_CODES/QUOTA_CODES`+`STRUCTURED_OUTPUT_*` → `matchAnalysis.errors.*`（`:43-111`）；结果=verdict 徽标+stale 徽标/原因+四段正文+provider/model（`:345-419`）；历史列表可点选（`:421-464`）。面板仅在 `freshNativeFull` 挂载（`JobDetails.tsx:347-348`）。

### 3.4 Resume Builder 可复用输入【源码事实】

- `ResumeVariant`（`schema.prisma:1501-1519`）：`userId`、`name`、`targetJobOpportunityId`（职位绑定，SetNull）、`currentVersionId`、`archivedAt`；`@@index([userId,archivedAt])`。
- `ResumeVariantVersion`（`:1523-1558`）：`@@unique([resumeVariantId,versionNumber])`、`parentVersionId` 谱系、`status`（`DRAFT` 可变；`FROZEN/SUBMITTED/ARCHIVED` 服务层不可变）、`targetJdVersionId`（对哪个 JD 版本定制）、`sourceMatchAnalysisId`（由哪次分析派生）、`currentForVariant` 反链、`submittedAttempts`/`deepMatchAnalyses`。
- `ResumeVariantService.gate()` = `assertResumeV1Writable`（`:87-89`；`capabilities.ts:95-113`，`AB_ENABLED`+`resume_v1|full`）。
- `listSubmittableVersions`（`:275-304`）：variant `archivedAt:null` ∧ 版本 `status∈{DRAFT,FROZEN,SUBMITTED}`——即**可递交/可筛选**版本集；`getVersion`（`:306-353`）仅 `resumeVariant.userId` 归属校验，**不检查 variant archivedAt 与 version.status**（直接传 ARCHIVED 版本或归档 variant 的版本也能读）。
- `updateTargetJob`（`:437-451`）：以 versionId 入参把 `resumeVariant.targetJobOpportunityId` 绑定到未归档自有 `JobOpportunity`。
- Agent 侧已有分发：`resolveCanonicalResumeForAgent`（`resumeLookup.ts:155-188`）→ AB：`listAbResumeChoices`（非归档 variant 名列表，`resumeReadDispatch.ts:72-82`）+ `selectAbResume`（具名 exact→substring→最新、page id、唯一，`:114-149`）+ `readAbResumeVariant`（`variant.currentVersionId`，缺省取末版，`resumeReadDispatch.ts:104-142`）→ 返回 `{id,title,versionId,text,source,ambiguousTitle}`。**该 versionId 正是 `FastScreeningSource.resume-version` 所需形状**，但注意其选取**不按 submittable 状态过滤**。

### 3.5 归属、归档、模式与模型拒绝边界【源码事实】

- 归属：`requireOwnedOpportunity`/`getVersion`/`requireOwnedParse/Version/Analysis` 全链 `userId` 校验；跨用户 id 一律 `*_NOT_FOUND` 且不回显存在性。
- 归档职位：读（`getAnalysis`/`listAnalysesForOpportunity`/`requireOwnedOpportunity`）**允许**；写（`createFastScreening`/`markAnalysesStaleForInputChange` 经 `requireWritableOpportunity`）→ `OPPORTUNITY_ARCHIVED`。**顺序缺陷**：`runFastScreening` 先 `ensureRawTextParse` 写 parse+回写 `currentParseId`、再发起 AI 调用，最后 `createFastScreening` 才抛 `OPPORTUNITY_ARCHIVED`——归档职位上的一次运行会**先产生 parse 写+消耗一次 AI 调用再失败**。
- 归档简历：选项面（`listSubmittableVersions`/`listAbResumeChoices`/`readAbResumeVariant`）过滤 `archivedAt:null`；但 `getVersion` 不校验→**直接喂 ARCHIVED 版本/归档 variant 的版本仍可作为 source 跑**（§3.4）。
- Agent 侧归档：`getJobForAgent` 归档 canonical 职位 → `no_job`（`canonicalJobRead.ts:94-95`，`uiStatus.ts:50-61`）；会话引用归档职位 → 整轮 `CONVERSATION_ARCHIVED_CONTENT`（§2.4）；归档会话 → `CONVERSATION_ARCHIVED`。
- 模式：受限模式（`LEGACY_ONLY`/`AB_READY_DISABLED`/`BLOCKED`/非 full scope）下 `assertFullAbWritable`/`assertMatchSurfaceEnabled` 全部失败关闭（`capabilities.ts:130-148`；`matchAnalysis.actions.ts:32-40`）。`MatchAnalysisService` 读同样被 `assertFullAbWritable` 拦。
- 模型分配：`resolveBusinessAIConfig`（`assignments.ts:213-280`）顺序 `MATCH_ANALYSIS assignment → GLOBAL_DEFAULT → NOT_CONFIGURED`；`classifyAssignment`（`:123-202`）显式失效→`INVALID_ASSIGNMENT`（`ASSIGNED_CONNECTION_UNAVAILABLE/REAUTH_REQUIRED/CONNECTION_DISCONNECTED/CONNECTION_ERROR/RUNTIME_NOT_AVAILABLE/UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION/MODEL_UNAVAILABLE`），**不回退**到全局默认或 legacy 路径（`src/lib/ai/structured-execution.ts:156-171`）。
- 执行失败语义：`executeStructuredForAssignment` 已支持 `timeoutMs`/`signal` 参数（`src/lib/ai/structured-execution.ts:54-55`）但 **`runFastScreening` 目前不透传**——canonical 运行当前不可被取消、无显式超时预算；`FAILED` 结果带 `code+issueSummary`（字段路径级摘要，不含原始模型输出，`:94-101`）。
- Managed 侧：`managedResource`+`operationId` 构成持久操作身份；`INVOCATION_*` 状态码已在 `mapAgentError`（`errors.ts:108-114`）与面板 `CONNECTION_CODES` 桶中定义。

### 3.6 未交付项边界【源码事实】

- Deep Match：`MATCH_ANALYSIS_TYPE.DEEP_MATCH` 常量、`DeepMatchDetail` 模型（`schema.prisma:1747-1764`）、`createDeepMatch`/`linkMatchEvidence` 方法存在但**零调用方**；`MATCH_STALE_REASON.RESUME_VERSION_CHANGED`（`identities.ts:190`）已定义未被 FAST_SCREENING 使用。→ 合同不引用、不外推。
- Legacy `Job.matchData`（`schema.prisma:458-459`）与 legacy automation/discovered-job matcher（`actions/automation/analyze.ts` 等）写旧表旧字段——与 canonical `MatchAnalysis` 无共享历史。
- `MatchAnalysisPanel` 仅在 `freshNativeFull` 渲染：migrated-full 下 match 页签展示的仍是 legacy `MatchDetails`（`JobDetails.tsx:347-361`）→ **在 migrated-full 上由 Agent 写入的 canonical `MatchAnalysis` 将没有任何 UI 展示位**。

## 4. `match_job` 合同提案

### 4.1 工具身份与注册【推荐】

- 名称保持 **`match_job`**（复用注册名、i18n 键、`writeReceipt` 集合、evals 面）。
- 实现**不再复用** `buildMatchJobTool` 的 Legacy 逻辑；新建 canonical 构建器（建议 `buildCanonicalMatchJobTool` 或同函数内 `canonical` 分支，参照 `add_job` 的 `canonical` 旗标先例，`tools/index.ts:44`）。
- 注册范围：`ctx.freshNativeFull` 时注册 canonical `match_job`（与 `MatchAnalysisPanel` 可见位完全一致）；`!freshNativeFull`（含 migrated-full 与 LEGACY_ONLY）保持现状——即 `match_job` 仍为 Legacy 实现。**推荐值**：只在 `freshNativeFull` 接通 canonical，migrated-full 不动（其 match 页签仍显示 legacy `matchData`，写 canonical 行会“看不见”，见 §3.5 末条）。
- 提示词：`AGENT_CHAT_FRESH_FULL_SECTIONS.capabilities` 五→六能力并加入 canonical 语义（verdict/reasons，写入 match history，非分数）；`limitations` 移除 “run a match analysis” 但保留 “不投递、不改简历、不做 Deep Match、不写 cover letter”；`FRESH_FULL_PAGE_CONTEXT_MESSAGES.job` 可重新点名 `match_job`；`AGENT_TOOL_DESCRIPTIONS.match_job` 需 canonical 变体（参照 `add_job`/`add_job_canonical` 双描述先例，`prompt.ts:86-88`）。evals（`evals/agent-chat/tools.ts:57-63`）随常量自动跟随。

### 4.2 输入 Schema【推荐】

```ts
// 与 AgentMatchJobSchema 同形——无职位字段、无版本 id 字段。
z.object({
  resumeTitle: z.string().optional(), // 用户口中的简历名；服务端解析为 variant→submittable version
})
```

- `jobId`：**不接受**模型输入。目标职位 = 会话持久化上下文 `kind:"job"` 项的 `entityId`（即“当前职位页/钉住职位”），执行时以 `userId` 归属复核。理由：① `AgentMatchJobSchema` 先例（`agent.schema.ts:85-90`）；② 写入+AI 消耗应绑定用户正在看的对象；③ `get_job` 的可选 `jobId` 先例属于**只读**面。无上下文职位 → `no_job`。
- `resumeTitle`：可选；具名→resume-version 源；缺省→`career-profile` 源（面板默认值一致）。**不给模型 `resumeVariantId`/`versionId`/`source` 枚举**——版本由服务端按 §4.3 规则解析，满足 P1“可追溯的简历版本输入”：解析出的 `versionId` 最终落入 `FastScreeningDetail.inputSnapshot`。
- `userId`/`pageJobId`/会话对象：闭包注入（现状不变）。

### 4.3 服务端解析顺序【推荐】

1. `requireOwnedOpportunity(userId, pageJobId)`：缺失/跨用户 → `no_job`；`archivedAt!==null` → `unavailable{code:"OPPORTUNITY_ARCHIVED"}`（**执行前检查**，避免 §3.5 的“先写 parse+烧 AI 再失败”缺陷）。
2. 若 `resumeTitle` 非空：按 `selectAbResume` 语义对 `listAbResumeChoices`（或等价非归档 variant 列表）做 exact→substring 匹配；
   - 零命中 → `needs_selection{resumes:[{id,title}]}`（沿用现有返回形状）；
   - 命中 variant → 取其 `currentVersionId` 对应版本，若不在 `{DRAFT,FROZEN,SUBMITTED}` 则取该 variant 最新 submittable 版本（与 `listSubmittableVersions` 过滤集一致）；无可递交版本 → `unavailable{code:"VERSION_NOT_SUBMITTABLE"}`（新增码）——见已批准 D5。
   - source = `{kind:"resume-version", versionId}`。
3. 若 `resumeTitle` 为空：source = `{kind:"career-profile"}`。
4. 调 `runFastScreening`（§4.4）；其 `MATCH_JD_MISSING`/`MATCH_INSUFFICIENT_MATERIAL` 等 `failed` 码原样透传为结果码。

### 4.4 执行路径与复用边界【推荐】

- **复用点为 `runFastScreening`（lib 入口），非 Server Action、非 `MatchAnalysisPanel` 逻辑**：同一 JD 快照、同一素材/偏好快照、同一 `executeStructuredForAssignment` 链路、同一 `MatchAnalysisService` 持久化+stale 标记、同一 `MatchAnalysisListItem` DTO 出口。禁止复制 prompt/schema/持久化另起平行实现。
- **模型分配**：走 `MATCH_ANALYSIS` 业务分配（与面板完全一致），**不复用会话 `CAREER_DIALOGUE` 锁**——`MatchAnalysis` 行的 provider/model/`resolvedConnectionId`/`managedAiProvenance` 才能正确落账（§2.4 末条、§3.5 模型条）。推论：
  - 该工具**不经过 `runNestedGeneration`**——无 token 级流式（结构化 one-shot），`data-nested-stream` 不产生；UI 呈现为“运行中 → 结果卡”。`AGENT_NESTED_TOOLS` 中的 `match_job` 成员资格需随实现再确认（无瞬态流语义），`AGENT_CHAT_TERMINAL_TOOLS` 保留（终轮语义不变）。
  - 并发：`nestedGuard` 语义需在 canonical 侧等价保留（同一步内 review_resume+match_job 两个 180s 调用会串行爆 300s 回合预算）——实现细节，合同要求“同一回合至多一个重型 AI 子调用并发”。
- **运行身份与持久化幂等**：不能直接由客户端 `requestId` 或模型 `toolCallId` 计算恢复身份——客户端重试和重新生成工具调用时二者都可能变化。Agent 路径必须在发起 AI 前，以服务器已持久化的原始会话轮次身份（例如 originating user-message id / admitted turn revision）+ `toolName` + canonical input hash，在短事务中创建或取得一条 durable tool-execution reservation；该记录持有服务器生成且唯一的 `operationKey`、状态和最终 `analysisId`。`operationKey` 同时用于 `operationId`/`managedResource.resourceKey` 和 canonical 分析持久化；`MatchAnalysis` 通过唯一外键/唯一操作身份与该执行记录绑定。崩溃恢复先按原始持久轮次查找 `PENDING/COMPLETED` 执行记录：已完成则返回同一 `MatchAnalysis`，未完成则用同一 `operationKey` 恢复，不得创建第二行。不同显式用户轮次使用不同 reservation，仍各自产生新历史。不能只依赖 Managed `INVOCATION_REPLAYED`，因为它只防重复调用/计费，不能单独防止重复数据库写入。若现有会话模型无法在免审批路径提供稳定、可恢复的原始轮次身份，则 D3 必须选择“需要审批”，并在审批持久化时预留执行记录；不能同时宣称免审批和崩溃幂等。面板保留现有随机 `runId` 语义。
- **超时与取消**：合同要求把 `signal`（= 工具 `execute` 的 `abortSignal`，即 `turnSignal`）与 `timeoutMs` 透传进 `executeStructuredForAssignment`（其已支持两参，`src/lib/ai/structured-execution.ts:54-55`）；推荐 `timeoutMs = AI_JOB_MATCH_TIMEOUT_MS`（180s，legacy match 同预算），上限受 300s 回合预算自然约束。取消/超时→`failed{code}`，不持久化。
- **版本校验补强**：`getVersion` 不查 archived/status（§3.4/3.5）→ 工具必须在 §4.3-2 以 submittable 集过滤后**再校验**解析出的 `versionId`（variant 未归档 ∧ status∈`{DRAFT,FROZEN,SUBMITTED}`），不允许任何路径跑 ARCHIVED 版本或归档 variant。

### 4.5 写入语义、历史与 stale【推荐】

- **允许写 canonical `MatchAnalysis` 历史**（非只读预览）。理由：匹配的产品价值=持久 verdict+历史+stale 追踪；`MatchAnalysis` 为 append-only（无覆盖语义），与 `Job.matchData` 覆盖写本质不同。
- 每次确认的显式用户请求 = 一次运行 = 一条 `COMPLETED` 行（与面板每次点击一致）；`markSupersededAnalysesStale` 按输入差异自动打标，无需工具额外动作。
- 历史读取**不进入本工具合同**：结果只携带本次 `analysis`；完整历史留在职位页 `MatchAnalysisPanel`（复用边界 §4.9）。结果可附 `historyCount`（可选字段）——若实现需 `listAnalysesForOpportunity` 计数，成本一次查询；推荐保留为可选。
- `FastScreeningDetail.inputSnapshot` 含完整素材/偏好文本——**结果中永不回传**（见 §4.7 输出）。

### 4.6 确认策略（needsApproval）【已批准 D3】

- **推荐：`needsApproval` 恒真**（canonical 路径）。依据：
  - `add_job` 先例——“the gate exists to stop writes the user has not seen”（`tools/getResume.ts:20-21` 注释语义）；canonical 运行无 token 流可“看着落地”，Legacy `match_job`/`review_resume` 免确认的理由（`tools/matchJob.ts:48-49`）不成立。
  - 该调用消耗 `MATCH_ANALYSIS` 分配额度（可能是 Managed 计费），用户应有一次显式确认。
  - 确认卡在用户看到“将对当前职位跑筛选分析”的意图后才执行。
- 备选（待决定）：无 approval，沿用嵌套工具“只写自己数据”先例——但需承认“无流可看”与“跨分配消耗”两点差异。
- 实现注意：`conversationRequest.ts:139` 的 approval 续跑校验硬编码 `receipt.toolName === "add_job"`——`match_job` 接入 approval 需同例放行（实现项，非产品决定）。

### 4.7 输出 Schema 与前端呈现【推荐】

`AgentMatchJobResult` canonical 判别联合（与现有形状平行，新增项）：

```ts
| { status: "ok";
    analysisId: string;                 // MatchAnalysis.id —— 持久句柄
    jobId: string;                      // JobOpportunity id
    jobTitle: string | null;
    company: string | null;
    source:
      | { kind: "career-profile" }
      | { kind: "resume-version"; variantId: string; resumeTitle: string;
          versionId: string; versionNumber: number };
    verdict: "PASS" | "BORDERLINE" | "FAIL";
    reasons: string | null;
    hardRequirements: string | null;
    coreMatch: string | null;
    preferenceMatch: string | null;
    provider: string | null;
    model: string | null;
    completedAt: string | null;
    saved: true;                        // 兼容 writeReceipt：阻断 regenerate
    historyCount?: number;              // 可选：该机会下 FAST_SCREENING 历史条数
  }
| { status: "no_job" }
| { status: "needs_selection"; resumes: { id: string; title: string }[] }
| { status: "no_resumes" }
| { status: "unavailable"; code: string; reason: string }   // 模式门/归档/NOT_CONFIGURED/分配失效/版本不可用
| { status: "failed"; code: string; detail?: string | null } // MATCH_JD_MISSING/INSUFFICIENT_MATERIAL/执行失败码
```

- **不回传**：简历/JD 原文、`inputSnapshot`（含素材全文）、`resolvedConnectionId`/`managedAiProvenance`（内部溯源）、`errorCode` 之外的原始执行细节——与“结果卡只渲染确定性字段”（`agent.model.ts:211-215`）及 `mapAgentError` 不泄内部信息（`errors.ts:18-19`）一致。
- 前端：新增 canonical `MatchJobResult` 分支/组件——verdict 徽标+四段正文+provider/model+“已存入 Match 历史（职位页可见）”+失败码映射复用 `matchAnalysis.errors.*` 与 `verdictVariant`/`verdictLabel`（`MatchAnalysisPanel.tsx:43-138`）；不再渲染 markdown body/分数环。
- `saved:true` 维持 `writeReceipt` 阻断 regenerate 语义；`saved` 恒真（持久化在 `ok` 路径内原子完成，无 panel 之外的“保存失败”尾态——`saveError` 字段不再需要）。

### 4.8 失败语义映射表【推荐】

| 场景 | 结果 |
|---|---|
| 无上下文职位 / 跨用户 / 不存在 | `no_job` |
| 职位已归档 | `unavailable{OPPORTUNITY_ARCHIVED}`（执行前检查；并受 `CONVERSATION_ARCHIVED_CONTENT` 上游兜底） |
| 受限运行时（非 AB_ENABLED+full） | `unavailable{AB_WRITES_NOT_ENABLED\|MATCH_UNAVAILABLE}`（`CareerRuntimeError`→码透传，不抛出整轮） |
| 无 JD / 素材+偏好双空 | `failed{MATCH_JD_MISSING\|MATCH_INSUFFICIENT_MATERIAL}` |
| 未配置 MATCH_ANALYSIS | `unavailable{NOT_CONFIGURED}` |
| 显式分配失效 | `unavailable{INVALID code}`（`ASSIGNED_CONNECTION_UNAVAILABLE` 等） |
| 连接/运行时/额度/结构化执行失败 | `failed{code, detail?}`（复用面板 CONNECTION/QUOTA/STRUCTURED 分桶） |
| 取消/超时 | `failed{AI_EXECUTION_TIMEOUT}` |
| 用户拒绝 approval | AI SDK `output-denied` 状态由结果卡渲染“已取消”（现有机制） |
| 版本不可递交（归档 variant/ARCHIVED 版本） | `unavailable{VERSION_NOT_SUBMITTABLE}`（新码）——已批准 D5 |

### 4.9 与职位详情 FAST_SCREENING 的复用边界【推荐】

- **共享**：`runFastScreening` 单入口（含 schema、prompt、`MATCH_ANALYSIS` 解析、`MatchAnalysisService` 持久化、stale 规则、`MatchAnalysisListItem` 出口）。
- **差异（仅限本工具）**：输入由服务端解析（无选择器）；可选 `operationKey`/`signal`/`timeoutMs` 注入；结果映射为 Agent 判别联合；确认卡前置。
- **不在本合同**：面板增加“由 Agent 触发”标记（`MatchAnalysis` 无 surface 列，快照即溯源——面板 run 与 agent run 同形同行，推荐不加列）；在对话内浏览历史（结果只带本次+可选 historyCount）。

## 5. 实施约束清单（合同级、非 Owner 决定）

1. `runFastScreening` 需增可选 `{signal, timeoutMs, operationKey}`（当前签名 `db,userId,input,deps,env`；面板调用方零改动）；`operationKey` 由 AI 调用前已经持久化的 tool-execution reservation 提供，在 Agent 路径必须进入带唯一约束的 durable persistence identity，并在重放时返回既有分析，不能只用于 Managed 计费调用。
2. 执行前 `archivedAt` 预检（`runFastScreening` 现仅在持久化期抛 `OPPORTUNITY_ARCHIVED`，会先写 parse+消耗 AI，§3.5）。
3. 版本 submittable 校验在工具侧补齐（`getVersion` 不查 archived/status，§3.4）。
4. `conversationRequest.ts:139` approval 续跑硬编码 `add_job` 需泛化到 `match_job`。
5. `conversationRequest.ts` receipt 输入为 `toolName+toolCallId+input` 精确匹配——canonical 结果中 `input` 仅含 `resumeTitle`（无 id 泄漏）。
6. `buildAgentTools` 的 `freshNativeFull` 分支由“删 `match_job`”改为“注册 canonical `match_job`”；`canonicalJobs` 旗标语义不变。
7. `AGENT_CHAT_FRESH_FULL_SECTIONS`/`FRESH_FULL_PAGE_CONTEXT_MESSAGES`/`AGENT_TOOL_DESCRIPTIONS.match_job` 文案同步（`prompt.ts`）；`MatchJobResult` 结果卡分支。
8. `runNestedGeneration`/`nestedGuard` 等价并发保护在 canonical 侧落实；`AGENT_NESTED_TOOLS` 成员资格按是否保留瞬态流决定。
9. 测试基线更新面：`agentFreshFullTools.spec.ts`（工具清单与 prompt 断言）、`evals/agent-chat/tools.ts` 描述随常量。
10. 会话上下文引用归档职位时整轮拒绝（`hasArchivedJobReference`）——工具无需重复实现，但失败呈现依赖该上游码。
11. conversation receipt 与 `MatchAnalysis` 无法跨 AI 调用放进同一长事务；必须在 AI 前以持久化原始轮次身份预留 tool-execution 记录，再通过其稳定 `operationKey` + 唯一约束关闭“分析已写、receipt 未写”的崩溃窗口。完成时执行记录与 `analysisId` 同事务关联；唯一冲突时读取并返回既有完成结果；同 Key 不同输入视为 turn conflict。客户端新 `requestId` 或模型新 `toolCallId` 不是恢复身份。

## 6. Owner 决策记录（D1–D6 已批准，2026-10-31 同步）

Owner 已批准下表全部推荐；备选项仅保留为历史上下文，不是未决选项。D1 仅 freshNativeFull；D2 仅会话上下文职位，无 jobId；D3 needsApproval 恒真；D4 缺省 career-profile；D5 VERSION_NOT_SUBMITTABLE；D6 每次显式请求新分析行，同一执行的崩溃恢复仍须幂等。

仅冻结产品决定，未授权 match_job 编码。AI 前 durable reservation、stable operationKey 和分析唯一绑定的具体持久化设计仍待实施合同；当前 MatchAnalysis 没有 operationKey 唯一列或外键，不得假定现有结构已满足。

| # | 问题 | 推荐 | 备选 |
|---|---|---|---|
| D1 | **注册范围**：canonical `match_job` 在哪类运行时开放？ | 仅 `freshNativeFull`（与 `MatchAnalysisPanel` 可见位一致；migrated-full 继续 Legacy，其 UI 无 canonical 历史位） | 全部 `canonicalJobs`（migrated-full 也写 canonical 行，但当前 UI 不展示） |
| D2 | **职位输入**：是否保持“仅会话上下文职位”？ | 保持（无 `jobId` 入参，IDOR 边界与现状一致） | 允许可选 `jobId`（须 `list_jobs` 返回过的 id，服务端归属复核）——扩大“对非当前页职位跑分析”的能力 |
| D3 | **确认**：canonical `match_job` 是否需要 `needsApproval`？ | 需要（恒真）：持久行+跨分配 AI 消耗+无流可看；若免审批路径不能提供 AI 前持久化且可恢复的原始轮次身份，本推荐也是幂等合同的强制条件 | 不需要：仅在先实现 durable tool-execution reservation、可跨新 request/toolCall 找回同一执行身份时可选，不能只沿用嵌套工具“写自己数据免确认”先例 |
| D4 | **默认素材源**：`resumeTitle` 缺省时用 `career-profile` 还是“绑定职位 variant 优先”？ | `career-profile`（面板默认一致、确定性强） | variant `targetJobOpportunityId===jobId` 优先，再 `career-profile`——“给这个职位专门定制的简历先匹配”语义，但可能意外选中草稿版本 |
| D5 | **不可递交版本**：具名 variant 没有任何 `{DRAFT,FROZEN,SUBMITTED}` 版本时 | `unavailable{VERSION_NOT_SUBMITTABLE}`（显式新码，理由清晰） | `needs_selection`（并入候选列表语义） |
| D6 | **不同显式请求的同输入去重**：连续两次用户请求是否短路返回既有最新行？（不含同一 durable tool-execution reservation / originating persisted turn 的崩溃恢复；后者即使产生新的 requestId/toolCallId，也必须按 §4.4 幂等返回同一行） | 不短路：每次显式请求=新行（面板一致，历史如实） | 相同 `inputHash` 且存在非 stale 行 → 返回该行并标 `reused:true`（省配额，但与面板语义分叉） |

## 7. 速查表：事实 / 推荐 / 待决定

- 【源码事实】七工具构造、fresh-native 删二、五项开放工具契约、Legacy `match_job` 全链（legacy Job/Resume、`Job.matchData` 覆盖、无 approval、checkpoint 幂等、terminal）、canonical `FAST_SCREENING` 十步链、`MatchAnalysisService` 全方法 `assertFullAbWritable` 门+归属/归档/stale、Resume Variant/Version 结构化与绑定、`MATCH_ANALYSIS` 分配解析顺序、面板=唯一 canonical UI（仅 freshNativeFull）。
- 【推荐】工具名 `match_job` 保留；canonical 实现仅挂 `freshNativeFull`；输入仅 `resumeTitle?`；服务端解析职位（上下文）与版本（具名→submittable）；复用 `runFastScreening`+`operationKey/signal/timeoutMs` 注入；写 `MatchAnalysis` 历史；结果判别联合含 `verdict`+四段+provenance+`saved:true`；确认卡前置（D3）；幂等=AI 前按持久化原始轮次预留 durable tool-execution、稳定 operationKey 与分析唯一绑定、receipt 重放返回同一行，不同显式请求按 D6 决定是否复用。
- 【已批准】D1–D6 全部采用 §6 推荐；【实施待定】durable reservation 与分析唯一绑定的持久化结构。未授权编码，工具未开放。
