# JOURNEY-OVERVIEW / NEXT-ACTIONS 实施合同提案（P2 首页与下一步建议）

- 基线：`main @ 39a5a1d3`（2026-10-29 核实）
- 状态：**提案，未经 Owner 冻结**。除【源码事实】外，所有布局、规则数值、排序与判定均为【推荐方案】；标注【待决定】的条目需 Owner 裁定后才能按冻结合同实施。本文件不授权代码修改、Schema/Migration、提交、合并、部署或真实数据操作。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行）；**【推荐方案】**＝本合同建议，未冻结；**【待决定】**＝需 Owner 裁定的产品规则。
- 上游依据：`wiki/P2_IMPLEMENTATION.md`（P2 产品设计基线，已确认原则）与 `wiki/P2_FEATURES.json`；归档语义遵循已冻结的 `ARCHIVE_CONTRACT_PROPOSAL.md`；日期/时区语义遵循已冻结的 `DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`。

## 0. 范围与边界

本合同覆盖 P2 六个 Feature 中的两项首页耦合部分：

- **JOURNEY-OVERVIEW**：`/dashboard` 一张可滚动 Overview 页的区块组织、三阶段（准备/行动/复盘）入口映射、新用户与已有数据用户状态、窄窗口表现。
- **NEXT-ACTIONS**：由真实业务数据确定性规则计算的"下一步建议"区，包括触发条件、优先级、去重、上限、空态与跳转目标。

**不在本合同范围**：MULTI-AGENT 的三角色人格/面板改造（本合同只定义首页 Agent 入口槽位及其降级行为）；CAREER-INSIGHTS 的指标口径冻结（本合同只复用现有计数）；JOB-CONNECTIONS 与 INTERVIEW-DEBRIEF 的 Schema 级数据合同；任何新 Agent 工具、后台 AI 调用、自动建任务、Activity 计时类能力。

**产品边界（与 P2 基线一致，不再开放讨论）**：三阶段可自由进入，不做强制线性向导；建议由真实业务规则计算，不调用 LLM、不自动创建任务、不自动投递、不自动执行 Agent；不重造 P1 简历工作台和三条 AI Provider 基础设施；不引入 Activity 计时或类似效率打卡。

## 1. 源码事实总览

### 1.1 首页现状【源码事实】

- `/` 路由 `src/app/page.tsx:5-18`：已登录重定向 `/dashboard`；无用户 → `/signup`，有用户未登录 → `/signin`。
- 首页 `src/app/dashboard/page.tsx:18-42`：服务端组件，单列网格（`max-w-[1400px]`，`auto-rows-max gap-4`），自上而下渲染三块：
  1. `OverviewMetrics`（进行中职位、近 7 天投递、未完成待办三张计数卡，`OverviewMetrics.tsx:11-55`）；
  2. `OverviewReminders`（条件渲染，无到期项时整块不渲染，`OverviewReminders.tsx:26`）；
  3. `dataState === "empty" ? <GettingStarted/> : <RecentUpdates/>`（`page.tsx:35-39`）。
- `getOverviewStats`（`src/actions/dashboard/overview.ts:38-65`）：`inProgress`＝非终态 uiStatus 职位数，`applied7d`＝窗口内首次投递职位数，`openTasks`＝status 不在 `["complete","cancelled"]` 的 Task 数（`OPEN_TASK_STATUSES`，`overview.ts:36`）。jobs 读家族 blocked 时只返回 openTasks，卡片显示 "—"（`OverviewMetrics.tsx:18-31`）。
- `getOverviewDataState`（`overview.ts:75-102`）：`tasks>0 || 用户自建题目>0 || InterviewSession>0` → `nonempty`；否则按 `loadJobsExistence`（**含归档行**，`jobsReadDispatch.ts:733-744`）判空；家族 blocked → `unknown` → 渲染正常工作台而非新手引导（`page.tsx:32-34` 注释明确该降级语义）。
  - **注意**：判定域目前只覆盖职位、任务、题目、面试练习会话；**不含** CareerMaterialItem、ResumeVariant、AIConnection、ChatConversation。fresh-native 用户只建过简历素材时仍被当 `empty`。
- `getOverviewReminders`（`overview.ts:139-243`）：`REMINDER_LIMIT=6`（`overview.ts:124`）；来源为 ≤7 天到期 Task（dueDate 或 dueOn，排除 complete/cancelled）+ AB 家族 `listUpcomingApplicationEvents` 或 legacy `Job.dueDate`；`dateOn` 标记 DateOnly 事实按日历日渲染（`overview.ts:104-117,212-218`）；整体排序 `at` 后截取 6 条。
- `getRecentJobs`（`src/actions/dashboard/recent.ts:7-20` → `jobsReadDispatch.ts:598-629`）：仅**已投递**职位，AB 按 `firstSubmittedAtDesc`、legacy 按 `appliedDate desc`，`APP_CONSTANTS.RECENT_NUM_JOBS=10`（`constants.ts:29`），组件截 5 行（`RecentUpdates.tsx:10`）。

### 1.2 导航与可达入口【源码事实】

