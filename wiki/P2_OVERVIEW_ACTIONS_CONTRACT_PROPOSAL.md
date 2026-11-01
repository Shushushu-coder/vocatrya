# JOURNEY-OVERVIEW / NEXT-ACTIONS 实施合同提案（P2 首页与下一步建议）

- 基线：`main @ 23178a4c`（2026-11-01 逐条源码复核刷新；前版基线 `96e896e3` 2026-10-31、首版 `39a5a1d3` 2026-10-29）
- 状态：**已冻结（2026-11-01 Owner 裁定 §9 D1–D9，结果与附随子项见 §10 冻结记录）**。【推荐方案】已按裁定生效；本文件不授权代码修改、Schema/Migration、提交、合并、部署或真实数据操作——实施仍须各自任务授权。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行）；**【推荐方案】**＝本合同建议（已于 2026-11-01 经 Owner 裁定生效，见 §10）；**【待决定】**＝裁定前的待决标记（均已裁定）。
- 上游依据：`wiki/P2_IMPLEMENTATION.md`（P2 产品设计基线，已确认原则）与 `wiki/P2_FEATURES.json`；归档语义遵循已冻结的 `ARCHIVE_CONTRACT_PROPOSAL.md`；日期/时区语义遵循已冻结的 `DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`；`match_job` 状态依据 `wiki/P1_FEATURES.json` AGENT-CAPABILITIES 台账——canonical 实现已集成并有 Windows Electron 真实 AI 验收记录（见 §1.5）。
- **跨合同项（已裁定）**：「面试已结束、待复盘」统一谓词见 §9 D3。本合同已按协调建议与 [`P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md`](./P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md) §13 D6 对齐——**协调建议：仅 `status === "COMPLETED"` 计入待复盘；排期已过但未完成不计入，仅提示确认状态。该协调建议已于 2026-11-01 与面试合同 §13 D6 同次裁定生效（含 EVIDENCED 与终态 Attempt 附随子项，见 §10）。**

## 0. 范围与边界

本合同覆盖 P2 六个 Feature 中的两项首页耦合部分：

- **JOURNEY-OVERVIEW**：`/dashboard` 一张可滚动 Overview 页的区块组织、三阶段（准备/行动/复盘）入口映射、新用户与已有数据用户状态、窄窗口表现。
- **NEXT-ACTIONS**：由真实业务数据确定性规则计算的"下一步建议"区，包括触发条件、优先级、去重、上限、空态与跳转目标。

**不在本合同范围**：MULTI-AGENT 的三角色人格/面板改造（本合同只定义首页 Agent 入口槽位与衔接接口，见 §6）；CAREER-INSIGHTS 的指标口径冻结（本合同只复用现有计数）；JOB-CONNECTIONS 与 INTERVIEW-DEBRIEF 的 Schema 级数据合同（首页只按 §4.7 最小读取契约消费复盘领域谓词）；任何新 Agent 工具、后台 AI 调用、自动建任务、Activity 计时类能力。

**产品边界（与 P2 基线一致，不再开放讨论）**：三阶段可自由进入，不做强制线性向导；建议由真实业务规则计算，不调用 LLM、不自动创建任务、不自动投递、不自动执行 Agent；不重造 P1 简历工作台和三条 AI Provider 基础设施；不引入 Activity 计时或类似效率打卡。

## 1. 源码事实总览

### 1.1 首页现状【源码事实】

- `/` 路由 `src/app/page.tsx:5-18`：已登录重定向 `/dashboard`；无用户 → `/signup`，有用户未登录 → `/signin`。
- 首页 `src/app/dashboard/page.tsx:18-42`：服务端组件，单列网格（`max-w-[1400px]`，`auto-rows-max gap-4`），自上而下渲染三块：
  1. `OverviewMetrics`（进行中职位、近 7 天投递、未完成待办三张计数卡，`src/components/dashboard/OverviewMetrics.tsx:11-55`）；
  2. `OverviewReminders`（条件渲染，无到期项时整块不渲染，`OverviewReminders.tsx:26`）；
  3. `dataState === "empty" ? <GettingStarted/> : <RecentUpdates/>`（`page.tsx:35-39`）。
- `getOverviewStats`（`src/actions/dashboard/overview.ts:38-65`）：`inProgress`＝非终态 uiStatus 职位数，`applied7d`＝窗口内首次投递职位数，`openTasks`＝status 不在 `["complete","cancelled"]` 的 Task 数（排除集 `OPEN_TASK_STATUSES`，`overview.ts:36`）。jobs 读家族 blocked 时只返回 openTasks，卡片显示 "—"（`OverviewMetrics.tsx:18-31,46`）。
- `getOverviewDataState`（`overview.ts:84-102`）：`tasks>0 || 用户自建题目>0 || InterviewSession>0` → `nonempty`；否则按 `loadJobsExistence`（**含归档行**，`jobsReadDispatch.ts:733-744`）判空；家族 blocked → `unknown` → 渲染正常工作台而非新手引导（`page.tsx:32-34` 注释明确该降级语义）。
  - **注意**：判定域目前只覆盖职位、任务、题目、面试练习会话；**不含** CareerMaterialItem、ResumeVariant、AIConnection、ChatConversation。fresh-native 用户只建过简历素材时仍被当 `empty`。
- `getOverviewReminders`（`overview.ts:139-243`）：`REMINDER_LIMIT=6`（`overview.ts:124`）；来源为 ≤7 天到期 Task（dueDate 或 dueOn，排除 complete/cancelled）+ AB 家族 `listUpcomingApplicationEvents` 或 legacy `Job.dueDate`；`dateOn` 标记 DateOnly 事实按日历日渲染（`overview.ts:104-117,186,212-218`）；整体排序 `at` 后截取 6 条；blocked 家族下只有 Task 提醒。
- `getRecentJobs`（`src/actions/dashboard/recent.ts:7-20` → `jobsReadDispatch.ts:598-629`）：仅**已投递**职位，AB 按 `firstSubmittedAtDesc`、legacy 按 `appliedDate desc`，`APP_CONSTANTS.RECENT_NUM_JOBS=10`（`constants.ts:29`），组件截 5 行（`RecentUpdates.tsx:10`）。

### 1.2 导航与可达入口【源码事实】