- 侧边栏 `SIDEBAR_LINKS`（`src/lib/constants.ts:344-391`）：概览 `/dashboard`、数据看板 `/dashboard/analytics`、我的职位 `/dashboard/myjobs`、自动化巡检 `/dashboard/automations`（fresh-native-full 下隐藏，`freshSurfacePolicy.ts:44-50` + `Sidebar.tsx:174-176`）、待办任务 `/dashboard/tasks`、面试题库 `/dashboard/questions`、面试练习 `/dashboard/interview`、网申资料 `/dashboard/profile`、开发者选项（devOnly）；底部设置 `/dashboard/settings`。
- 窄窗口：`<sm` 时 Sidebar 隐藏（`Sidebar.tsx:126` `hidden sm:flex`），Header 内 Sheet 提供同等导航（`Header.tsx:44-86`）。
- 全局创建菜单 `CreateMenu`（`GlobalActions.tsx:17-21`）：`/dashboard/myjobs?add-job=true`、`/dashboard/tasks?add-task=true`、`/dashboard/questions?add-question=true`；空账号 `GettingStarted` 复用同一组深链（`GettingStarted.tsx:20-42`）。
- 深链参数现状：`?tab=`（`useTabQueryParam.ts:9`）——myjobs 页 `?tab=jobs|upcoming`（`MyJobsPageTabs.tsx:19,39-42`），职位详情 `?tab=description|timeline|match|letter|notes|contacts`（`JobDetails.tsx:64-81`，fresh-native-full 下 letter/contacts 不存在并回退 description）；设置页 `?section=` 或 `#`（`settings/page.tsx:84-90`），AI 相关 section 为 `ai-services`/`ai-assignments`（`settings/page.tsx:168-197`），归档中心为 `archive-data`（`settings/page.tsx:243-250`）。
- 简历相关路由：`/dashboard/profile`＝职业素材工作台（fresh 下隐藏 legacy 卡，`profile/page.tsx:33-50`）；`/dashboard/profile/resumes`＝简历版本列表（`resumes/page.tsx`）；`/dashboard/profile/resumes/[variantId]`＝版本工作台；`/dashboard/profile/resume/[id]`＝legacy 编辑器。

### 1.3 数据读模型与家族分发【源码事实】

- `resolveJobsReadFamily`（`jobsReadDispatch.ts:182-201`）→ `ab | legacy | blocked`；dashboard 统一经 `jobsReadOrBlocked` 包装成类型化 blocked 结果而非伪造 0（`actions/dashboard/shared.ts:43-58`）。新装桌面用户（fresh-native full）走 `ab`。
- `loadJobsBoardTotals`（`jobsReadDispatch.ts:649-725`）：AB 口径——未归档 JobOpportunity 全量派生 uiStatus；`applied`＝存在已投递 Attempt；`interviews`＝未归档 Attempt 且父机会未归档下 category=INTERVIEW 的 ProcessStep 计数；`inProgress`＝非终态 uiStatus（终态集 `archived|expired|rejected|offer-accepted|offer-declined|transferred`，`jobsReadDispatch.ts:75-82`）；`offers`＝offer 系 uiStatus。
- `loadDashboardJobCounts`（`jobsReadDispatch.ts:458-538`）：AB 按 `jobOpportunityId` 分组取 `MIN(submittedAt)` 做窗口内"首次投递职位数"去重。
- `attemptInRangeWhere`（`jobsReadDispatch.ts:439-456`）：只排除 **Attempt 自身** `archivedAt`，**不排除父机会归档**——注释明确"已归档机会下的投递仍是发生过的事实"，与冻结归档合同"保留历史投递事实"一致。
- `listUpcomingApplicationEvents`（`upcomingReadModel.ts:170-336`）：两类事件——① 机会投递截止（status 限 ACTIVE/UNKNOWN、未归档、deadline/deadlineOn 非空、**无已投递 Attempt**）；② 流程步骤（status 不在 COMPLETED/CANCELLED、completedAt 空、有 scheduled 或 deadline、Attempt outcome ∈ {ACTIVE,OFFER}、Attempt 与父机会均未归档）。`attentionAt`＝scheduled 与 deadline-attention 的较早者；信封携带账户时区；`bucketUpcomingApplicationEvents`（`upcomingReadModel.ts:114-152`）按账户时区分 overdue/today/next7/later。
- 账户时区：`getUserTimeZone`（`timeZone.server.ts:19-25`）读 `UserSettings.settings.general.timeZone`，缺失回退运行时区；业务时间 DateOnly/Instant/精度语义按已冻结 DateTime 合同执行（`businessTimeAttentionIso` 令 DateOnly 当天即视为到期，`isDeadlineOverdue` 次日才逾期）。

### 1.4 关键实体与已有业务关系【源码事实】