- 侧边栏 `SIDEBAR_LINKS`（`src/lib/constants.ts:350-397`）：概览 `/dashboard`、数据看板 `/dashboard/analytics`、我的职位 `/dashboard/myjobs`、自动化巡检 `/dashboard/automations`（fresh-native-full 下隐藏，`freshSurfacePolicy.ts:44-50` + `Sidebar.tsx:174-176`）、待办任务 `/dashboard/tasks`、面试题库 `/dashboard/questions`、面试练习 `/dashboard/interview`、网申资料 `/dashboard/profile`、开发者选项（devOnly，`constants.ts:392-395`，仅 NODE_ENV=development 渲染）；底部设置 `/dashboard/settings`。全部路由段存在于 `src/app/dashboard/`。2026-11-01 复核：主框架的 SupportDialog/「About & Help」面已在 `48e9ba40` 移除，`SIDEBAR_LINKS` 业务导航未变。
- 窄窗口：`<sm` 时 Sidebar 隐藏（`Sidebar.tsx:126` `hidden … sm:flex`），Header 内 Sheet 提供同等导航（`Header.tsx:44-86`，同样应用 freshNativeFull 过滤 `Header.tsx:68-70`）。
- 全局创建菜单 `CreateMenu`（`src/components/GlobalActions.tsx:17-21`）：`/dashboard/myjobs?add-job=true`、`/dashboard/tasks?add-task=true`、`/dashboard/questions?add-question=true`；三个深链分别由 `useQueryDialog("add-job")`（`AddJob.tsx:123`）、`useQueryDialog("add-task")`（`useAutoOpenAddTaskDialog.ts:9`）、`useQueryDialog("add-question")`（`QuestionsContainer.tsx:47`）消费。
- 空账号 `GettingStarted`（`src/components/dashboard/GettingStarted.tsx:20-42`）有 **3 条**入口：job→`?add-job=true`、task→`?add-task=true`、question→`/dashboard/questions`（**不带** `?add-question` 参数，与 CreateMenu 略异；源码注释写 four entries 是过时注释）。`jobMutationsEnabled=false` 时过滤 job 入口（`GettingStarted.tsx:62-64`，与 `GlobalActions.tsx:65-67` 同模式）。
- 深链参数现状：`?tab=`（`src/hooks/useTabQueryParam.ts:9`，无效值回退默认 tab）——myjobs 页 `?tab=jobs|upcoming`（`src/components/myjobs/MyJobsPageTabs.tsx:19,39-42`，upcoming Tab 仅在 AB 读模式下存在，`MyJobsPageTabs.tsx:35-46`）；职位详情 `?tab=` 三组候选——legacy `description|match|letter|notes|contacts`（无 timeline）、AB 加 `timeline`、fresh-native-full 再去 `letter|contacts`（`src/components/myjobs/JobDetails.tsx:57-80,147-150`，无效 tab 回退 description）；设置页 `?section=` 或 `#`（`settings/page.tsx:84-90`），AI 相关 section 为 `ai-services`/`ai-assignments`（`settings/page.tsx:169-188`），归档中心为 `archive-data`（`settings/page.tsx:252-258`），`resume-variants` section 渲染同一 `ResumeVariantList`（`settings/page.tsx:231-236`）；**新增** `subscription` section（`settings/page.tsx:197-203`，ManagedRechargeCard）。
- 简历相关路由：`/dashboard/profile`＝职业素材工作台 `ApplicationProfileWorkspace` + legacy 文档卡（fresh 下隐藏 legacy 卡，`profile/page.tsx:33-50`；工作台需 resumeV1 能力，`profile/page.tsx:25-28`）；`/dashboard/profile/application`＝职业素材工作台独立路由（同样 resumeV1 门控，`profile/application/page.tsx:19-30`）；`/dashboard/profile/resumes`＝简历版本列表（`resumes/page.tsx:16-36`，resumeV1 门控）；`/dashboard/profile/resumes/[variantId]`＝版本工作台；`/dashboard/profile/resume/[id]`＝legacy 编辑器。

### 1.3 数据读模型与家族分发【源码事实】

- `resolveJobsReadFamily`（`jobsReadDispatch.ts:182-201`）→ `ab | legacy | blocked`；`ab` 判定＝`isAbJobReadMode`＝AB_READY_DISABLED 或 AB_ENABLED+full（`jobsReadCapabilities.ts:9-15`）；fresh 起源无 AB 读 → blocked。dashboard 统一经 `jobsReadOrBlocked` 包装成类型化 blocked 结果而非伪造 0（`actions/dashboard/shared.ts:43-58`）。新装桌面用户（fresh-native full）走 `ab`。
- `loadJobsBoardTotals`（`jobsReadDispatch.ts:649-725`）：AB 口径——未归档 JobOpportunity 全量派生 uiStatus；`applied`＝存在**未归档**已投递 Attempt（`OPPORTUNITY_DERIVE_SELECT` 过滤 `archivedAt:null`，`jobsReadDispatch.ts:90-104`）；`interviews`＝未归档 Attempt 且父机会未归档下 category=INTERVIEW 的 ProcessStep 计数；`inProgress`＝非终态 uiStatus（终态集 `archived|expired|rejected|offer-accepted|offer-declined|transferred`，`jobsReadDispatch.ts:75-82`）；`offers`＝offer 系 uiStatus。
- `loadDashboardJobCounts`（`jobsReadDispatch.ts:458-538`）：AB 按 `jobOpportunityId` 分组取 `MIN(submittedAt)` 做窗口内"首次投递职位数"去重。
- `attemptInRangeWhere`（`jobsReadDispatch.ts:439-456`）：只排除 **Attempt 自身** `archivedAt`，**不排除父机会归档**——注释明确"已归档机会下的投递仍是发生过的事实"，与冻结归档合同"保留历史投递事实"一致。
- `listUpcomingApplicationEvents`（`upcomingReadModel.ts:170-336`）：两类事件——① 机会投递截止（status 限 ACTIVE/UNKNOWN、未归档、deadline/deadlineOn 非空、**无已投递 Attempt**）；② 流程步骤（status 不在 COMPLETED/CANCELLED、completedAt 空、有 scheduled 或 deadline、Attempt outcome ∈ {ACTIVE,OFFER}、Attempt 与父机会均未归档）。`attentionAt`＝scheduled 与 deadline-attention 的较早者；事件携带 `category`（`upcomingReadModel.ts:306`）与 `jobOpportunityId`（`:301`）；信封携带账户时区；`bucketUpcomingApplicationEvents`（`upcomingReadModel.ts:114-152`）按账户时区分 overdue/today/next7/later。**推论**：COMPLETED 步天然不出现在 upcoming 事件中——「已结束」与「即将发生」两域按构造互斥。
- 账户时区：`getUserTimeZone`（`src/lib/userSettings/timeZone.server.ts:19-25`）读 `UserSettings.settings.general.timeZone`（`timeZone.ts:76-79`），缺失回退运行时区；业务时间 DateOnly/Instant/精度语义按已冻结 DateTime 合同执行（`businessTimeAttentionIso` 令 DateOnly 当天即视为到期，`isDeadlineOverdue` 次日才逾期）。

### 1.4 关键实体与已有业务关系【源码事实】