- `JobOpportunity`（`schema.prisma:771-831`）：`archivedAt`、`deadline/deadlineOn/deadlinePrecision`、`status UNKNOWN|ACTIVE|CLOSED|EXPIRED`、`currentJdVersionId`；关联 `applicationAttempts`、`targetedResumeVariants`、`interviewSessions`。
- `ApplicationAttempt`（`schema.prisma:913-952`）：`submittedAt`、`currentStageCategory`（默认 DRAFT）、`outcome`（ACTIVE/WITHDRAWN/REJECTED/OFFER/HIRED/TRANSFERRED）、`submittedResumeVersionId/ArtifactId/JdVersionId`（首次绑定后不可变，`applicationService.ts:179-193`）、`archivedAt`（字段存在，当前无独立写路径）。
- "已投递"事实统一为 `APPLIED_ATTEMPT_WHERE`（`applicationFact.ts:34-40`）：未归档且（submittedAt 非空 或 stage≠DRAFT）。
- `ApplicationProcessStep`（`schema.prisma:954-985`）：category ∈ {SCREENING,ASSESSMENT,INTERVIEW,OFFER,ONBOARDING,OTHER}，status ∈ {PENDING,IN_PROGRESS,COMPLETED,CANCELLED}（`identities.ts:97-124`），时间列带精度与时区 sidecar。
- **真实面试复盘存储已存在**：`ApplicationInterviewDetail`（1:1 挂 INTERVIEW 步，`schema.prisma:1035-1051`）持有 `reflectionText` 与 `reflectionItems`（`questionText+answerNotes+sortOrder`，`schema.prisma:1058-1070`）。服务层 `getInterviewReflection`/`saveInterviewReflection`（`applicationService.ts:598-723`）强制 INTERVIEW 类别校验；UI 入口为职位详情 timeline Tab 内 INTERVIEW 行的"复盘"按钮（`ProcessStepsTable.tsx:172-173` → `ApplicationTimelineTab.tsx:438-446` `InterviewReflectionDialog`）。AI 复盘草稿走 `generateInterviewReflectionDraft`（CAREER_REFLECTION purpose，`interviewReflectionAi.actions.ts:46-101`），草稿不自动落库。
- `ResumeVariant`（`schema.prisma:1501-1519`）：`archivedAt`、`targetJobOpportunityId`（**职位绑定关系已存在且可写**，`resumeVariantService.ts:91-132` createVariant 接受；`listVariants` 返回 `targetJobTitle`，`resumeVariantService.ts:155-186`）。`ResumeVariantVersion.status` ∈ {DRAFT,FROZEN,SUBMITTED,ARCHIVED}。
- `InterviewSession`（`schema.prisma:1858-1904`）：**模拟/练习会话**，与真实面试不同实体；status ∈ {DRAFT,IN_PROGRESS,COACHING,COMPLETED,ARCHIVED}，可挂 `jobOpportunityId+jobDescriptionVersionId`。新建练习需 INTERVIEW readiness（`interview/page.tsx:59-80`；`readiness.ts:68-88` 解析 INTERVIEW purpose）。
- `Task`（`schema.prisma:491-515`）：status ∈ {in-progress,complete,needs-attention,cancelled}（`task.model.ts:4-11`），dueDate/dueOn/duePrecision。
- `Question`（`schema.prisma:624-652`）：用户题目 `createdBy` + `presetBankKey: null` + `deletedAt: null` 为用户自建口径（`overview.ts:89-91`）。
- `CareerMaterialItem`（`schema.prisma:1120-1157`）：职业素材，`archivedAt`。
- `AIConnection`/`AIBusinessAssignment`（`schema.prisma:2185-2234`）：connection status ∈ {CONNECTED,REAUTH_REQUIRED,DISCONNECTED,ERROR}；assignment 按 (userId,purpose) 唯一。purpose 集合 {GLOBAL_DEFAULT,INTERVIEW,RESUME,MATCH_ANALYSIS,CAREER_REFLECTION,CAREER_DIALOGUE}（`connections.ts:74-82`）。
- AI 解析合同 `resolveBusinessAIConfig`（`assignments.ts:213-280`）：purpose 专属 → GLOBAL_DEFAULT → NOT_CONFIGURED；INTERVIEW 额外在 GLOBAL 前插 LEGACY_INTERVIEW_CONFIG；失效的显式分配 → INVALID_ASSIGNMENT（归档/他人/非 CONNECTED/缺 runtime/空 model），**绝不静默回退**。

### 1.5 Agent 入口现状【源码事实】

- 当前只有一个 Agent（"Vocatrya 助手"）。`AgentChatTrigger` → `useAgentChat().open()` → 右侧非模态 Sheet 面板，可拖拽宽度/展开/历史/新对话（`AgentChatProvider.tsx:536-541`、`AgentChatPanel.tsx:44-143`）；打开面板会折叠侧边栏（`AgentChatProvider.tsx:537`）。
- 对话上下文 kind 仅 `job|resume`（`conversationContext.ts:5`）；页面自动附加仅限 `/dashboard/myjobs/[id]` 与 `/dashboard/profile/resume(s)/[id]`（`pageContext.ts:6-9`）；归档 canonical 职位对 AI 不可见（`conversationContext.server.ts:31-39`）。
- **现有建议点击即发送**：`AgentChatEmptyState` 的 Suggestion `run: () => send(label)` 直接 `sendMessage`（`AgentChatEmptyState.tsx:24-32`），`JobDetails.startChat` 同样是"打开+发消息"模式（`JobDetails.tsx:171-179`）。P2 已确认"点击建议只填入输入框"，此差异属 MULTI-AGENT 改造范围，本合同不在首页重造该交互。
- 现有五工具：list_jobs、get_job、add_job、get_resume、review_resume；`match_job` 未批准开放（P1_IMPLEMENTATION.md AGENT-CAPABILITIES）。聊天 purpose 为 CAREER_DIALOGUE（`chatConversationLock.ts:42`）。