- `JobOpportunity`（`schema.prisma:771-831`）：`archivedAt`、`deadline/deadlineOn/deadlinePrecision`、`status UNKNOWN|ACTIVE|CLOSED|EXPIRED`、`currentJdVersionId`；关联 `applicationAttempts`、`targetedResumeVariants`、`interviewSessions`。
- `ApplicationAttempt`（`schema.prisma:913-952`）：`submittedAt`、`currentStageCategory`（默认 DRAFT）、`outcome`（ACTIVE/WITHDRAWN/REJECTED/OFFER/HIRED/TRANSFERRED）、`submittedResumeVersionId / submittedResumeArtifactId / submittedAgainstJdVersionId`（`schema.prisma:928-930`；首次绑定后不可变，`applicationService.ts:179-193`）、`archivedAt`（字段存在，当前无独立写路径）。
- "已投递"事实统一为 `APPLIED_ATTEMPT_WHERE`（`applicationFact.ts:34-40`）：未归档且（submittedAt 非空 或 stage≠DRAFT）。
- `ApplicationProcessStep`（`schema.prisma:954-985`）：category ∈ {SCREENING,ASSESSMENT,INTERVIEW,OFFER,ONBOARDING,OTHER}（`identities.ts:117-124`），status ∈ {PENDING,IN_PROGRESS,COMPLETED,CANCELLED}（`identities.ts:97-102`）；scheduledAt/deadlineAt 带精度与时区 sidecar，completedAt 只有 `completedAtPrecision`（`schema.prisma:962-970`，无 zone）。`[待核实]` 迁移可能产生 `status="EVIDENCED"` 值（不在常量集内，见面试合同 A8）。
- **真实面试复盘存储已存在**：`ApplicationInterviewDetail`（1:1 挂 INTERVIEW 步，`schema.prisma:1040-1056`）持有 `reflectionText` 与 `reflectionItems`（`ApplicationInterviewReflectionItem`：questionText+answerNotes+sortOrder，`schema.prisma:1063-1075`）。**Schema 缺口**：`reflectionCompletedAt` 显式完成标记与 `ReflectionItem.sourceQuestionId/sourceKind` 尚不存在——它们是面试合同 D2/D4 的待定增量，若批准显式完成标记，R6 必须等待复盘领域读取接口落地（§4.7），不得用内容存在性替代完成标记。服务层 `getInterviewReflection`/`saveInterviewReflection`（`applicationService.ts:598-723`）强制 INTERVIEW 类别校验；**写复盘要求 AB_ENABLED+full**（`saveInterviewReflection` → `gate()` → `assertFullAbWritable`，`applicationService.ts:80-81,629`、`capabilities.ts:130-148`）；空保存（无 text 无 items）在 detail 不存在时早退不落库（`applicationService.ts:642-644`）。UI 入口为职位详情 timeline Tab 内 INTERVIEW 行的"复盘"按钮（`src/components/myjobs/job-details/ProcessStepsTable.tsx:172-262` → `ApplicationTimelineTab` `InterviewReflectionDialog`）。AI 复盘草稿走 `generateInterviewReflectionDraft`（CAREER_REFLECTION purpose，`src/lib/career/interviewReflectionAi.ts:38`、`src/actions/interviewReflectionAi.actions.ts:46-56`），草稿不自动落库，且仅 `isFullAbReadSurface`（AB_READY_DISABLED 或 full，`interviewReflectionAi.actions.ts:28,56`）可用。
- `ResumeVariant`（`schema.prisma:1501-1519`）：`archivedAt`、`targetJobOpportunityId`（**职位绑定关系已存在且可写**：createVariant 接受，`resumeVariantService.ts:91-132`；`updateTargetJob` 提供事后绑定/解绑写路径并拒绝绑定已归档职位，`resumeVariantService.ts:437-451` + action `resumeVariant.actions.ts:655`；`listVariants`/`getVariant` 返回 `targetJobTitle`，`resumeVariantService.ts:155-186,188-223`；版本工作台已有目标职位下拉 UI，`ResumeVariantWorkspace.tsx:546`）。`ResumeVariantVersion.status` ∈ {DRAFT,FROZEN,SUBMITTED,ARCHIVED}（`schema.prisma:1529`，注释 `schema.prisma:1521-1522`）。简历读家族 `resolveResumeReadFamily`（`resumeReadDispatch.ts:51-70`）：`ab`＝resumeV1 能力（AB_ENABLED + scope∈{resume_v1,full}，`capabilities.ts:26-34`）；fresh 起源无 resumeV1 → blocked；其余 → legacy `Resume`。
- `InterviewSession`（`schema.prisma:1858-1904`）：**模拟/练习会话**，与真实面试不同实体；status ∈ {DRAFT,IN_PROGRESS,COACHING,COMPLETED,ARCHIVED}，可挂 `jobOpportunityId+jobDescriptionVersionId`。新建练习需 INTERVIEW readiness（`interview/page.tsx:29-37,59-80`；`readiness.ts:68-88` 经 `resolveBusinessAIConfig` 解析 INTERVIEW purpose）。
- `Task`（`schema.prisma:491-515`）：status ∈ {in-progress,complete,needs-attention,cancelled}（`task.model.ts:4-9`），dueDate/dueOn/duePrecision。
- `Question`（`schema.prisma:624-652`）：用户题目 `createdBy` + `presetBankKey: null` + `deletedAt: null` 为用户自建口径（`overview.ts:89-91`）。
- `CareerMaterialItem`（`schema.prisma:1120-1157`）：职业素材，`archivedAt`；服务层 `assertResumeV1Writable` 门控（`careerMaterialService.ts:63-64`），即素材与简历版本同属 resume 读家族。
- `AIConnection`/`AIBusinessAssignment`（`schema.prisma:2185-2235`）：connection status ∈ {CONNECTED,REAUTH_REQUIRED,DISCONNECTED,ERROR}（`connections.ts:65-69`）；assignment 按 (userId,purpose) 唯一（`schema.prisma:2233`）。purpose 集合 {GLOBAL_DEFAULT,INTERVIEW,RESUME,MATCH_ANALYSIS,CAREER_REFLECTION,CAREER_DIALOGUE}（`connections.ts:74-82`）。
- AI 解析合同 `resolveBusinessAIConfig`（`src/lib/ai/assignments.ts:213-280`）：purpose 专属 → GLOBAL_DEFAULT → NOT_CONFIGURED；INTERVIEW 额外在 GLOBAL 前插 LEGACY_INTERVIEW_CONFIG；失效的显式分配 → INVALID_ASSIGNMENT（归档/他人/非 CONNECTED/缺 runtime/空 model，`assignments.ts:123-200`），**绝不静默回退**。

### 1.5 Agent 入口现状【源码事实，2026-11-01 复核已刷新】

- 当前只有一个 Agent（"Vocatrya 助手"）。`AgentChatTrigger`（`src/components/AgentChatTrigger.tsx`，挂于 `Header.tsx:94` 与 `TitleBarActions.tsx:35`）→ `useAgentChat().open()`（`AgentChatProvider.tsx:536`）→ 右侧非模态 Sheet 面板，可拖拽宽度/展开/历史/新对话（`AgentChatProvider.tsx:536-541`、`AgentChatPanel.tsx:44-143`）；打开面板会折叠侧边栏并跑 preflight（`AgentChatProvider.tsx:540,948`）。
- 对话上下文 kind 仅 `job|resume`（`conversationContext.ts:5`）；页面自动附加仅限 `/dashboard/myjobs/[id]` 与 `/dashboard/profile/resume(s)/[id]`（`pageContext.ts:6-9`）；`/dashboard` 只携带 route、无实体上下文（`pageContext.ts:13-22`）；归档 canonical 职位对 AI 不可见（`conversationContext.server.ts:31-39`）。
- **现有建议点击即发送**：`AgentChatEmptyState` 的 Suggestion `run: () => send(label)` 直接 `sendMessage`（`src/components/agent/AgentChatEmptyState.tsx:24-32`），`JobDetails.startChat` 同样是"打开+发消息"模式（`JobDetails.tsx:171-179`）。P2 已确认"点击建议只填入输入框"，此差异属 MULTI-AGENT 改造范围，本合同不在首页重造该交互。
- **工具集按运行时分叉（已变）**：`buildAgentTools`（`src/lib/agent/tools/index.ts:18-91`）先构建 **7** 项工具（add_job、list_jobs、get_job、get_resume、review_resume、match_job[Legacy]、generate_cover_letter）；`freshNativeFull` 时用 **canonical `match_job` 替换**并删除 `generate_cover_letter`（`tools/index.ts:81-89`）→ **fresh-native/full 下开放六项**。`canonicalJobs` 标志（canonicalJobs∨freshNativeFull）使 `add_job` 写 canonical JobOpportunity（`tools/index.ts:44-46`）——migrated-full 下 add_job 写 canonical 但 match_job 仍是 Legacy 变体，对 canonical 职位返回 `no_job`。
- **canonical `match_job` 已实现且有验收记录**（取代旧版「未实现」表述）：`67a3adf6`（merge `393155fc`）集成 Main——恒需批准、会话职位上下文、持久化 `AgentToolExecution`（turnKey=持久化用户消息 ID、operationKey 唯一、matchAnalysisId 唯一、分析行与 COMPLETED 同事务）、复用 FAST_SCREENING/MatchAnalysisService、缺省 career-profile 简历、`VERSION_NOT_SUBMITTABLE` 拒绝。Windows Electron 真实 AI 验收已通过（main@1a9cac08 干净树 fresh-native/full + DeepSeek BYOK，记录见 commit `2bfee169`）；`P1_FEATURES.json` AGENT-CAPABILITIES ＝ IMPLEMENTED / passes:true。聊天 purpose 为 CAREER_DIALOGUE（`chatConversationLock.ts:42`）。
- **空态建议已按运行时分叉**【源码事实】：freshNativeFull 职位上下文建议为 analyze/review/interview 三条（**不含** match 字样，但 canonical match_job 实际可用——差异待 MULTI-AGENT 收敛）；非 freshNativeFull 为 analyze/match/review/interview 四条；freshNativeFull 另有 `addCanonicalJob` 建议走 `seedExchange` 预填引导（`AgentChatEmptyState.tsx:38-82`）。

### 1.6 归档与终态现状【源码事实】

- 归档中心：`/dashboard/settings` → `archive-data`（`src/components/settings/ArchiveSettings.tsx`），覆盖职位与 AI 对话，只读查看/恢复（冻结归档合同 D1–D8）。
- 活跃面默认排除归档：board totals、upcoming 事件、列表、近期投递均排除 `archivedAt`；`loadJobsExistence` 例外地计全量行（防误判新用户）。
- 窗口投递事实计归档父机会下的已投递 Attempt（`attemptInRangeWhere`，§1.3）——**当前实现口径是"历史事实保留"**，与归档合同一致。
- Task complete/cancelled、ProcessStep COMPLETED/CANCELLED 均从活跃提醒/计数排除；`isClosed`（`ProcessStepsTable.tsx:21-27`）＝completedAt 非空 或 status ∈ {COMPLETED,CANCELLED}。