### 1.6 归档与终态现状【源码事实】

- 归档中心：`/dashboard/settings` → `archive-data`（`ArchiveSettings.tsx`），覆盖职位与 AI 对话，只读查看/恢复（冻结归档合同 D1–D8）。
- 活跃面默认排除归档：board totals、upcoming 事件、列表、近期投递均排除 `archivedAt`；`loadJobsExistence` 例外地计全量行（防误判新用户）。
- 窗口投递事实计归档父机会下的已投递 Attempt（`attemptInRangeWhere`，§1.3）——**当前实现口径是"历史事实保留"**，与归档合同一致。
- Task complete/cancelled、ProcessStep COMPLETED/CANCELLED 均从活跃提醒/计数排除；`isClosed`（`ProcessStepsTable.tsx:21-27`）＝completedAt 非空 或 status ∈ {COMPLETED,CANCELLED}。

## 2. Overview 页面组织合同【推荐方案】

### 2.1 区块顺序

保持"一张可纵向滚动、单列为主"的结构（与现页一致），自上而下推荐顺序：

| 序号 | 区块 | 内容 | 渲染条件 |
| --- | --- | --- | --- |
| O1 | 欢迎与旅程定位 | 一句话说明"准备→行动→复盘"如何使用本软件；不展示指标 | 始终（文案可随 empty/nonempty 微调） |
| O2 | 三阶段旅程 | 三张阶段卡（§2.2）：核心工作说明 + 功能入口 + Agent 入口 | 始终；卡片入口按 §2.4 家族/能力降级 |
| O3 | 下一步建议 | NEXT-ACTIONS 规则输出（§4） | 仅当有 ≥1 条命中；空态见 §4.5 |
| O4 | 临近事项 | 复用现有 `getOverviewReminders`（≤7 天到期 Task + 申请截止/流程步骤） | 有内容才渲染（现状保持） |
| O5 | 数据简报 | 复用 `OverviewMetrics` 三卡；CAREER-INSIGHTS 新增指标另行冻结后追加 | 始终（blocked 显示 "—"） |
| O6 | 近期动态 / 起点引导 | `RecentUpdates`（nonempty/unknown）或 `GettingStarted`（empty） | 沿用 `getOverviewDataState` |

理由：P2 B1 推荐顺序是"欢迎→旅程→建议→看板/近期→其余入口"。O4/O5 即"简明数据看板与近期事项"的最小实现，O6 承担"其余核心功能入口"中的新建入口与近期列表。三阶段卡本身已枚举主要模块入口，不再单列"全部功能"区块，避免第二套互相冲突的导航（P2 C1 交互原则）。

**【待决定】** O2 与 O3 的相对顺序：若 Owner 希望"已有数据用户第一眼看到行动"，可将 O3 提到 O2 之前；本推荐把旅程教学放在建议之前，因为它同时承担新用户引导。

### 2.2 三阶段卡与真实入口映射【推荐方案】

| 阶段 | 副标题（说明"这里能做什么"） | 功能入口（真实路由） | 默认 Agent |
| --- | --- | --- | --- |
| 准备 Prepare | 建立职业素材与简历版本、研究目标岗位、准备面试 | `/dashboard/profile`（素材与版本工作台入口）；`/dashboard/profile/resumes`（版本列表）；`/dashboard/questions`（题库） | Voca Insight |
| 行动 Act | 收集目标职位、记录真实投递、跟进流程 | `/dashboard/myjobs`（含 `?add-job=true`、`?tab=upcoming`）；`/dashboard/tasks`（`?add-task=true`） | Voca Pilot |
| 复盘 Review | 复盘真实面试、沉淀题目与经验、进入练习 | `/dashboard/myjobs/[id]?tab=timeline`（真实面试复盘在职位详情时间线）；`/dashboard/interview`（练习与历史） | Voca Reflect |

- 阶段卡点击功能入口做普通导航；点 Agent 入口仅打开右侧 Agent 面板（§6），**不自动发送消息、不预造上下文**——首页没有对象上下文，`pageContextFor` 对 `/dashboard` 返回空（`pageContext.ts:13-22`），符合"不凭空选择目标"。
- "复盘"阶段的功能入口需要**职位上下文**才能落到具体复盘：阶段卡给的是解释性入口（文案+myjobs 链接），真正的复盘直达由 NEXT-ACTIONS 的 R6 建议（§4）承担。【待决定】是否为复盘卡增加"待复盘面试数"徽标（依赖 §4 R6 读模型）。

### 2.3 新用户与已有数据用户【推荐方案】

复用 `empty|nonempty|unknown` 三态骨架，但判定域需扩展：