## 2. Overview 页面组织合同【推荐方案】

### 2.1 区块顺序

保持"一张可纵向滚动、单列为主"的结构（与现页一致），自上而下推荐顺序：

| 序号 | 区块 | 内容 | 渲染条件 |
| --- | --- | --- | --- |
| O1 | 欢迎与旅程定位 | 一句话说明"准备→行动→复盘"如何使用本软件；不展示指标 | 始终（文案可随 empty/nonempty 微调） |
| O2 | 三阶段旅程 | 三张阶段卡（§2.2）：核心工作说明 + 功能入口 + Agent 入口 | 始终；卡片入口按 §2.4 能力门降级 |
| O3 | 下一步建议 | NEXT-ACTIONS 规则输出（§4） | 仅当有 ≥1 条命中；空态见 §4.5 |
| O4 | 临近事项 | 复用现有 `getOverviewReminders`（≤7 天到期 Task + 申请截止/流程步骤） | 有内容才渲染（现状保持） |
| O5 | 数据简报 | 复用 `OverviewMetrics` 三卡；CAREER-INSIGHTS 新增指标另行冻结后追加 | 始终（blocked 显示 "—"） |
| O6 | 近期动态 / 起点引导 | `RecentUpdates`（nonempty/unknown）或 `GettingStarted`（empty） | 沿用 `getOverviewDataState` |

理由：P2 B1 推荐顺序是"欢迎→旅程→建议→看板/近期→其余入口"。O4/O5 即"简明数据看板与近期事项"的最小实现，O6 承担"其余核心功能入口"中的新建入口与近期列表。三阶段卡本身已枚举主要模块入口，不再单列"全部功能"区块，避免第二套互相冲突的导航（P2 C1 交互原则）。

**【待决定】** O2 与 O3 的相对顺序：若 Owner 希望"已有数据用户第一眼看到行动"，可将 O3 提到 O2 之前；本推荐把旅程教学放在建议之前，因为它同时承担新用户引导（§9 D1）。

### 2.2 三阶段卡与真实入口映射【推荐方案】

| 阶段 | 副标题（说明"这里能做什么"） | 功能入口（真实路由） | 默认 Agent（目标态） |
| --- | --- | --- | --- |
| 准备 Prepare | 建立职业素材与简历版本、研究目标岗位、准备面试 | `/dashboard/profile`（素材与版本工作台入口）；`/dashboard/profile/resumes`（版本列表，resumeV1 门控）；`/dashboard/questions`（题库） | Voca Insight |
| 行动 Act | 收集目标职位、记录真实投递、跟进流程 | `/dashboard/myjobs`（含 `?add-job=true`、`?tab=upcoming`，upcoming 仅 AB 读模式）；`/dashboard/tasks`（`?add-task=true`） | Voca Pilot |
| 复盘 Review | 复盘真实面试、沉淀题目与经验、进入练习 | `/dashboard/myjobs/[id]?tab=timeline`（真实面试复盘在职位详情时间线；legacy 无 timeline tab，无效值回退 description）；`/dashboard/interview`（练习与历史） | Voca Reflect |

- 阶段卡点击功能入口做普通导航；点 Agent 入口仅打开右侧 Agent 面板（§6），**不自动发送消息、不预造上下文**——首页没有对象上下文，`pageContextFor` 对 `/dashboard` 不返回实体（`pageContext.ts:13-22`），符合"不凭空选择目标"。
- "复盘"阶段的功能入口需要**职位上下文**才能落到具体复盘：阶段卡给的是解释性入口（文案+myjobs 链接），真正的复盘直达由 NEXT-ACTIONS 的 R6 建议（§4）承担。【待决定】是否为复盘卡增加"待复盘面试数"徽标（依赖 §4.7 读模型，随 §9 D3 同一谓词）。
- 「默认 Agent」列为 P2 目标态（MULTI-AGENT 落地后的角色归属）；V1 阶段卡 Agent 槽位只打开现有单一助手（§6、§9 D7），不展示三个角色名。

### 2.3 新用户与已有数据用户【推荐方案】

复用 `empty|nonempty|unknown` 三态骨架，但判定域需扩展：

- **判定域扩展**：在现有职位/任务/题目/InterviewSession 之外，把 `CareerMaterialItem`（未归档）、`ResumeVariant`（未归档，resume 家族=ab）/ legacy `Resume` 行纳入"有数据"判定，使"只建过简历素材的用户"不再被当成纯新用户。【源码事实】当前不计（§1.1）。【待决定】扩展范围（§9 D6）。
- **empty**：O1+O2 完整旅程教学；O3 只可能命中"建立简历素材/添加职位"等起始规则（§4 R1/R3）；O6 显示起点引导（沿用 `GettingStarted` 深链组）。统计区域保持真实计数，不用示例数字冒充记录。
- **nonempty**：O2 保留为紧凑导航；O3/O4/O5 按实际数据呈现；不显示常驻新手教程。
- **unknown**（jobs 家族 blocked）：与现有一致——降级为正常工作台 + `JobsUnavailableNotice`，不提供起点引导，不伪造计数。
- **无 AI 配置**：在 O3 中可出现"配置 AI（可选）"建议（§4 R2）；**不阻断**任何工作台入口，三阶段卡上的 Agent 入口保持可点（打开面板后面板自身有 preflight/未配置态处理，`AgentChatProvider.tsx:948`）。

### 2.4 能力门轴与降级表现【推荐方案】

**能力门轴【源码事实】**（比"fresh/migrated/legacy"更准确的判定单位）：

| 门轴 | 判定 | 出处 |
| --- | --- | --- |
| jobs 读家族 = ab | AB_READY_DISABLED 或 AB_ENABLED+full | `jobsReadCapabilities.ts:9-15`、`jobsReadDispatch.ts:182-201` |
| resume 读家族 = ab | AB_ENABLED + scope∈{resume_v1,full} | `capabilities.ts:26-34`、`resumeReadDispatch.ts:51-70` |
| canonical 写（投递/步骤/复盘/绑定） | AB_ENABLED+full | `capabilities.ts:130-148` |
| timeline/复盘读面 | AB_READY_DISABLED 或 AB_ENABLED+full | `application.actions.ts:44-47` |
| Agent 工具集 | freshNativeFull＝6 项（canonical match_job 恒需批准、无 cover_letter）；canonicalJobs（migrated-full）＝add_job 写 canonical、match_job 仍 Legacy 变体；其余＝7 项含 Legacy match_job+cover_letter | `tools/index.ts:18-91` |
| add-job 深链（jobMutationsEnabled） | LEGACY_ONLY→true；AB_ENABLED→migrated 或 full | `freshSurfacePolicy.ts:19-24` |
| automations 导航隐藏 | 仅 freshNativeFull | `freshSurfacePolicy.ts:44-50` |

**运行时降级矩阵【推荐方案】**（卡片入口与规则按上表门轴过滤，与 `GettingStarted.tsx:62-64`/`GlobalActions.tsx:65-67` 过滤 add-job 同一模式）：

| 运行时态 | jobs 家族 | resume 家族 | 本合同影响 |
| --- | --- | --- | --- |
| fresh-native-full（新桌面默认） | ab | ab | 全部入口/规则可用；automations 与 letter/contacts 详情 tab 隐藏；Agent 面板为六项工具（canonical match_job 已可用、恒需批准） |
| migrated-full（AB_ENABLED+full，起源=migrated） | ab | ab | canonical 面全部可用（R4–R6 正常触发）；automations 可见；match_job 为 Legacy 变体、对 canonical 职位不可用（§1.5） |
| migrated AB+resume_v1 | legacy | ab | R1/R3 按 legacy 口径；R4 不触发（无可绑定 canonical 职位）；R5/R6 不触发；复盘入口降级为职位详情；无 upcoming Tab |
| migrated AB+none / LEGACY_ONLY | legacy | legacy | 全 legacy 降级同上；match_job 对 legacy 数据可用但首页不宣传 |
| fresh 非 full（AB+resume_v1） | blocked | ab | 职位相关入口/建议静默；R1 可判定（素材/版本）；add-job 深链隐藏 |
| fresh 非 full（AB+none）或 BLOCKED | blocked | blocked | blocked 降级；仅 Task/题目/练习入口保留 |

- 布局基元沿用 `@container/main` 容器查询：docked Agent 面板收窄主容器而非视口（`layout.tsx:103`）。阶段卡网格 3→2→1（与 `GettingStarted.tsx:61` 的 1→2→4 列模式同风格）；窄容器下区块顺序保持不变（推荐，见 §9 D1）。
- `<sm`：Sidebar 隐藏、Header Sheet 导航（现状）。计数卡 `grid-cols-2 xl:grid-cols-3`（现状 `OverviewMetrics.tsx:36`）。

## 3. 每个首页数据的真实来源与可用条件

| 数据 | 现有来源 | 家族/条件 | 状态 |
| --- | --- | --- | --- |
| 进行中职位数 | `loadJobsBoardTotals` 非终态 uiStatus | jobs=ab 或 legacy；blocked → "—" | 现有能力 |
| 近 7 天投递数 | `loadDashboardJobCounts` 按机会首次 `submittedAt` 去重 | 同上 | 现有能力 |
| 未完成待办数 | `task.count` notIn complete/cancelled | 无家族依赖 | 现有能力 |
| 临近事项列表 | `getOverviewReminders`（Task ≤7d + upcoming 事件或 legacy dueDate），上限 6 | jobs=ab：upcoming 读模型；legacy：Job.dueDate；blocked：仅 Task | 现有能力 |
| 近期投递列表 | `loadRecentJobs` appliedOnly 10 条（组件截 5） | 同上；blocked → notice | 现有能力 |
| 新/老用户三态 | `getOverviewDataState` | 判定域不含素材/简历/AI/对话 | **缺口：§2.3 判定域扩展（§9 D6）** |
| 简历/素材存在性 | resume 家族=ab：`careerMaterialItem`+`resumeVariant` 未归档计数；legacy：`resume.count` | resume 家族判定（`resolveResumeReadFamily`）；blocked → 该规则不可判定 | **缺口：新读** |
| AI 可用性 | `resolveBusinessAIConfig(purpose)` → RESOLVED / INVALID_ASSIGNMENT / NOT_CONFIGURED | 无家族依赖；purpose 选取见 §9 D2 | 现有能力（复用解析器） |
| 有职位未投递 | jobs=ab：`APPLIED_ATTEMPT_WHERE` 无命中；legacy：`job.count({applied:true})=0` | jobs 家族判定；两种家族"未投递"含义不同（§4.2） | 现有能力 |
| 目标职位缺简历版本 | `ResumeVariant.targetJobOpportunityId` 绑定关系（读 `listVariants`/`getVariant` 已返回 `targetJobTitle`；写 `updateTargetJob`+工作台下拉已存在） | jobs=ab 且 resume=ab（实际＝AB_ENABLED+full） | 关系与写路径现有，**缺聚合读模型** |
| 即将发生的真实面试 | `listUpcomingApplicationEvents` 中 category=INTERVIEW 的 PROCESS_STEP | jobs=ab；legacy 无 ProcessStep | 现有能力（事件已含 category） |
| 已结束未复盘面试 | INTERVIEW 步"已结束"且按领域完成谓词判定尚未完成复盘 | jobs=ab；落地复盘写需 AB_ENABLED+full | **缺口：新读模型（§4.7）；「已结束」谓词已裁定＝仅 COMPLETED（§9 D3/§10）** |
| 待复盘计数徽标（可选） | 同上新读的计数 | 同 R6 | 缺口（随 R6/§4.7） |
| Agent 可用性 | `resolveChatCreationLock`/preflight（CAREER_DIALOGUE） | 无家族依赖 | 现有能力（AgentChatProvider 已做 preflight） |

## 4. NEXT-ACTIONS 规则合同【已冻结：2026-11-01 裁定】

### 4.1 候选规则（按建议优先级排序）

| # | 触发条件（确定性判定） | 建议文案方向 | 跳转目标 | 门控 |
| --- | --- | --- | --- | --- |
| R1 | 无任何简历素材：resume=ab→`CareerMaterialItem`=0 且 `ResumeVariant`=0（均未归档）；resume=legacy→`Resume`=0；resume=blocked→不触发 | 建立/导入职业素材，开始准备简历 | `/dashboard/profile` | resume 读家族判定 |
| R2 | `resolveBusinessAIConfig` 对约定 purpose 返回 `NOT_CONFIGURED`（purpose 见 §9 D2） | 可选：连接 AI 服务以获得辅助 | `/dashboard/settings?section=ai-services` | 无 |
| R3 | 无任何职位记录；或有职位但无一条"已投递"（jobs=ab：`APPLIED_ATTEMPT_WHERE` 无命中；legacy：`applied=false` 全部） | 添加/导入目标职位并记录第一次投递 | `/dashboard/myjobs?add-job=true`（无职位且 jobMutationsEnabled）或 `/dashboard/myjobs`（有职位未投递） | jobs 家族判定；add-job 深链需 jobMutationsEnabled |
| R4 | 存在活跃职位（未归档、非终态）且**没有** `ResumeVariant.targetJobOpportunityId` 指向它 | 为目标职位绑定或新建简历版本 | `/dashboard/profile/resumes` | jobs=ab 且 resume=ab（实际＝AB_ENABLED+full）；每职位一条去重（§4.3） |
| R5 | upcoming 事件中存在 category=INTERVIEW 的 PROCESS_STEP（attentionAt < +7d 或已逾期） | 准备即将进行的真实面试；**排期已过未完成的轮次只提示确认状态**（协调建议，随 §9 D3） | `/dashboard/myjobs/{jobOpportunityId}?tab=timeline`（多轮时取最近一条） | jobs=ab（含 AB_READY_DISABLED——只读引导不需要写权） |
| R6 | 存在"已结束"的 INTERVIEW 步且按领域完成谓词判定尚未完成复盘（判定见 §4.2，谓词已裁定 §9 D3＝仅 COMPLETED） | 复盘刚结束的真实面试 | `/dashboard/myjobs/{jobOpportunityId}?tab=timeline` | jobs=ab 且复盘写可用（AB_ENABLED+full；AB_READY_DISABLED 下推荐静默，见 §9 D3） |
| R7 | `AIBusinessAssignment` 存在但解析为 `INVALID_ASSIGNMENT` | AI 连接需要修复（不影响手动使用） | `/dashboard/settings?section=ai-services` | 无；与 R2 互斥 |

规则性质全部为**普通模块导航**；点击只走路由，不打开 Agent、不发送消息、不写业务数据。

### 4.2 关键判定定义【已冻结：2026-11-01 裁定】