- **判定域扩展**：在现有职位/任务/题目/InterviewSession 之外，把 `CareerMaterialItem`（未归档）、`ResumeVariant`（未归档，仅 ab 读家族）/ legacy `Resume` 行纳入"有数据"判定，使"只建过简历素材的用户"不再被当成纯新用户。【源码事实】当前不计（§1.1）。
- **empty**：O1+O2 完整旅程教学；O3 只可能命中"建立简历素材/添加职位"等起始规则（§4 R1/R3）；O6 显示起点引导（沿用 `GettingStarted` 深链组）。统计区域保持真实计数，不用示例数字冒充记录。
- **nonempty**：O2 保留为紧凑导航；O3/O4/O5 按实际数据呈现；不显示常驻新手教程。
- **unknown**（jobs 家族 blocked）：与现有一致——降级为正常工作台 + `JobsUnavailableNotice`，不提供起点引导，不伪造计数。
- **无 AI 配置**：在 O3 中可出现"配置 AI（可选）"建议（§4 R2）；**不阻断**任何工作台入口，三阶段卡上的 Agent 入口保持可点（打开面板后面板自身有未配置态处理）。

### 2.4 窄窗口与降级表现【推荐方案】

- 布局基元沿用 `@container/main` 容器查询：docked Agent 面板收窄主容器而非视口（`layout.tsx:101-104`）。阶段卡网格 3→2→1（与 `GettingStarted.tsx:61` 的 4→2→1 同模式）；窄容器下建议把 O4 临近事项提到 O3 之前（行动相关信息优先），或保持单列顺序不变——【待决定】。
- `<sm`：Sidebar 隐藏、Header Sheet 导航（现状）。阶段卡纵向堆叠；计数卡 `grid-cols-2 xl:grid-cols-3`（现状 `OverviewMetrics.tsx:36`）。
- 能力降级矩阵（卡片入口按运行时态过滤，与 `GettingStarted.tsx:62-64`/`GlobalActions.tsx:65-67` 过滤 `add-job` 同一模式）：

| 运行时态 | 降级规则 |
| --- | --- |
| fresh-native-full（新桌面默认） | 全部入口可用；Automations 不出现在阶段卡（本就隐藏） |
| migrated / LEGACY_ONLY | 隐藏"绑定职位简历版本"类入口与 R4 建议（无 ResumeVariant 关系）；复盘入口降级为"职位详情"（legacy 无 timeline/复盘）；upcoming Tab 不存在 |
| jobs 家族 blocked | 职位相关入口/建议不出现（与 blocked 通知并存），Task/题目/练习入口保留 |
| resumeV1 未启用 | 简历版本相关入口退化为 `/dashboard/profile` |

## 3. 每个首页数据的真实来源与可用条件

| 数据 | 现有来源 | 家族/条件 | 状态 |
| --- | --- | --- | --- |
| 进行中职位数 | `loadJobsBoardTotals` 非终态 uiStatus | ab/legacy；blocked → "—" | 现有能力 |
| 近 7 天投递数 | `loadDashboardJobCounts` 按机会首次 `submittedAt` 去重 | 同上 | 现有能力 |
| 未完成待办数 | `task.count` notIn complete/cancelled | 无家族依赖 | 现有能力 |
| 临近事项列表 | `getOverviewReminders`（Task ≤7d + upcoming 事件或 legacy dueDate），上限 6 | AB：upcoming 读模型；legacy：Job.dueDate；blocked：仅 Task | 现有能力 |
| 近期投递列表 | `loadRecentJobs` appliedOnly 10 条（组件截 5） | 同上；blocked → notice | 现有能力 |
| 新/老用户三态 | `getOverviewDataState` | 判定域不含素材/简历/AI/对话 | **缺口：§2.3 判定域扩展** |
| 简历/素材存在性 | ab：`resumeVariant` 或 `careerMaterialItem` 计数；legacy：`resume.count` | blocked → 该规则不可判定 | **缺口：新读** |
| AI 可用性 | `resolveBusinessAIConfig(purpose)` → RESOLVED / INVALID_ASSIGNMENT / NOT_CONFIGURED | 无家族依赖；purpose 选取见 §4 R2【待决定】 | 现有能力（复用解析器） |
| 有职位未投递 | `listJobs`/`loadJobsExistence` + `APPLIED_ATTEMPT_WHERE` | ab/legacy（legacy 无 Attempt 概念，"未投递"判定不同，§4 R3） | 现有能力 |
| 目标职位缺简历版本 | `ResumeVariant.targetJobOpportunityId` 绑定关系 | **仅 ab + resumeV1**；legacy/fresh 受限态不可判定 | 现有关系，**缺读模型** |
| 即将发生的真实面试 | `listUpcomingApplicationEvents` 中 category=INTERVIEW 的 PROCESS_STEP | 仅 AB；legacy 无 ProcessStep | 现有能力（事件已含 category） |
| 已结束未复盘面试 | INTERVIEW 步"已结束"且无 `interviewDetail` 内容 | 仅 AB | **缺口：新读模型（§4 R6）** |
| 待复盘计数徽标（可选） | 同上新读的计数 | 仅 AB | 缺口（随 R6） |
| Agent 可用性 | `resolveChatCreationLock`/preflight（CAREER_DIALOGUE） | 无家族依赖 | 现有能力（AgentChatProvider 已做 preflight） |

## 4. NEXT-ACTIONS 规则合同【推荐方案，全部待冻结】

### 4.1 候选规则（按建议优先级排序）

| # | 触发条件（确定性判定） | 建议文案方向 | 跳转目标 | 家族门控 |
| --- | --- | --- | --- | --- |
| R1 | 无任何简历素材：ab→`CareerMaterialItem`=0 且 `ResumeVariant`=0；legacy→`Resume`=0；家族不可判→不触发 | 建立/导入职业素材，开始准备简历 | `/dashboard/profile` | ab 或 legacy；blocked→不触发 |
| R2 | `resolveBusinessAIConfig` 对约定 purpose 返回 `NOT_CONFIGURED`（见【待决定】D2） | 可选：连接 AI 服务以获得辅助 | `/dashboard/settings?section=ai-services#ai-services` | 无 |
| R3 | 无任何职位记录；或有职位但无一条"已投递"（ab：`APPLIED_ATTEMPT_WHERE` 无命中；legacy：`applied=false` 全部） | 添加/导入目标职位并记录第一次投递 | `/dashboard/myjobs?add-job=true`（无职位）或 `/dashboard/myjobs`（有职位未投递） | jobMutationsEnabled 才显示 add-job 深链 |
| R4 | 存在活跃职位（未归档、非终态）且**没有** `ResumeVariant.targetJobOpportunityId` 指向它 | 为目标职位绑定或新建简历版本 | `/dashboard/profile/resumes` | 仅 ab+resumeV1；每职位一条去重（§4.3） |
| R5 | upcoming 事件中存在 category=INTERVIEW 的 PROCESS_STEP（attentionAt < +7d 或已逾期） | 准备即将进行的真实面试 | `/dashboard/myjobs/{jobOpportunityId}?tab=timeline`（多轮时取最近一条） | 仅 AB |
| R6 | 存在"已结束"的 INTERVIEW 步且无复盘内容（判定见 §4.2） | 复盘刚结束的真实面试 | `/dashboard/myjobs/{jobOpportunityId}?tab=timeline` | 仅 AB |
| R7 | `AIBusinessAssignment` 存在但解析为 `INVALID_ASSIGNMENT` | AI 连接需要修复（不影响手动使用） | `/dashboard/settings?section=ai-services#ai-services` | 无；与 R2 互斥 |

规则性质全部为**普通模块导航**；点击只走路由，不打开 Agent、不发送消息、不写业务数据。

### 4.2 关键判定定义【推荐方案，待 Owner 冻结】

- **"已结束"真实面试（R6）**：INTERVIEW ProcessStep 满足任一：status=COMPLETED，或 `completedAt` 非空，或（`scheduledAt` 早于 now 且 status 非 CANCELLED）。status=CANCELLED 一律不算。推荐取"completedAt 非空 OR scheduledAt<now"——与 `isClosed` 展示口径接近但排除 CANCELLED。【待决定】是否要求 scheduledAt 必须存在（无排期信息的 COMPLETED 步是否触发）。
- **"已复盘"**：`interviewDetail` 存在且（`reflectionText` 非空 OR `reflectionItems` 至少 1 条）。空 detail 行（无 text 无 items）视为未复盘——`saveInterviewReflection` 对空保存本就早退（`applicationService.ts:634-644`）。
- **"有即将面试"（R5）**：直接复用 `listUpcomingApplicationEvents` 过滤 `category===INTERVIEW`；不新造语义。
- **"AI 可用"（R2）**：见【待决定】D2。
- **"有职位未投递"（R3 后半）**：ab 用 `APPLIED_ATTEMPT_WHERE` 全局无命中；legacy 用 `job.count({applied:true})=0`。两种家族下"未投递"含义不同（legacy 无 Attempt 草稿态），文案须按家族区分或在 legacy 下只保留"无职位"半条。【待决定】。

### 4.3 优先级、去重、上限【推荐方案】

- **优先级顺序**：R5 > R6 > R4 > R3 > R1 > R7 > R2。理由：时间敏感（面试将至/刚结束）优先于准备类缺项；缺简历素材对"准备投递"是前置但因与 R3/R4 语义重叠排后；AI 类为可选辅助置底。
- **去重**：按 `ruleId + targetEntityId` 去重——R4 每职位一条；R5/R6 每 INTERVIEW 步一条（同一步既在 upcoming 又已结束不并存，scheduledAt<now 的未关闭步优先按 R6 处理还是 R5-overdue 处理【待决定】，推荐 R6，因为"面试已过未复盘"比"逾期提醒"更接近用户下一步）；同一职位多条命中各自独立成条。
- **数量上限**：**3 条**【推荐值】。超限时按 §4.1 顺序截取；被截掉的规则在标题或脚注给"+N 条其他建议"汇总入口（点击展开完整列表或仅计数——【待决定】，推荐仅计数避免第二页面）。
- **多状态同时命中**：规则间不互斥（除 R2/R7），允许同时展示；阶段不是线性解锁。

### 4.4 计算与刷新【推荐方案】