- **"已结束"真实面试（R6）——已裁定谓词（§9 D3＝A，2026-11-01）**：**仅 `step.status === "COMPLETED"` 计入待复盘**（用户显式标记结束，`completedAt`/`completedAtPrecision` 随 `completeProcessStep` 同写）；`CANCELLED` 一律不算；`PENDING/IN_PROGRESS` 不计；`scheduledAt < now` 但**未完成**的步不计入待复盘——只作为"确认该轮面试状态"的弱提示（呈现位置复用 R5-upcoming 条目文案，不产生"待复盘"断言）；迁移产生的 `EVIDENCED` 状态按"非 COMPLETED"处理（已裁定）。本合同原推荐口径（completedAt∨COMPLETED∨逾期未关闭）为裁定备选 B，未采纳。
- **"已复盘"**：双口径随面试合同 D2 裁定——D2-a 落地（`reflectionCompletedAt`）→ `interviewDetail.reflectionCompletedAt NOT NULL`；仅在 Owner 明确选择 D2-b 时 → `interviewDetail` 存在且（`reflectionText` 非空白 OR `reflectionItems` 至少 1 条）。仅 D2-b 下空 detail（无 text 无 items）视为未复盘；D2-a 仅看完成标记，标记非空时即使内容清空仍完成。当前 save 对不存在 detail 的空保存早退，不代表已完成 detail 的内容/标记会被清除。两种口径是互斥方案，由 INTERVIEW-DEBRIEF 合同单一拥有。裁定前或 D2-a 已批准但字段/接口未落地时，R6 记为未覆盖并静默，不允许启用内容存在性过渡口径；首页只消费领域结果（§4.7）。
- **"有即将面试"（R5）**：直接复用 `listUpcomingApplicationEvents` 过滤 `category===INTERVIEW`；不新造语义。COMPLETED 步天然不在 upcoming（§1.3 推论），故"已结束"与"即将发生"按构造互斥，无需额外去重规则。
- **"AI 可用"（R2）**：见 §9 D2。
- **"有职位未投递"（R3 后半）**：ab 用 `APPLIED_ATTEMPT_WHERE` 全局无命中；legacy 用 `job.count({applied:true})=0`。两种家族下"未投递"含义不同（legacy 无 Attempt 草稿态），文案须按家族区分或在 legacy 下只保留"无职位"半条（§9 D8）。

### 4.3 优先级、去重、上限【推荐方案】

- **优先级顺序**：R5 > R6 > R4 > R3 > R1 > R7 > R2。理由：时间敏感（面试将至/刚结束）优先于准备类缺项；缺简历素材对"准备投递"是前置但因与 R3/R4 语义重叠排后；AI 类为可选辅助置底。
- **去重**：按 `ruleId + targetEntityId` 去重——R4 每职位一条；R5/R6 每 INTERVIEW 步一条（同一步在 upcoming 与"已结束"间按构造互斥，见 §4.2）；同一职位多条命中各自独立成条。
- **数量上限**：**3 条**【推荐值，§9 D4】。超限时按本节优先级顺序截取；同规则按稳定实体 ID 排序，R5 按事件时间升序、R6 按领域结果顺序；被截掉的规则在标题或脚注给"+N 条其他建议"汇总计数（推荐仅计数，不展开第二页面）。
- **多状态同时命中**：规则间不互斥（除 R2/R7），允许同时展示；阶段不是线性解锁。

### 4.4 计算与刷新【推荐方案】

- 纯 SQL/服务层计算：在 dashboard 服务端读路径一次性取数（与 `getOverviewStats` 等并行 `Promise.all`），**打开首页不产生 AI 调用、不产生业务写入**。
- 刷新：跟随服务端渲染/路由刷新自然更新（`revalidatePath("/dashboard")` 已在职位/步骤/尝试变更 action 中调用，`application.actions.ts:309,344,385,408,427,442,472,487`）；不提供"暂时忽略/不再提示"按钮——V1 是否做 dismiss 见 §9 D5（本推荐不做：规则命中即真实状态，消除应通过完成业务动作）。
- 读模型归属：新建独立读模块（建议 `src/lib/career/nextActionsReadModel.ts` 或并入 `jobsReadDispatch` 同风格 dispatch），**不改写** `upcomingReadModel` 的合同；blocked 家族规则按 §4.1 门控静默不触发，不伪造状态。

### 4.5 空态【推荐方案】

- 无任何规则命中：区块整体不渲染（与 `OverviewReminders` 的"干净就不占位"一致）。备选是渲染一条安静成功态文案——实现成本仅一条静态文案，不构成独立裁定项，已按推荐口径写入本节。
- 数据不足/家族 blocked：相应规则不触发而非显示"无法判断"（与 jobsReadOrBlocked 的"不伪造"语义一致）；若因此一条建议都没有，按上空态处理。

### 4.6 与 P2 基线表的对应

| P2 已确认业务状态 | 本合同规则 |
| --- | --- |
| 没有简历或可用职业素材 | R1 |
| 没有配置可用 AI 服务 | R2（+R7 覆盖"配置了但不可用"） |
| 尚无职位或尚未开始实际投递 | R3 |
| 有职位但缺少针对目标岗位的简历版本 | R4 |
| 有即将发生的真实面试 | R5 |
| 有已结束、尚未复盘的真实面试 | R6 |

### 4.7 首页对复盘领域的最小读取契约【推荐方案，供 R6/徽标消费】

首页不拥有复盘领域规则（谓词语义归 INTERVIEW-DEBRIEF 合同单一裁定）；本节只提出**首页侧**需要什么、读到什么、不可用时怎么降级。

- **输入**：`userId`（服务端会话 `requireUser`）；账户时区（`getUserTimeZone` 一次调用，用于"今天/N 天前"文案分桶）；`resolveJobsReadFamily` 家族解析结果。
- **能力门**：仅 `jobs 家族 = ab`（AB_READY_DISABLED 或 AB_ENABLED+full，与 timeline 读面 `assertFullAbReadable`/`isFullAbReadSurface` 同门）可求值；`blocked`/`legacy` → R6 与徽标**静默不触发**，不渲染"无法判断"占位。复盘**写权**（AB_ENABLED+full）决定呈现形态：可写 → "去复盘"直达 `?tab=timeline`；只读面（AB_READY_DISABLED）→ 推荐静默（§9 D3 附带裁定，理由是跳转目标处无法保存复盘）。
- **输出以面试合同 §7.3 的 `AwaitingReflectionResult` 为唯一 DTO**：`items` 使用 `stepId/attemptId/jobOpportunityId/jobTitle/companyName/stepTitle/roundLabel/scheduledAt/scheduledAtPrecision/completedAt/completedAtPrecision/hasReflectionDraft`，并读取 `totalCount` 与独立的 `overdueUnclosedCount`。首页可映射展示字段，不另造领域接口或重算完成谓词；分页截断不改变 +N 所用的总数。
- **数据缺失与暂不可用降级**：D2-a 获批后 `interviewDetail` 缺失或完成标记为空 → 未完成；有内容但未标记完成仍是草稿；裁定前或领域接口未落地 → R6 静默且验收记未覆盖；`completedAtPrecision` unknown → 谓词不依赖其精度，仅按 status 判定；归档职位/Attempt → 不计入（与活跃面一致）；读模型整体失败 → 该规则静默（延续 `jobsReadOrBlocked` 不伪造原则，不把读失败显示成"无待复盘"）。
- **边界**：首页只消费一次领域读取结果（随首页 `Promise.all`），采用查询次数不随 Step 条数增长的聚合/批量读取，不逐 step 调 `getInterviewReflection`；不写复盘、不创建实体、不触发 `generateInterviewReflectionDraft` 或任何 AI；`EVIDENCED` 等非常量 status 的纳入与否跟 §9 D3 同一次裁定。

## 5. 归档、终态、日期与时区边界【推荐方案】

- **归档**：所有 R3–R6 判定只作用于未归档实体（与 upcoming/board 口径一致）；归档职位不触发"绑定简历版本"或"复盘"建议；`loadJobsExistence` 式"含归档才算历史"的口径仅用于新旧用户判定，不用于建议。恢复后建议自然随下次读取重现，不需要专门同步。
- **已完成/取消**：Task complete/cancelled、ProcessStep COMPLETED/CANCELLED、Attempt 终态 outcome（WITHDRAWN/REJECTED/HIRED/TRANSFERRED）不产生继续投递/面试准备的"行动"类建议；R6 属复盘，终态 Attempt 是否仍纳入随面试合同 D6 同次裁定，推荐保留未归档的 COMPLETED 轮次，首页不额外过滤 outcome。COMPLETED 的 INTERVIEW 步恰恰是 R6 的触发源（待 §9 D3 裁定生效）；CANCELLED 的 INTERVIEW 步不触发。
- **日期精度**：复用 `businessTimeFromColumns`/`businessTimeAttentionIso`/`isDeadlineOverdue`：DateOnly 事实当天即到期、次日才算逾期；无精度/unknown 只按日期呈现，不推断为某时刻；逾期判定统一走账户时区，不用宿主时区（冻结 DateTime 合同）。「已结束」谓词只依赖 `status` 枚举，不依赖 `scheduledAt` 精度（与面试合同 §7 一致）。
- **用户时区**：每条规则读路径在 action 边界调用一次 `getUserTimeZone`（`timeZone.server.ts:19-25`），与 `getOverviewReminders`/`listUpcomingApplicationEvents` 同一约定；建议文案中的"今天/明天/N 天后"按账户时区分桶。