- 纯 SQL/服务层计算：在 dashboard 服务端读路径一次性取数（与 `getOverviewStats` 等并行 `Promise.all`），**打开首页不产生 AI 调用、不产生业务写入**。
- 刷新：跟随服务端渲染/路由刷新自然更新（`revalidatePath("/dashboard")` 已在职位/步骤/尝试变更 action 中调用，`application.actions.ts:309,344,385` 等）；不提供"暂时忽略/不再提示"按钮（V1 不做 dismiss 持久化）。【待决定】是否需要轻量 dismiss（本推荐不做——规则命中即真实状态，消除应通过完成业务动作）。
- 读模型归属：新建独立读模块（建议 `src/lib/career/nextActionsReadModel.ts` 或并入 `jobsReadDispatch` 同风格 dispatch），**不改写** `upcomingReadModel` 的合同；blocked 家族规则按 §4.1 门控静默不触发，不伪造状态。

### 4.5 空态【推荐方案】

- 无任何规则命中：区块整体不渲染（与 `OverviewReminders` 的"干净就不占位"一致），或渲染一条安静的成功态（"当前没有需要跟进的事项"）。【待决定】二选一；推荐**不渲染**，首页其他区块已覆盖入口功能。
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

## 5. 归档、终态、日期与时区边界【推荐方案】

- **归档**：所有 R3–R6 判定只作用于未归档实体（与 upcoming/board 口径一致）；归档职位不触发"绑定简历版本"或"复盘"建议；`loadJobsExistence` 式"含归档才算历史"的口径仅用于新旧用户判定，不用于建议。恢复后建议自然随下次读取重现，不需要专门同步。
- **已完成/取消**：Task complete/cancelled、ProcessStep COMPLETED/CANCELLED、Attempt 终态 outcome（WITHDRAWN/REJECTED/HIRED/TRANSFERRED）不产生"行动"类建议；COMPLETED 的 INTERVIEW 步恰恰是 R6 的触发源；CANCELLED 的 INTERVIEW 步不触发。
- **日期精度**：复用 `businessTimeFromColumns`/`businessTimeAttentionIso`/`isDeadlineOverdue`：DateOnly 事实当天即到期、次日才算逾期；无精度/unknown 只按日期呈现，不推断为某时刻；逾期判定统一走账户时区，不用宿主时区（冻结 DateTime 合同）。
- **用户时区**：每条规则读路径在 action 边界调用一次 `getUserTimeZone`（`timeZone.server.ts:19-25`），与 `getOverviewReminders`/`listUpcomingApplicationEvents` 同一约定；建议文案中的"今天/明天/N 天后"按账户时区分桶。

## 6. Agent 入口与普通工作台入口的关系【推荐方案】

- 首页两种入口并列但不混用：**功能卡 = 路由导航**；**Agent 入口 = 仅打开右侧面板**（`useAgentChat().open()`），不发送消息、不预填上下文、不创建会话。这与"直接操作"和"让 Agent 辅助"是两种有效选择的已确认原则一致。
- **当前只有单一 Agent**：三阶段卡的 Agent 槽位先全部落到现有面板与现有助手（不展示三个角色名，避免把 MULTI-AGENT 未实现人格写成可用能力）。MULTI-AGENT 落地后，同一槽位切换到对应角色——首页不需要为此改结构，只换打开目标。【待决定】V1 阶段卡是否显示"Ask Vocatrya"单入口还是三个角色占位（推荐单入口）。
- **不依赖未批准能力**：建议条目一律 `Link` 到真实路由；不写"让 Agent 帮你投递/复盘"等暗示工具能力的文案（match_job、任务创建、复盘写入均未批准为 Agent 工具）。首页渲染与建议点击都不产生 AI 请求（§4.4）。
- 无 AI 配置时 Agent 入口仍可点击——面板自身的 preflight/未配置态负责引导（`AgentChatProvider` 已有 preflight 机制），首页不重复造禁用态。

## 7. 可验证的验收条件（按用户场景）【推荐方案】

| 场景 | 验收条件 |
| --- | --- |
| S1 全新账号（fresh-native-full） | 首页展示 O1+O2 旅程与起点引导；各计数为真实 0/空态不伪造；点击任一阶段入口到达真实页面；建议区只有起始类建议（R1/R3/R2 视配置）；**打开首页 0 次 AI 调用、0 次业务写入** |
| S2 新用户未配置 AI | R2 建议出现并可点进设置 AI 区；工作台所有入口不被阻断；Agent 入口可打开面板并呈现面板自身的未配置引导 |
| S3 已有数据用户 | O3 按 §4.3 顺序/上限展示命中建议并正确跳转（深链参数生效：`?tab=`、`?add-*`）；O4/O5/O6 数据与 myjobs/tasks 页一致；无新手教程占位 |
| S4 真实面试已结束未复盘 | 完成 INTERVIEW 步后首页出现 R6 建议；点击落到该职位 timeline Tab；复盘保存后建议消失；CANCELLED 步不产生该建议 |
| S5 只有归档数据的用户 | 不被当成新用户（不显示起点引导）；不产生指向归档对象的 R3–R6；恢复后建议重新出现 |
| S6 多条件同时命中 | 顺序符合 §4.3；同职位多条按实体去重；超出上限时出现"+N"汇总；不出现重复跳转 |
| S7 窄窗口/窄容器 | 阶段卡 3→2→1 无横向滚动；docked Agent 面板收窄主容器后入口仍可达不重叠；<sm 时 Sheet 导航可到达全部入口 |
| S8 legacy / migrated 模式 | AB-only 规则（R4/R5/R6）不触发且不显示占位；R1/R3 按 legacy 口径判定；复盘入口降级正确；不产生 JOBS_READ_UNAVAILABLE 伪空态 |
| S9 jobs 家族 blocked | 显示 blocked 降级而非伪造数据；blocked 相关规则静默；Task/题目/练习入口可用；不显示 GettingStarted |
| S10 数据变化后 | 完成建议动作（建简历版本/记录投递/写复盘）回到首页后建议自然更新；无缓存陈旧 |

## 8. 独立实施的成果边界与文件 Owner 建议【推荐方案】

### 8.1 成果边界

本合同建议作为一个**独立实施包**交付：JOURNEY-OVERVIEW 首页重组 + NEXT-ACTIONS 规则/读模型 + 双语文案 + 定向测试。它不依赖 MULTI-AGENT、CAREER-INSIGHTS、JOB-CONNECTIONS、INTERVIEW-DEBRIEF 任何一方的完成；四者完成后首页按既有槽位增量接入，**不需要回头改本包的结构**（Agent 槽位切换、指标卡追加、复盘直达升级均为此设计）。

### 8.2 共享文件 Owner 建议

| 文件/区域 | 建议 Owner | 说明 |
| --- | --- | --- |
| `src/app/dashboard/page.tsx` | 本包 Owner | 区块编排唯一写点 |
| `src/actions/dashboard/*`（含 barrel `dashboard.actions.ts`） | 本包 Owner | 新增 next-actions/data-state 读函数 |
| 新建 `src/lib/career/nextActions*.ts` / `src/components/dashboard/*` 新组件 | 本包 Owner | 新文件无共享冲突 |
| `src/i18n/messages/zh-CN.json` + `en.json` | **共享词典单一 Owner**——建议本包 Owner 在任务期内独占写入，其他窗口不同时改 | 双语词条必须同步 |
| `src/lib/career/upcomingReadModel.ts`、`jobsReadDispatch.ts`、`overview.ts` | 复用不修改；确需扩展时先声明 | 已冻结消费者合同 |
| `src/components/agent/*` | **不改**（MULTI-AGENT Owner） | 首页仅调用 `open()` |
| `src/app/dashboard/layout.tsx`、`Sidebar.tsx`、`constants.ts` | 不改 | 导航结构不变 |
| `wiki/P2_FEATURES.json`、`P2_IMPLEMENTATION.md` | Main 集成 Owner | 状态同步在集成时 |

## 9. 待 Owner 裁定问题清单

| # | 问题 | 本合同推荐 |
| --- | --- | --- |
| D1 | O2 旅程与 O3 建议的相对顺序；窄容器下 O4 是否提前 | 旅程在前；窄容器保持顺序不变（最简单一致） |
| D2 | R2 的"AI 可用"判定 purpose：CAREER_DIALOGUE（Agent 路径）、GLOBAL_DEFAULT，还是逐 purpose | 推荐 CAREER_DIALOGUE——首页 Agent 入口的真实可用性；同时 R7 用 INVALID_ASSIGNMENT 覆盖"已配但坏" |
| D3 | R6"已结束"定义是否要求 scheduledAt 存在 | 推荐不要求（completedAt/status 足够），无排期的 COMPLETED 也提示 |
| D4 | R5/R6 边界：已逾期且未关闭的 INTERVIEW 步归谁 | 推荐归 R6（视为已发生待复盘），仍显示逾期标记 |
| D5 | 建议上限与溢出形态 | 3 条 + "+N 条其他建议"计数 |
| D6 | 是否需要 dismiss/消除机制 | V1 不做；完成业务动作即消除 |
| D7 | 空态：整块隐藏 vs 安静成功态 | 隐藏 |
| D8 | dataState 判定域是否扩展及范围 | 加 CareerMaterialItem、ResumeVariant(ab)/Resume(legacy)；是否含 ChatConversation 待 Owner |
| D9 | 阶段卡 V1 的 Agent 形态：单入口 vs 三角色占位 | 单入口（不预写 MULTI-AGENT 人格） |
| D10 | R3 legacy 口径是否保留"有职位未投递"半条 | 保留但文案区分；或 legacy 只触发"无职位"半条 |
| D11 | R4 的目标职位范围：全部活跃职位 vs 已投递职位 | 推荐"活跃未归档且未投递"——绑定版本服务于投递准备；已投递职位的版本诉求由 JOB-CONNECTIONS 处理 |

---

**授权声明**：本提案仅为评审与冻结候选；标注【推荐方案】/【待决定】的内容**不是已冻结决定**，实施前须经 Owner 逐项裁定。本文件不构成代码修改、Schema/Migration、提交、合并、推送、发布或真实数据操作授权。