## 6. Agent 入口与普通工作台入口的关系【推荐方案】

- 首页两种入口并列但不混用：**功能卡 = 路由导航**；**Agent 入口 = 仅打开右侧面板**（`useAgentChat().open()`），不发送消息、不预填上下文、不创建会话。这与"直接操作"和"让 Agent 辅助"是两种有效选择的已确认原则一致。
- **V1 复用现有助手入口**：三阶段卡的 Agent 槽位全部落到现有面板与现有助手（不展示三个角色名，避免把 MULTI-AGENT 未实现人格写成可用能力）。MULTI-AGENT 落地后，同一槽位切换到对应角色——首页不需要为此改结构，只换打开目标。【待决定】V1 阶段卡 Agent 槽位形态（§9 D7）。
- **与三 Agent 的衔接只定义接口，不实现**：本合同为 MULTI-AGENT 预留的接口面仅为——阶段卡持有一个语义化的 "agent 入口槽位"（可按阶段映射 prepare/act/review → Insight/Pilot/Reflect）；调用契约固定为 `open()` 语义：仅展开面板、不带实体上下文、不发消息、不建会话。角色映射、面板顶部切换、建议填入而非发送、上下文快照等全部由 MULTI-AGENT Owner 实现；**本包不修改 `src/components/agent/*` 与 `AgentChatTrigger`，不新增任何工具**。
- **不依赖未实现能力**：建议条目一律 `Link` 到真实路由；不写"让 Agent 帮你投递/复盘"等暗示不存在工具的文案。canonical `match_job` 在 fresh-native/full 下已真实可用（§1.5），但首页建议仍保持纯导航——是否将 Agent 能力写进建议文案归 MULTI-AGENT 合同裁定，不在本包；legacy 运行时下 `match_job` 虽注册可用但首页不做能力宣传。首页渲染与建议点击都不产生 AI 请求（§4.4）。
- 无 AI 配置时 Agent 入口仍可点击——面板自身的 preflight/未配置态负责引导（`AgentChatProvider.tsx:948`），首页不重复造禁用态。

## 7. 可验证的验收条件（按用户场景）【推荐方案】

| 场景 | 验收条件 |
| --- | --- |
| S1 全新账号（fresh-native-full） | 首页展示 O1+O2 旅程与起点引导；各计数为真实 0/空态不伪造；点击任一阶段入口到达真实页面；建议区只有起始类建议（R1/R3/R2 视配置）；**打开首页 0 次 AI 调用、0 次业务写入** |
| S2 新用户未配置 AI | R2 建议出现并可点进设置 AI 区；工作台所有入口不被阻断；Agent 入口可打开面板并呈现面板自身的未配置引导 |
| S3 已有数据用户 | O3 按 §4.3 顺序/上限展示命中建议并正确跳转（深链参数生效：`?tab=`、`?add-*`）；O4/O5/O6 数据与 myjobs/tasks 页一致；无新手教程占位 |
| S4 真实面试已结束未复盘（待 §9 D3 裁定生效） | 将 INTERVIEW 步标记 COMPLETED 后首页出现 R6 建议；点击落到该职位 timeline Tab；按 D2 裁定完成复盘后建议消失；D2-a 下仅保存草稿不消除建议；CANCELLED 步不产生该建议；**排期已过未标记完成的步不出现"待复盘"断言（协调建议生效时）** |
| S5 只有归档数据的用户 | 不被当成新用户（不显示起点引导）；不产生指向归档对象的 R3–R6；恢复后建议重新出现 |
| S6 多条件同时命中 | 顺序符合 §4.3；同职位多条按实体去重；超出上限时出现"+N"汇总；不出现重复跳转 |
| S7 窄窗口/窄容器 | 阶段卡 3→2→1 无横向滚动；docked Agent 面板收窄主容器后入口仍可达不重叠；<sm 时 Sheet 导航可到达全部入口 |
| S8a migrated-full | canonical 面与 fresh-full 一致：R1–R7 按 ab 口径触发、upcoming/timeline/简历版本入口可用；automations 可见 |
| S8b legacy / migrated 非 full | AB-only 规则（R4/R5/R6）不触发且不显示占位；R1/R3 按 legacy 口径判定；复盘入口降级为职位详情（无 timeline tab）；不产生 JOBS_READ_UNAVAILABLE 伪空态 |
| S8c fresh 非 full（如 AB+resume_v1） | jobs 家族 blocked：职位相关建议/入口静默但 resume 入口可用；不出现指向不可见数据的建议 |
| S9 jobs 家族 blocked | 显示 blocked 降级而非伪造数据；blocked 相关规则静默；Task/题目/练习入口可用；不显示 GettingStarted |
| S10 数据变化后 | 完成建议动作（建简历版本/记录投递/按裁定完成复盘）回到首页后建议自然更新；无缓存陈旧 |

## 8. 一个完整开发任务的交付边界与最小充分验证【推荐方案】

### 8.1 交付边界（单一任务，不再拆分）

本合同建议作为**一个独立开发任务**交付：JOURNEY-OVERVIEW 首页重组（O1–O6）+ 三阶段卡 + NEXT-ACTIONS 读模型/规则/UI + `getOverviewDataState` 判定域扩展（若 D6 批准）+ 双语文案 + 定向测试——由**同一 Coding Owner、同一 Worktree** 完成，不按组件/API/测试拆成多个任务（同一用户行为所需 UI、规则、读取与测试属于同一成果，AGENTS_PROMPTS §2）。首页布局及 R1–R5/R7 可独立推进，不依赖 MULTI-AGENT、CAREER-INSIGHTS 或 JOB-CONNECTIONS 完成；R6 的真实数据与验收依赖 INTERVIEW-DEBRIEF 领域读取接口及 D2/D6 裁定。其他成果完成后首页按既有槽位增量接入，**不需要回头改本包的结构**（Agent 槽位切换、指标卡追加、复盘直达升级均为此设计）。R4 落地只需链到现有 `/dashboard/profile/resumes`——绑定 UI（`ResumeVariantWorkspace.tsx:546`）与写路径（`updateTargetJob`）已存在，本包不新建绑定交互。

**任务不含**：聊天面板/Provider 任何改动、新增或修改 Agent 工具、Schema/Migration、复盘域写入、`upcomingReadModel`/`jobsReadDispatch` 消费者合同改写、CAREER-INSIGHTS 新指标、三 Agent 人格。R6 的前置是 §9 D3 与面试合同 §13 D6 的 Owner 裁定落地；若实施时谓词或领域接口未就绪，可先实现首页壳及不依赖复盘的规则；R6 保持静默并记录 NOT_RUN/BLOCKED，不交付替代谓词或把首页整包记为已验收（见 §4.7）。

### 8.2 共享文件 Owner 建议

| 文件/区域 | 建议 Owner | 说明 |
| --- | --- | --- |
| `src/app/dashboard/page.tsx` | 本包 Owner | 区块编排唯一写点 |
| `src/actions/dashboard/*`（含 barrel `dashboard.actions.ts`） | 本包 Owner | 新增 next-actions/data-state 读函数 |
| 新建 `src/lib/career/nextActions*.ts` / `src/components/dashboard/*` 新组件 | 本包 Owner | 新文件无共享冲突 |
| `src/i18n/messages/zh-CN.json` + `en.json` | **共享词典单一 Owner**——主协调指定唯一词典 Owner，首页/复盘/三 Agent 提交键清单，由该 Owner 顺序整合 | 双语词条必须同步 |
| `src/lib/career/upcomingReadModel.ts`、`jobsReadDispatch.ts` | 复用不修改；确需扩展时由文件唯一 Owner 处理 | 复盘读取接口由复盘 Owner 提供；`src/actions/dashboard/overview.ts` 归本包 Owner，可按 D6 扩展 data-state 判定，保留现有消费者契约 |
| `src/components/agent/*`、`src/components/AgentChatTrigger.tsx` | **不改**（MULTI-AGENT Owner） | 首页仅调用 `open()` |
| `src/components/career/resume-variant/*`、`src/lib/career/resumeVariantService.ts` | **不改**（RESUME-BUILDER Owner） | R4 仅复用现有绑定 UI/写路径 |
| `src/app/dashboard/layout.tsx`、`Sidebar.tsx`、`Header.tsx`、`constants.ts` | 不改 | 导航结构不变 |
| `wiki/P2_FEATURES.json`、`P2_IMPLEMENTATION.md` | Main 集成 Owner | 状态同步在集成时 |

### 8.3 最小充分验证（按影响选择，不默认全量）

- **类型检查 + 改动文件 ESLint**（项目既有命令）。
- **定向单测**：next-actions 规则矩阵（家族门轴、命中/不命中、去重、排序、上限与"+N"、空态、归档排除、时区分桶、unknown 精度、blocked 静默）；`getOverviewDataState` 扩展域用例（仅素材/仅版本/仅 legacy Resume 用户不再误判 empty）；组件渲染条件（empty/nonempty/unknown、规则上限）。
- **i18n 双语键同步核对**（zh-CN/en 词条一致，沿用既有检查方式）。
- **隔离库读模型验证**：种子数据覆盖 R1–R7 命中、归档排除、多实体去重、「已结束/已复盘」谓词（含 detail 缺失与空 detail 行）。
- **明确 NOT_RUN（除非另行授权）**：生产 Build、真实 Electron、完整 E2E、真实 AI、真实数据操作——桌面/集中验收由主协调窗口按既有授权另行指定执行者。本包无 AI 调用路径，无需真实 AI 验证。

## 9. Owner 裁定问题清单（2026-11-01 已逐项裁定，结果见 §10）

每项给互斥选项与本合同推荐；裁定结果已生效，按冻结合同实施。未列入的问题（如区块内具体卡片文案、空态隐藏 vs 安静文案）不影响实现结构，按推荐口径实施。

| # | 问题 | 选项（互斥） | 本合同推荐 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | O2 旅程与 O3 建议的相对顺序 | A) 旅程在前；B) 建议在前 | A | 首屏叙事（新用户引导一体化）vs 行动优先；窄容器统一保持文档顺序 |
| D2 | R2"AI 可用"判定的 purpose | A) CAREER_DIALOGUE；B) GLOBAL_DEFAULT；C) 逐 purpose 聚合（任一 RESOLVED 即不提示） | A | A 对应首页 Agent 入口真实可用性；B 最宽（任一可用即静默）；C 提示最弱 |
| D3 | **「面试已结束」统一谓词与 R5/R6 边界【跨合同项】** | A) 仅 `status==="COMPLETED"` 计入待复盘；排期已过未完成不计入，仅提示确认状态；B) `completedAt∨COMPLETED∨(scheduledAt<now 未关闭)` 计入待复盘；C) 仅 `completedAt∨COMPLETED` 计入，逾期步仍归 R5-overdue | **协调建议＝A**（与面试合同 §13 D6 推荐一致；本合同原推荐 B 已降级为备选）——**尚未获批准，两份合同同项裁定后才可实施** | A 确定性强且不误报未标记完成的轮次；"确认状态"弱提示的呈现位置（R5 文案或职位详情）随裁定一并定；同一谓词同时服务复盘卡待复盘徽标；`EVIDENCED` 处理与未归档终态 Attempt 是否纳入待复盘随本项一并裁定 |
| D4 | 建议上限与溢出形态 | A) 3 条 + "+N"计数；B) 5 条 + "+N"；C) 无上限平铺 | A | 首屏密度；C 可能挤出下方看板 |
| D5 | 是否需要 dismiss/消除机制 | A) V1 不做；B) 会话内隐藏（不持久）；C) 持久化 dismiss | A | A 零存储、消除靠完成业务动作；C 需新持久化与恢复语义，超出本包推荐边界 |
| D6 | `getOverviewDataState` 判定域扩展范围 | A) +CareerMaterialItem + ResumeVariant(ab)/Resume(legacy)；B) A 再 + ChatConversation；C) 不扩展 | A | A 覆盖"只建过素材"的真实新用户缺口；B 把"只聊过天"也算老用户；C 保持现状误判 |
| D7 | 阶段卡 V1 的 Agent 槽位形态 | A) 单入口（"Ask Vocatrya"，打开现有面板）；B) V1 不放 Agent 槽位；C) 三角色占位 | A | A 满足"首页可主动打开 Agent"已确认原则且不虚标能力；B 推迟该入口到 MULTI-AGENT；C 会把未实现人格写成可用，不推荐 |
| D8 | R3 legacy 口径是否保留"有职位未投递"半条 | A) 两分支均保留、文案按家族区分；B) legacy 仅"无职位"分支 | A | legacy `applied` 语义与 ab Attempt 不同，A 提示更完整、B 更保守 |
| D9 | R4 目标职位范围 | A) 活跃未归档且未投递；B) 全部活跃未归档职位；C) 含已投递职位 | A | A 把建议绑定到"准备投递"动作；B/C 对已在流程中的职位提示绑定，诉求归 JOB-CONNECTIONS 更合适 |

---

**授权声明**：§9 D1–D9 已于 2026-11-01 经 Owner 逐项裁定冻结（§9 D3 与 `P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md` §13 D6 同次裁定生效），实施按 §10 冻结记录执行。本文件不构成代码修改、Schema/Migration、提交、合并、推送、发布或真实数据操作授权——实施仍须各自任务授权。

## 10. Owner 裁定冻结记录（2026-11-01）

Owner 于 2026-11-01 逐项裁定 §9 D1–D9，全部按推荐/协调建议生效。裁定依据：只读源码备料（`.tmp/p2-overview-actions-decision-prep/`）与合并总表（`.tmp/p2-decision-merge/owner-decision-pack.md`），核实基线 `main @ 55d5a4a9`。

| # | 裁定结果 |
| --- | --- |
| D1 | A：O2 旅程区在前、O3 建议区在后 |
| D2 | A：purpose＝`CAREER_DIALOGUE`；RESOLVED 为**存储态**判定，R2/R7 文案按"配置层面可用"表述，不承诺服务实时可用 |
| D3 | A（与面试合同 §13 D6 同次裁定生效）：仅 `status === "COMPLETED"` 计入待复盘；排期已过未完成不计入，仅提示确认状态 |
| D4 | A：建议上限 3 条 + "+N" 计数 |
| D5 | A：V1 不做 dismiss 机制 |
| D6 | A：`getOverviewDataState` 判定域扩展 +CareerMaterialItem + ResumeVariant(ab)/Resume(legacy)；不加 ChatConversation |
| D7 | A：阶段卡 Agent 槽位为单入口复用 `useAgentChat().open()`——只打开面板，不建会话、不发消息 |
| D8 | A：两分支各按本家族口径（ab＝`APPLIED_ATTEMPT_WHERE`，legacy＝`Job.applied`）；R3「无职位」按"未归档职位＝0"判定（`loadJobsExistence` 计含归档行，需独立谓词） |
| D9 | A：R4 候选＝活跃未归档且未投递职位 |

**附随裁定（随 D3 生效，两合同同步）**：

- `EVIDENCED`（迁移合成步，不在 `PROCESS_STEP_STATUS` 常量集）按"非 COMPLETED"处理：不计入待复盘；V1 **不提供**非 USER 步"标记完成"UI 入口——迁移轮次如需进入待复盘，可新建 USER INTERVIEW 步标记完成。
- 未归档终态 Attempt（REJECTED/WITHDRAWN/HIRED/TRANSFERRED）下的 COMPLETED 轮次**计入**待复盘：`listAwaitingReflectionInterviews` 仅过滤 Attempt/Job `archivedAt`，不加 `outcome` 过滤（与 upcoming 读模型的 `outcome∈{ACTIVE,OFFER}` 为不同读模型，并存不冲突）。
