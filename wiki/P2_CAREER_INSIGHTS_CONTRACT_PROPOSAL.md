# CAREER-INSIGHTS 统计合同提案（P2 求职数据看板）

- 基线：`main @ b3219dc2`（2026-11-01 逐条源码核查；核查 Worktree `.worktrees/p2-career-insights-contract`，分支 `codex/p2-career-insights-contract`，核查时无未提交修改）
- 状态：**已冻结（2026-11-01 Owner 裁定 §8 D1–D9，见 §9 冻结记录）**。【推荐方案】已按裁定生效；本文件不授权代码修改、Schema/Migration、提交、合并、部署或真实数据操作——实施仍须各自任务授权。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行）；**【推荐方案】**＝本合同建议，未冻结；**【待决定】**＝需 Owner 裁定的产品规则。
- 上游依据：`wiki/P2_IMPLEMENTATION.md` §C5 与 `wiki/P2_FEATURES.json` CAREER-INSIGHTS（CONTRACT_PENDING / MEDIUM）；归档语义遵循已冻结 `ARCHIVE_CONTRACT_PROPOSAL.md`（D1–D8，2026-10-29）；日期/时区/精度语义遵循已冻结 `DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`（D1–D9，2026-10-27）。
- **跨合同项**：「已结束、待复盘」统一谓词由 `P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md` §9 D3 与 `P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md` §13 D6 于 2026-11-01 同次裁定生效（仅 `status === "COMPLETED"`）。本合同不重复拥有该谓词：M9「待复盘面试」在裁定生效且 §7.3 `listAwaitingReflectionInterviews` 读模型落地后接入，落地前该指标记为未覆盖、不在看板展示占位。

## 0. 范围与边界

本合同覆盖 P2 六个 Feature 中的 **CAREER-INSIGHTS**：`/dashboard/analytics` 数据看板页与首页 O5「数据简报」槽位可消费的统计指标口径——计数单位、数据来源、过滤、去重、归档口径、时间窗口、时区、零值/缺失/读取失败展示、家族（ab/legacy/blocked）能力差异与下钻目标。

**不在本合同范围**：JOURNEY-OVERVIEW 的页面组织与三阶段卡（首页合同）；NEXT-ACTIONS 的规则判定（首页合同）；JOB-CONNECTIONS 与 INTERVIEW-DEBRIEF 的 Schema 级数据合同与复盘谓词定义（窗口二合同，本合同只按 §6 接口消费其已裁定结果）；MULTI-AGENT 的三角色与面板（本合同不提供任何 Agent 工具或 AI 入口）；Schema/Migration、Activity 计时/时长统计、效率评分、AI 自动职业评分、后台分析。

**产品边界（与 P2 基线一致，不再开放讨论）**：看板服务于用户判断下一步，不堆砌指标；仅显示有可信业务来源的实际数据；空数据、样本不足、零分母和不适用的转化率必须清楚表达，不以 0% 冒充有效分析；指标计算不调用 LLM、不产生业务写入；不恢复已退役的 Activity 计时体系。

## 1. 源码事实总览

### 1.1 现有两个统计表面【源码事实】

- **首页 `OverviewMetrics` 三卡**（`src/app/dashboard/page.tsx:18-42` → `src/components/dashboard/OverviewMetrics.tsx:11-55`）：
  - `inProgress`＝进行中职位数；
  - `applied7d`＝近 7 天首次投递职位数；
  - `openTasks`＝未完成待办数。
  - 数据来源 `getOverviewStats`（`src/actions/dashboard/overview.ts:38-65`）：jobs 读家族 blocked 时只返回 `openTasks`，两卡显示 "—"（`OverviewMetrics.tsx:18-31`）。
- **看板页 `/dashboard/analytics`**（`src/app/dashboard/analytics/page.tsx:19-64`）：自上而下 `BoardTotals` 四卡、`AnalyticsPanel`（趋势/状态分布两 Tab）、`JobsCalendar` 年度热力图。
  - `BoardTotals`（`src/components/dashboard/BoardTotals.tsx:17-73`）：`total / applied / interviews / offers`，文案 `statTotal/statApplied/statInterviews/statOffers`（`zh-CN.json:337-340`）。
  - `AnalyticsPanel`（`AnalyticsPanel.tsx:46-249`）：`trend` Tab 为 7 天/30 天切换的逐日投递柱图（`getJobsActivityForPeriod(7|30)`），`status` Tab 为全时段状态分布饼图（`getJobStatusDistribution`）。
  - `JobsCalendar`（`JobsCalendar.tsx:20-113`）：近 365 天逐日投递热力图（`getJobsCalendarData`）。
  - blocked 家族下每个区块各自渲染 `JobsUnavailableNotice`（`page.tsx:46-56`、`AnalyticsPanel.tsx:160-163,264-269`），不伪造 0。

### 1.2 现有指标的精确口径【源码事实】

| 指标 | 实现 | ab 家族口径 | legacy 家族口径 |
| --- | --- | --- | --- |
| `total` 职位总数 | `loadJobsBoardTotals`（`jobsReadDispatch.ts:649-725`） | 未归档 `JobOpportunity` 行数（`:659`） | `Job` 行数（排除 `discoveryStatus=dismissed`，`:694-696`；**含** `Status.value=archived` 行——legacy 归档只是状态值） |
| `applied` 已投递 | 同上 | 未归档机会中**任一未归档 Attempt** 命中 `isAppliedAttempt`（`submittedAt` 非空 或 `currentStageCategory≠DRAFT`，`applicationFact.ts:22-30`）→ 职位级去重（`:680`） | `Job.applied=true` 且未 dismissed（`:697-699`） |
| `interviews` 面试 | 同上 | 未归档机会 ∧ 未归档 Attempt 下 `category=INTERVIEW` 的 `ProcessStep` **行数**——**不按 status 过滤**，PENDING/IN_PROGRESS/COMPLETED/CANCELLED/EVIDENCED 全计入（`:663-673`） | `Status.value="interview"` 的 Job 行数（`:702-708`）——**单位是"处于面试状态的职位"，不是面试轮次**；legacy `Interview` 实体是仅有 `createdAt/jobId/interviewers` 的存根（`schema.prisma:416-422`） |
| `offers` Offer | 同上 | 派生 uiStatus ∈ `{offer, offer-accepted}` 的未归档机会数（`isOfferUiStatus`，`uiStatus.ts:116-118`；**不含 `offer-declined`**） | `Status.value ∈ {offer, offer-accepted}` 的 Job 数（`:709-715`） |
| `inProgress` 进行中 | 同上 | 派生 uiStatus ∉ `AB_TERMINAL_UI_STATUSES`（`{archived,expired,rejected,offer-accepted,offer-declined,transferred}`，`:75-82`） | `Status.value` ∉ `LEGACY_TERMINAL_STATUS_VALUES`（`{rejected,expired,archived,offer-accepted,offer-declined}`，`:66-72`） |
| `applied7d` 近 7 天投递 | `loadDashboardJobCounts`（`:458-538`） | 按 `jobOpportunityId` 分组取 `MIN(submittedAt)` 落在窗口内的机会数（`:481-501`）——**"窗口内首次投递的职位数"**，不是投递次数 | `Job.applied=true` 且 `appliedDate` 在窗口内的行数（`:522-527`） |
| 投递趋势/热力图 | `loadJobsAppliedDateCounts`（`:540-596`） | 同一"职位首次投递日"单位按日分桶（`:551-573`） | `Job.appliedDate` 按日分组（`:576-595`） |
| 状态分布 | `loadJobStatusDistribution`（`:746-783`） | 未归档机会按**最新未归档 Attempt** 派生 uiStatus 分桶（`:753-766`） | `Job` 按 `Status.value` 分桶，含 archived 桶（`:768-782`） |
| `openTasks` 未完成待办 | `getOverviewStats`（`overview.ts:51-53`） | `Task.status ∉ {complete, cancelled}`——`needs-attention` 计入未完成 | 同左（无家族依赖） |
| 临近事项 | `getOverviewReminders`（`overview.ts:139-243`） | ≤7 天到期 Task（`dueOn`/`dueDate` 双载）+ `listUpcomingApplicationEvents` 事件，截 6 条 | ≤7 天到期 Task + `Job.dueDate`，截 6 条 |

### 1.3 关键实体与判定谓词【源码事实】

- **`JobOpportunity`**（`schema.prisma:776-836`）：`status ∈ {UNKNOWN, ACTIVE, CLOSED, EXPIRED}`（`:802`，注释明确机会本身永远不是 Interview/Offer/Rejected）；`archivedAt`；`deadline/deadlineOn/deadlinePrecision`（无 zone 列）。
- **`ApplicationAttempt`**（`schema.prisma:918-957`）：`submittedAt` 可空；`currentStageCategory` 默认 `DRAFT`，域 `ATTEMPT_STAGE = {DRAFT,SUBMITTED,SCREENING,ASSESSMENT,INTERVIEW,OFFER,CLOSED}`（`identities.ts:64-72`）；`outcome` 默认 `ACTIVE`，域 `{ACTIVE,WITHDRAWN,REJECTED,OFFER,HIRED,TRANSFERRED}`（`identities.ts:74-81`）；`archivedAt` 列存在但**无写路径**；一职位可 0..N Attempt，`transferredFromAttemptId` 记录渠道转移谱系。
- **"已投递"唯一事实谓词**：`APPLIED_ATTEMPT_WHERE`＝未归档 ∧（`submittedAt` 非空 或 `stage≠DRAFT`）（`applicationFact.ts:34-40`）；`firstSubmittedAtSql`＝未归档 Attempt 的 `MIN(submittedAt)`（`:59-66`）。窗口期统计排除 Attempt 自身 `archivedAt`、**不排除父机会归档**（`attemptInRangeWhere`，`jobsReadDispatch.ts:439-456`，已按冻结归档合同 D2 实现"历史事实保留"）。
- **派生 uiStatus**（`uiStatus.ts:23-48`）：`archivedAt` → `archived`；机会 `EXPIRED` → `expired`；否则看**最新未归档 Attempt**（`pickLatestAttempt`，`:131-136`）的 outcome/stage——`HIRED→offer-accepted`、`WITHDRAWN→offer-declined`、`REJECTED→rejected`、`TRANSFERRED→transferred`、`OFFER→offer`、stage `INTERVIEW|SCREENING|ASSESSMENT→interview`、`OFFER→offer`、`SUBMITTED 或 submittedAt→applied`、其余 `draft`。
  - **语义警示**：`offer-declined` 标签由 `WITHDRAWN` 映射（`:33`）——**撤回任何阶段的申请都会显示"offer-declined"，不等于"拒绝了 offer"**；同理 `planUiStatusWrite` 反向映射（`:104-109`）。
  - **单位警示**：uiStatus 只由**最新一次** Attempt 派生；一职位先 REJECTED 再重投 ACTIVE 时按最新 Attempt 显示，历史 outcome 不参与统计。
- **`ApplicationProcessStep`**（`schema.prisma:959-990`）：`category ∈ {SCREENING,ASSESSMENT,INTERVIEW,OFFER,ONBOARDING,OTHER}`（`identities.ts:117-124`）；`status` 常量域 `{PENDING,IN_PROGRESS,COMPLETED,CANCELLED}`（`identities.ts:97-102`），**迁移实际写入 `EVIDENCED`**（`migrator.ts:823`，不在常量集内——已核实）；三组时间三元组（`scheduledAt`+precision+zone、`deadlineAt/deadlineOn`+precision+zone、`completedAt`+precision 无 zone）。
- **Offer 事实载体**：`ApplicationOfferDetail`（`schema.prisma:1091-1100`）在 Schema 与备份中存在但**全仓无写路径**（仅 `backup/schema.ts:584`、`backup/ordering.ts` 引用）——**"收到 Offer"目前只能经 Attempt `outcome/stage` 或派生 uiStatus 表达，无独立的 Offer 事件记录**；`OFFER` 类 ProcessStep 可由用户手动创建（`QuickAddProcessStep.tsx:23`、`ProcessStepDialog.tsx:50`），非系统自动产物。
- **真实面试复盘**：`ApplicationInterviewDetail` 1:1 挂 INTERVIEW 步（`schema.prisma:1040-1056`），`reflectionText`+`reflectionItems` 已存在；`reflectionCompletedAt` 显式完成标记**不存在**（窗口二 D2 待定增量）。「待复盘」谓词＝`category=INTERVIEW ∧ status=COMPLETED ∧ 复盘未完成`（窗口二 §7.1 协调建议，待单点裁定）。
- **迁移数据形态**：每个 legacy Job → 1 个 Attempt（`submittedAt` 由 `appliedDate` 回填）+ 至多 1 个 `status="EVIDENCED"`、`source=PHASE3_CREATED_VIA` 的合成步骤（`migrator.ts:818-831`）——**迁移用户没有真实步骤历史**，只有"迁移时刻所处阶段"的证据步。
- **Task**（`schema.prisma:492-516`）：`status ∈ {in-progress,complete,needs-attention,cancelled}`（`task.model.ts:4-9`）；`dueDate/dueOn/duePrecision` 双载。
- **`InterviewSession`**（练习域，与真实面试不同实体）：不计入任何求职统计口径。

### 1.4 归档口径现状【源码事实】

- ab 活跃面（board totals、状态分布、列表）排除 `JobOpportunity.archivedAt` 非空行；legacy 的 archived 是普通状态值，board total/applied 与状态分布仍包含，inProgress 才按终态排除。不能将两家族归档口径视为一致；窗口期投递另按下一条保留历史事实。
- 窗口期投递事实保留归档父机会下的已投递 Attempt（`attemptInRangeWhere`，§1.2）——冻结归档合同 D2 已实现。
- 存在性口径 `loadJobsExistence` 计全量行含归档（`jobsReadDispatch.ts:733-744`）。
- Attempt 级 `interviews` 计数要求 Attempt 与父机会均未归档（`:666-671`）——**归档后历史面试轮次从活跃统计中消失**（与归档合同"详情只读"一致，但"累计面试轮次"若按活跃口径会回落；口径归属见 §8 D8）。

### 1.5 时区与日期精度现状【源码事实】

- **账户时区已接入**：`getOverviewReminders`（`overview.ts:143`）、`listUpcomingApplicationEvents`（`upcomingReadModel.ts:170-174` 信封携带 zone、`bucketUpcomingApplicationEvents` 按账户时区日历日分桶 `:114-152`）、Task/Job/Application 相关 action（`getUserTimeZone` 于 action 边界解析一次，`timeZone.server.ts:19-25`）。
- **账户时区未接入（真实缺口）**：`getOverviewStats` 的 7 天窗口用 `getLocalDayRange(6)`（`overview.ts:40`）、`getJobsActivityForPeriod`/`getJobsCalendarData` 用 `getLocalDayRange(7|30|365)`（`charts.ts:21,65`）——`getLocalDayRange` 以**宿主本地时区**构造日界（`shared.ts:6-30`）；`loadJobsAppliedDateCounts` 的按日分桶 `format(firstAt,"yyyy-MM-dd")` 同样走宿主时区（`jobsReadDispatch.ts:565`）。冻结 DateTime 合同 D4/§6.1 要求"分桶/显示/边界按当前账户时区解释"——投递趋势、热力图、applied7d 当前与该合同不一致；账户时区与宿主时区不同的用户会看到日界漂移。
- **精度**：`submittedAt`/`completedAt` 是 instant 事实（无精度歧义）；`scheduledAt/deadlineOn` 精度按 DateTime 合同 §3.2 规则表达；本合同指标不依赖 `scheduledAt` 精度做发生性判定（与窗口二 §7.1 一致：只依赖 status 枚举）。

### 1.6 读模型家族与运行时能力矩阵【源码事实】

- `resolveJobsReadFamily` → `ab | legacy | blocked`（`jobsReadDispatch.ts:182-201`）：`ab`＝`AB_READY_DISABLED` 或 `AB_ENABLED+full`（`jobsReadCapabilities.ts:9-15`）；fresh 起源无 AB 读能力 → `blocked`；其余 → `legacy`。运行时分派 `resolveCareerRuntimeMode`（`runtimeMode.ts:200-377`）。
- 家族能力差异：

| 能力 | ab（fresh-native-full / migrated-full / AB_READY_DISABLED） | legacy（LEGACY_ONLY / migrated 非 full） | blocked（fresh 非 full 等） |
| --- | --- | --- | --- |
| 职位级计数（total/applied/inProgress/状态分布） | ✓ JobOpportunity 派生 | ✓ Job+Status 字典 | typed blocked → "—"，不伪造 0 |
| 窗口期首次投递 | ✓ MIN(submittedAt) | ✓ appliedDate | — |
| 面试轮次计数 | ✓ ProcessStep 行数 | ✗ 无轮次实体（只能"处于 interview 状态的职位数"） | — |
| Offer 计数 | ✓ outcome/uiStatus | ✓ Status 字典值 | — |
| 待跟进事件（upcoming） | ✓ `listUpcomingApplicationEvents` | 仅 `Job.dueDate` + Task | 仅 Task |
| 待复盘谓词 | ✓（待 D2/D6 裁定 + §7.3 读模型） | ✗ 无复盘实体 | — |
| 阶段轨迹（漏斗分母分子） | 近似可推导（Attempt 当前态 + Step 记录） | ✗ 状态覆盖，无历史 | — |

- `AB_READY_DISABLED`＝AB 读面可用、canonical 写禁用：全部**读类**指标与 ab 同口径；不涉及写权。
- `jobsReadOrBlocked` 将家族 blocked 包装为类型化结果（`shared.ts:43-58`）；非 blocked 的数据库/代码错误**继续抛出**（不降级为"无数据"）——看板区分"读面不可用"与"真实读失败"。

### 1.7 已核实的缺口与既有缺陷【源码事实，仅报告不修复】

| # | 现象 | 位置/证据 | 影响 |
| --- | --- | --- | --- |
| G1 | 投递趋势/热力图/applied7d 按**宿主时区**分桶，非账户时区 | `shared.ts:6-30`、`charts.ts:21,65`、`jobsReadDispatch.ts:565`、`overview.ts:40` | 与冻结 DateTime 合同 D4/§6.1 不一致；跨时区用户日界漂移 |
| G2 | `BoardTotals.interviews` 两家族**单位不同且无标注**：ab=面试步骤行数（含未发生/已取消/EVIDENCED 合成步），legacy=处于 interview 状态的职位数 | `jobsReadDispatch.ts:663-673` vs `:702-708` | 同一数字在不同家族含义不同；ab 下把"计划了但没发生/已取消"的面试计入 |
| G3 | `offers` 不含 `offer-declined`；且 `offer-declined` 实为 WITHDRAWN 映射（撤回≠拒 Offer） | `uiStatus.ts:33,116-118`、`jobsReadDispatch.ts:682` | "Offer 数量"实际是"当前处于 offer/offer-accepted 状态的机会数"；被拒 Offer 与撤回申请不可区分 |
| G4 | `loadDashboardJobCounts` 返回的 `jobsInterview/jobsOffer/priorJobs` **无消费者** | `jobsReadDispatch.ts:502-518`；全仓无调用方使用这三字段 | 死计算；窗口内"当前处于 interview/offer 的 Attempt"口径若启用需重新裁定含义 |
| G5 | `ApplicationOfferDetail` 无写路径 | schema:1091-1100；仅 backup 引用 | 无独立"收到 Offer"事件；offer 历史只能从当前 outcome/stage 推断 |
| G6 | `JobsCalendar` 热力图 `minValue=2` | `JobsCalendar.tsx:58` | 单日 1 次投递与 ≥2 次同档渲染（nivo minValue 为色标下限），1 与 2+ 不可区分 |
| G7 | 迁移数据仅 1 条 EVIDENCED 合成步骤，无真实历史轨迹 | `migrator.ts:818-831` | migrated 账户的"曾到达某阶段"不可考；任何依赖步骤历史的口径对迁移用户系统性偏低 |
| G8 | `loadJobsBoardTotals.interviews` 不过滤 step status，CANCELLED 也计入 | `jobsReadDispatch.ts:663-673` | "面试次数"虚高于实际发生的面试 |
| G9 | `InterviewSession`（练习）与真实面试无混淆路径——**非缺陷**，确认隔离 | 窗口二 §8 | 统计口径不会误把练习当真实面试 |

## 2. 首版指标合同【推荐方案，全部待冻结】

设计原则：首版只交付**计数类**指标——单位、来源、去重可严格定义；转化率/漏斗全部延期（§3）。每项指标给：单位、数据来源（按家族）、过滤与去重、归档口径、时间窗口与时区、零值/缺失/失败展示。

### 2.1 指标总表

| # | 指标（推荐文案方向） | 单位 | 窗口 | 家族可用性 | 现状 |
| --- | --- | --- | --- | --- | --- |
| M1 | 进行中职位 | 职位 | 当前快照 | ab / legacy | 已有（`inProgress`） |
| M2 | 已投递职位（累计） | 职位 | 全部时间 | ab / legacy | 已有（`applied`） |
| M3 | 窗口内首次投递职位 | 职位 | 近 7/30 天 | ab / legacy | 已有（`applied7d`+趋势） |
| M4 | 面试轮次 | 面试轮次 | 全部时间（活跃面） | 仅 ab；legacy 降级 | 已有但口径需修正（G2/G8） |
| M5 | Offer 机会 | 职位 | 当前快照 | ab / legacy | 已有但口径需标注（G3） |
| M6 | 待跟进事项 | 事项 | 今天起 ≤7 天+逾期 | ab / legacy（Task 两家族） | 半新（复用 reminders/upcoming） |
| M7 | 未完成待办 | 任务 | 当前快照 | 无家族依赖 | 已有（`openTasks`） |
| M8 | 职位状态分布 | 职位 | 当前快照 | ab / legacy | 已有 |
| M9 | 待复盘面试 | 面试轮次 | 当前快照 | 仅 ab（含 READY_DISABLED 读面） | **依赖项**：D2/D6 裁定 + §7.3 读模型落地后接入 |

### 2.2 M1 进行中职位

- **口径**：未归档职位中，派生状态非终态者计数。ab＝`loadJobsBoardTotals.inProgress`（uiStatus ∉ `AB_TERMINAL_UI_STATUSES`）；legacy＝`Status.value` ∉ `LEGACY_TERMINAL_STATUS_VALUES`。
- **单位/去重**：职位级；一职位无论几次 Attempt 计 1。
- **归档**：活跃口径，排除归档（与 board 现状一致）。
- **展示**：整数；blocked → "—"+Notice；下钻 `/dashboard/myjobs`。
- **语义注记**：ab 下 `transferred`/`offer-declined(=WITHDRAWN)` 按终态排除；legacy 无 transferred 概念。

### 2.3 M2 已投递职位（累计）

- **口径**：全部时间内"曾真实投递"的职位数。ab＝未归档机会中任一未归档 Attempt 命中 `isAppliedAttempt`（沿用 `applicationFact` 唯一谓词，不重造）；legacy＝`Job.applied=true` 且未 dismissed。
- **单位/去重**：职位级。"投递次数（Attempt 级）"作为**附加裁定指标 M2b**（`db.applicationAttempt.count({ where: { userId, ...APPLIED_ATTEMPT_WHERE, jobOpportunity: { userId, archivedAt: null } } })`，ab only；legacy 无 Attempt 实体，只能复用 M2 职位计数并标注“无独立申请次数”，不得将其声称为真实申请级统计）——P2 基线同时提了"实际投递次数/申请数"，两个单位含义不同，由 Owner 决定展示哪个或都展示（§8 D1）。
- **归档**：活跃口径（与现 board `applied` 一致）。**【待决定】**是否同时提供"含归档的历史累计"口径——归档合同已冻结"窗口期投递保留事实"，但"全部时间已投递职位数"目前排除归档职位；若用户归档了已投递职位，累计数回落。推荐保持活跃口径并在指标文案/脚注标注"不含已归档职位"（§8 D8）。
- **下钻**：`/dashboard/myjobs?filter=applied`（两家族均支持 `applied` 过滤归一化，`jobsReadDispatch.ts:318-324`）。

### 2.4 M3 窗口内首次投递职位

- **口径**：窗口 `W` 天（推荐 7 与 30 两档，沿用现有切换）内，**首次投递日**落在窗口内的职位数——ab＝`MIN(submittedAt)` 分组（现实现）；legacy＝`appliedDate` 在窗口内。
- **单位**：职位。同一职位窗口内多次补投只计 1（按首次投递）；同一职位窗口外投递过、窗口内再次投递**不计**（窗口成员由 MIN 决定——现实现语义）。
- **时区**：窗口边界与按日分桶必须按**账户时区**（DateTime 合同 D4）——现实现用宿主时区（G1），本合同推荐随本指标修正（§8 D4）；`submittedAt` 是 instant 事实，不存在精度歧义。
- **展示**：柱图逐日值+窗口合计；窗口内全 0 → 已有空态文案 `noApplicationsInWindow`；blocked → Notice。
- **下钻**：`/dashboard/myjobs?filter=applied`。

### 2.5 M4 面试轮次

- **口径（推荐）**：拆两个并列计数，替代现 `interviews` 单值——
  - **M4a 已进行面试轮次**：`category=INTERVIEW ∧ status=COMPLETED` 的 ProcessStep 数，Attempt 与父机会均未归档。迁移 EVIDENCED 步的处理随窗口二 §13 D6「已结束」谓词裁定一并确定（推荐：语义确认前**不计入**，并在脚注标注"早期迁移记录不参与轮次统计"）；CANCELLED/PENDING/IN_PROGRESS 不计。
  - **M4b 计划/进行中面试轮次**：`category=INTERVIEW ∧ status ∈ {PENDING,IN_PROGRESS}` 且 Attempt/机会未归档的 ProcessStep 数——"在流程中的面试安排"。
- **单位**：轮次（一次面试事件=一条 INTERVIEW 步），与"面试相关职位数"不同单位；**不推荐**首版用职位级"面试中机会"替代轮次（派生 uiStatus=interview 已由 M8 状态分布覆盖）。
- **家族**：仅 ab；legacy 无轮次实体，降级展示为"当前处于面试状态的职位数"并明确文案区分，或该指标整块降级为不可用说明（§8 D2）；blocked → "—"。
- **展示**：M4a/M4b 并列两数；全 0 → 真实 0（不隐藏）；下钻 `/dashboard/myjobs?tab=upcoming`（ab）或 `/dashboard/myjobs`（legacy）。

### 2.6 M5 Offer 机会

- **口径（推荐）**：沿用 `isOfferUiStatus(deriveOpportunityUiStatus(opportunity))`：未归档职位按最新未归档 Attempt 派生 uiStatus，且结果为 `offer` 或 `offer-accepted`。必须保留机会 EXPIRED 及 Attempt WITHDRAWN/REJECTED/TRANSFERRED 等状态的优先级，不能用 outcome/stage 简单 OR 替代——即现 `isOfferUiStatus` 口径的显式化："**当前处于 Offer 阶段的机会数**"。文案必须表达"当前"（快照），不得暗示"累计收到 Offer 数"。
- **已知语义边界（标注）**：① `offer-declined`/WITHDRAWN 不计入——历史上拿过 Offer 又撤回/拒绝的机会不体现（G3）；② 无独立 Offer 事件（G5），"曾收到 Offer"不可推导，首版不宣称该口径；③ legacy 为 `Status.value ∈ {offer, offer-accepted}` 同义。
- **下钻**：`/dashboard/myjobs`（无现成 offer 过滤器，ab 过滤器隐藏值集合为 `accepted|dismissed`，`jobsReadCapabilities.ts:5`——下钻到全列表即可，不做假过滤参数）。

### 2.7 M6 待跟进事项

- **口径（推荐）**：`overdue + today + next7Days` 三桶合计的事件事数——ab＝`listUpcomingApplicationEvents`（复用 `bucketUpcomingApplicationEvents`，账户时区，已冻结信封）；legacy＝`Job.dueDate` 未终态到期项 + ≤7 天到期 Task；两家族均叠加"≤7 天到期未完成 Task"（复用 `getOverviewReminders` Task 分支口径）。
- **单位**：事项（一个投递截止或一条流程步骤=一事；一条 Task=一事）。去重：同一步骤只产生一个 upcoming 事件（读模型保证）；Task 与申请事件分别计数不互斥。
- **展示**：总数+其中逾期数（"N 项待跟进，含 M 项已逾期"）；0 → 不渲染或显示 0（随所在卡片）；blocked → 仅 Task 部分可见则只显示 Task 数并标注（§8 D7）。
- **与 OverviewReminders 的关系**：reminders 是截 6 条的**列表**；legacy `loadUpcomingJobDeadlines` 内部还截 5 条（`jobsReadDispatch.ts:819`）。M6 是**计数**，不能用这些截断列表求和。推荐在本包读模型中新增未截断的 legacy deadline count/query，保留 userId、dueDate 上界、非终态及 NOT_DISMISSED 过滤；不设下界以纳入逾期，并对有效 dueDate 按账户时区计算逾期。Task 同样使用未截断结果。读模型返回 `{ total, overdueCount }` 不受截断影响（与窗口二 §7.3 `totalCount` 同构）。

### 2.8 M7 未完成待办

- 沿用现口径：`Task.status ∉ {complete,cancelled}`；无家族依赖；blocked 家族下仍可用（现 `getOverviewStats` 行为）。
- 下钻 `/dashboard/tasks`。

### 2.9 M8 职位状态分布

- 沿用现 `loadJobStatusDistribution`：当前快照分桶。ab 按派生 uiStatus；legacy 按 `Status.value`（含 archived 桶——legacy 归档本来就是状态值）。
- **【待决定】** `transferred`/`offer-declined` 标签在 ab 分布中的显示文案（`getLocalizedJobStatus` 现状）——"offer-declined" 文案若写作"已拒 Offer"属误导（实为撤回），建议文案改为中性"已撤回/已结束"方向（§8 D3）。

### 2.10 M9 待复盘面试（条件指标）

- **口径**：窗口二 §7.1 谓词 `awaitingReflection`＝INTERVIEW ∧ COMPLETED ∧ 复盘未完成；数据源唯一＝`listAwaitingReflectionInterviews` 的 `totalCount`（窗口二 §7.3）。
- **接入条件（缺一不可）**：① 跨合同 D3/D6 裁定生效；② D2 裁定落地（D2-a 需 `reflectionCompletedAt` 列 + P-A 读模型；D2-b 用派生谓词）；③ §7.3 读模型实现。任一未就绪 → **指标不渲染、不显示占位、验收记未覆盖**——不得用"detail 存在且有内容"等临时口径替代（与首页 R6 同规则）。
- **家族**：仅 ab（含 AB_READY_DISABLED 读面）；legacy/blocked 不展示。
- **下钻**：`/dashboard/myjobs/{jobOpportunityId}?tab=timeline`（取读模型首条 item）。

## 3. 转化率与漏斗：可推导性评估与延期结论【推荐方案】

### 3.1 逐项评估【源码事实+分析】

| 转化 | 分子 | 分母 | 可推导性 |
| --- | --- | --- | --- |
| 投递→面试 | 有 ≥1 `INTERVIEW` 步（status 口径待定：COMPLETED 或排除 CANCELLED）的**已投递 Attempt/职位** | 已投递 Attempt/职位 | **ab 近似可推导**：步骤记录是"曾到达面试"的证据，但（a）`currentStageCategory` 只存当前态，历史推进无独立事实；（b）用户可不建步骤直接改 stage/outcome——无 INTERVIEW 步不代表没面过；（c）迁移数据只有 EVIDENCED 合成步（G7），对 migrated 用户系统性失真；**legacy 不可推导**（Status 覆盖无历史） |
| 面试→Offer | outcome `OFFER/HIRED` 或 stage `OFFER` 的 Attempt | 有面试证据的 Attempt | 同上加难：`outcome` 是当前值非事件，"曾收 Offer 后被拒/撤回"无记录（G5）；OFFER 步骤可选可不建 |
| 投递→Offer | 同上分子 | 已投递 Attempt/职位 | 分子口径同前；比例在样本小且无"曾收"口径时易误导 |
| Cohort 追踪（"近 30 天投递职位的后续进展"） | 窗口内首次投递集合的当前/历史状态 | 该集合 | 需要按 `MIN(submittedAt)` 队列回查步骤/状态——可实现但语义复杂（状态回读是当前快照而非窗口内进展），首版解释成本高于价值 |

### 3.2 延期结论

- **首版不交付任何转化率/漏斗**【推荐】。理由：(a) 所有分子分母只能近似，且 ab 与 legacy 能力不对称，展示一个"看似精确"的比率违反 P2"不能将面试轮次数直接除以职位数"的已确认口径；(b) 迁移用户数据无步骤历史（G7），比率对新老用户含义不同；(c) `offer-declined=WITHDRAWN` 语义偏移（G3）使 offer 侧口径必须先经 D3 裁定。
- **若 Owner 坚持首版要一个转化数字**（§8 D6 备选）：唯一推荐候选是"已投递职位中，当前有≥1条 PENDING/IN_PROGRESS INTERVIEW 步的职位占比"（ab only、职位级、分子分母同源、明确标注"当前快照、非历史转化"）——即使如此也建议命名为"面试进行中占比"而非"转化率"。
- 不做：任何跨窗口 cohort、平均时长（如投递→首面天数）、响应率、Activity 类效率统计。

## 4. 展示合同【推荐方案】

### 4.1 布局与归属

- `/dashboard/analytics` 继续作为**指标主表面**：M1/M2/M3/M4a/M4b/M5/M6/M7/M8（+条件 M9）；现有 BoardTotals→AnalyticsPanel→JobsCalendar 结构保留，指标文案按 §2 修正。
- 首页 O5「数据简报」槽位（首页合同 O5）**复用同一读模型**，只取 M1/M3/M7 三卡现状或按首页 Owner 裁定扩展——本合同**只提供读函数与口径，不决定首页卡片组合**。
- 下钻一律 `Link` 真实路由；无现成过滤器的目标落到列表页（§2.6）。

### 4.2 零值、零分母、缺失与失败

- **零值**：计数指标显示真实 `0`；趋势/分布整窗为 0 时用现有空态文案（`noApplicationsInWindow`/`noStatusData`）——0 是有效事实不是缺失。
- **零分母/不适用**：首版无比例指标（§3），自然无零分母展示；若 D6 例外批准"面试进行中占比"，分母为 0 时显示"暂无已投递职位"，**不显示 0%**。
- **blocked 家族**：jobs 相关指标整块 "—"+`JobsUnavailableNotice`（现有语义）；Task-only 指标（M7）不受影响；M6 在 blocked 下只显示 Task 部分并标注范围（§8 D7）。
- **读失败**：非 blocked 异常继续向上抛（`jobsReadOrBlocked` 只吞 `JOBS_READ_UNAVAILABLE`）——**不把读失败显示成"无数据"**；页面级错误边界处理。
- **未知状态**：`EVIDENCED` 等非常量 status 在 M4a 中按"非 COMPLETED"处理（不误报），文案脚注说明迁移记录口径；legacy 仅在 statusId 无匹配字典项时落入 `unknown` 桶；已有自定义字典 value 原样保留（现 `loadJobStatusDistribution` 行为）。
- **口径标注**：ab/legacy 单位不同的指标（M4）在 UI 用文案区分（"面试轮次" vs "面试中职位"）；M5 文案含"当前"；M2 脚注"不含已归档职位"（若 D8 批准）。

### 4.3 时间窗口与时区

- 所有窗口边界、按日分桶、逾期判定按**账户时区**（`getUserTimeZone` 于 action 边界解析一次传入；DateTime 合同 D4/§6.1）——含对 G1 的修正（§8 D4 只裁定实施顺序，不重新开放时区语义）。
- `submittedAt`/`completedAt` 为 instant 事实直接参与窗口比较；`deadlineOn` DateOnly 事实按 `dateOnlyUtcWindow` 展开；历史 `unknown` 精度不推断。
- 时区切换后窗口统计按新时区重解释（DateOnly/日历语义），instant 事实本身不变——与冻结合同一致，无需额外处理。

## 5. 与其他合同的接口与文件 Owner【推荐方案】

### 5.1 接口边界

| 对方 | 本合同消费 | 本合同提供 | 不重叠声明 |
| --- | --- | --- | --- |
| 首页/下一步合同（概览 Owner） | O5 槽位形态、`jobsReadOrBlocked` 降级语义、R6 消费规则 | 指标读函数（`getCareerInsights` 类 action + 读模型）供 O5 追加卡片调用 | 本合同不改 `dashboard/page.tsx` 区块编排、不定义建议规则；首页不自行重算指标口径 |
| 职位/复盘合同（窗口二 Owner） | §7.1 `awaitingReflection` 谓词结果、§7.3 `AwaitingReflectionResult`（仅 `totalCount`+首 item 路由参数） | 无（只读消费） | 谓词与读模型由窗口二拥有；本合同不重算、不补谓词、不用内容存在性过渡 |
| 三 Agent 合同 | 无 | 无 | 看板不提供 Agent 入口/工具；统计不触发 AI |
| 归档合同（已冻结） | 活跃口径排除归档、窗口期保留事实（D2 已实现）、存在性计全量 | 无 | 口径差异仅作 UI 标注（D8），不改冻结语义 |
| DateTime 合同（已冻结） | 账户时区分桶/边界/显示规则 | 无 | G1 修正按冻结规则执行，不改 `src/lib/datetime` |

### 5.2 共享物理文件 Owner 建议

| 文件/区域 | 建议 Owner | 说明 |
| --- | --- | --- |
| 新建 `src/lib/career/careerInsightsReadModel.ts` | 本包 Owner | 新文件无共享冲突；复用 `jobsReadDispatch`/`upcomingReadModel`/`applicationFact` 可用导出，不改其消费者合同。投递趋势与热力图不得将 `loadJobsAppliedDateCounts` 已按宿主日合并的结果重新分桶；应在本包读模型按相同 userId/归档/首次投递谓词查询原始 MIN(submittedAt)（legacy 为 appliedDate）后按账户时区分桶。若改用 dispatch 时区扩展，须先交接该文件 Owner |
| `src/actions/dashboard/` 新增 `insights.ts` + barrel `dashboard.actions.ts` 增补导出 | **顺序交接**：首页合同已将 `src/actions/dashboard/*` 列为其 Owner；本包只新增独立文件，barrel 追加行由主协调指定顺序（推荐：首页包合入后本包追加，或反之） | 避免两包同改一个 barrel |
| `src/app/dashboard/analytics/page.tsx`、`AnalyticsPanel.tsx`、`BoardTotals.tsx`、`JobsCalendar.tsx` | 本包 Owner | 看板主表面，现无其他包认领；G1/G6 修正随本包 |
| `src/actions/dashboard/shared.ts`（如需账户时区窗口 helper） | 主协调指定（首页包共用文件） | `getLocalDayRange` 语义变更影响 `getOverviewStats`——推荐**不改**该函数，新 helper 放本包读模型内 |
| `jobsReadDispatch.ts`、`upcomingReadModel.ts`、`applicationFact.ts` | 复用不修改（Owner 分别为 Job UX/主集成） | 确需扩展时由文件唯一 Owner 顺序处理 |
| `src/i18n/messages/zh-CN.json` + `en.json` | **共享词典单一 Owner**（主协调指定），各包提交键清单顺序整合 | 指标名/脚注/降级文案双语同步 |
| `src/actions/dashboard/overview.ts`（G1 若裁定同步修 applied7d） | 首页合同已列为首页包 Owner | 推荐 applied7d 时区修正由本包读模型内联处理或经主协调交接，**不并行改** |
| `wiki/P2_FEATURES.json`、`P2_IMPLEMENTATION.md`、`wiki/index.md` | Main 集成 Owner | 状态同步与索引登记在集成时 |

## 6. 一个完整开发成果的范围、依赖与验收矩阵【推荐方案】

### 6.1 成果边界（单一任务）

本合同建议作为**一个独立开发任务**交付：`/dashboard/analytics` 看板指标口径修正（M1–M8）+ 新读模型 + 按冻结 DateTime 合同统一时区（D4 决定顺序）+ 文案/脚注标注 + 下钻接线 + 双语文案 + 定向测试——同一 Coding Owner、同一 Worktree。**不含**：Schema/Migration、复盘读模型实现（窗口二 P-A）、首页结构改动、M9 之外的任何复盘逻辑、Activity 类指标、Agent 改动。M9 为条件指标，前置未就绪时按 §2.10 静默并记录未覆盖，不阻塞其余指标交付。

### 6.2 依赖与可并行性

- **无 Schema 依赖**：全部指标基于现有列。
- **可与首页包并行**：首页 O5 只消费本包读函数签名（接口先冻结）；区块编排归首页 Owner。
- **可与窗口二 P-A/P-B 并行**：M9 之前的全部内容不依赖复盘增量。
- **必须等待**：M9 ← 跨合同 D3/D6 + D2 裁定 + §7.3 读模型落地（同首页 R6 前置）。
- **串行约束**：`src/actions/dashboard` barrel、i18n 词典按 §5.2 顺序交接；桌面重型验证仍由主协调统一串行调度。

### 6.3 可观察验收矩阵（定义用，不执行）

| # | 场景 | 通过标准 |
| --- | --- | --- |
| V1 | 合成数据：1 职位 2 次投递（不同日）、1 职位 3 轮面试（1 COMPLETED/1 PENDING/1 CANCELLED）、1 个 OFFER Attempt、归档 1 个已投递职位 | M1–M5/M8 数值与 §2 口径逐条一致：M3 按首次投递计 1；M4a=1、M4b=1（CANCELLED 不计）；归档职位不进活跃口径 |
| V2 | 窗口边界与时区：账户时区 ≠ 宿主时区，`submittedAt` 落在日界 ±2h 内 | M3 及趋势/热力图分桶按账户时区（遵循已冻结 DateTime 合同）；与 `getOverviewReminders` 桶语义一致 |
| V3 | 归档往返：投递→归档→看板→恢复→看板 | 归档期间活跃口径回落、窗口期投递事实保留（D2）；恢复后全部口径回归；无不一致残影 |
| V4 | 零值与空态：全新账号 / 有职位无投递 / 有投递无面试 | 计数显示真实 0 或对应空态文案；无 "—" 误用、无伪示例数 |
| V5 | blocked 家族（fresh 非 full） | jobs 指标 "—"+Notice；M7 正常；M6 仅 Task 部分并标注；不产生 JOBS_READ_UNAVAILABLE 伪空态 |
| V6 | legacy 家族 | M1–M3/M5/M7/M8 按 legacy 口径；M4 按 §8 D2 裁定形态降级；无 ab-only 概念泄漏（无轮次/无复盘/无 upcoming tab） |
| V7 | migrated-full：含 EVIDENCED 合成步与无步骤 Attempt | M4a 不含 EVIDENCED（按裁定）；其余指标正常；无不一致 |
| V8 | 读失败注入（非 blocked 异常） | 页面错误边界生效，不显示"无数据"假象 |
| V9 | M9 条件指标：D2/D6 就绪后 | 仅消费 `listAwaitingReflectionInterviews.totalCount`；归档职位不计；未完成标记前不重算谓词；未就绪时区块缺失且无占位 |
| V10 | 多家族回归矩阵 | fresh-native-full / migrated-full / AB+resume_v1 / LEGACY_ONLY / blocked 各形态下指标可用性与 §1.6 矩阵一致 |
| V11 | 无 AI/无写入 | 打开看板 0 次 AI 调用、0 次业务写入 |
| V12 | 下钻 | 各指标跳转真实路由；`?filter=applied`、`?tab=upcoming`（ab）生效；legacy 下不出现无效参数目标 |

### 6.4 最小充分验证（按影响选择）

- 类型检查 + 改动文件 ESLint（项目既有命令）。
- 定向单测/隔离库读模型测试：M1–M8 口径矩阵（多 Attempt、多轮次、CANCELLED/EVIDENCED、归档父机会、时区分桶、零值、blocked 降级、legacy 家族）。
- i18n 双语键同步核对。
- **明确 NOT_RUN**（除非另行授权）：生产 Build、真实 Electron、完整 E2E、真实 AI、真实数据操作——桌面集中验收由主协调窗口另行指定执行者。本包无 AI 路径。

## 7. 待核实/待协调项汇总

| 项 | 现状 | 需要 |
| --- | --- | --- |
| EVIDENCED status 语义 | 迁移实际写入（`migrator.ts:823`），不在常量集；M4a 推荐不计 | 窗口二 §13 D6 同项裁定后一并确认 |
| `offer-declined` 标签 | 实为 WITHDRAWN 映射（`uiStatus.ts:33`） | D3 裁定展示文案；改标签不改映射语义 |
| `jobsInterview/jobsOffer/priorJobs` 死字段 | 无消费者（G4） | 本包不启用；若 D6 需要窗口内阶段计数另行裁定口径 |
| `ApplicationOfferDetail` 无写路径 | 仅 schema/backup（G5） | 本期不接线；"曾收 Offer"口径随之不可达 |
| 首页 O5 卡片组合 | 现三卡；追加哪些指标 | 首页 Owner 随 O5 裁定；本合同只供读函数 |
| G6 热力图 `minValue=2` | 1 与 ≥2 同档渲染 | 实现期顺手修正（minValue=1 或动态），不构成独立裁定项 |

## 8. 待 Owner 裁定问题清单

每项给互斥选项与本合同推荐；裁定后即可按冻结合同实施。

| # | 问题 | 选项（互斥） | 本合同推荐 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | "已投递"计数单位 | A) 职位级为主+申请次数（Attempt 级）辅助指标并列；B) 仅职位级；C) 仅申请级 | A | A 同时覆盖"投了多少岗位"与"投了多少次"；legacy 下申请级自动降级同职位级 |
| D2 | M4 面试指标口径与 legacy 形态 | A) M4a 已完成轮次+M4b 计划中轮次（ab），legacy 降级为"面试中职位数"并标注；B) 仅 M4a，legacy 整块不显示；C) 维持现单值轮次计数不修 | A | A 区分"面过"与"排了"且对 legacy 诚实；C 保留 G2/G8 误导 |
| D3 | Offer 口径与 `offer-declined` 文案 | A) M5="当前 Offer 阶段机会"（现 isOfferUiStatus），文案含"当前"；`offer-declined` 分布标签改中性"已撤回/已结束"；B) 同 A 但另加"含被拒 Offer"尝试口径；C) 维持现状 | A | B 的"曾收 Offer"无事实载体（G5）不可兑现；C 保留语义误导 |
| D4 | G1 修复实施顺序（账户时区语义已冻结） | A) 随本包统一 applied7d/趋势/热力图；B) 原 Owner 先修，本包再复用，未修前相应验收记 BLOCKED | A | 不提供保持宿主时区作为合规选项；本包新增原始事实查询或向唯一 dispatch Owner 顺序交接，不能对宿主日聚合结果重分桶 |
| D5 | 看板默认时间范围 | A) 现状组合（计数=当前快照/全部时间；趋势=7d/30d 切换）；B) 增加自定义范围选择 | A | B 引入筛选状态管理与口径复合，超首版价值 |
| D6 | 首版是否交付任一转化类数字 | A) 全部延期（§3.2）；B) 仅"已投递职位中面试进行中占比"（ab only、明确标注快照口径）；C) 完整漏斗 | A | B 是唯一可严格定义的候选但仍易被读作转化率；C 不可推导 |
| D7 | M6 待跟进口径与 blocked 形态 | A) overdue+today+next7 合计+逾期计数，blocked 下仅 Task 部分并标注；B) 仅 next7 不含逾期；C) 不展示该指标 | A | A 与 upcoming 桶语义一致；blocked 标注防误读 |
| D8 | 累计指标的归档口径标注 | A) 活跃口径排除归档+指标脚注标注"不含已归档职位"；B) 加"含归档历史累计"并列数；C) 不标注 | A | A 符合归档合同且语义透明；B 双口径增加解释成本可后续加 |
| D9 | M9 待复盘接入方式 | A) 就绪后接入（§2.10 三条件）；B) 首版不做；C) 用 detail 内容存在性过渡 | A | C 与首页 R6 禁令相同——不得伪造完成谓词；B 会丢失已确认的旅程价值 |

---

**授权声明**：§8 D1–D9 已于 2026-11-01 经 Owner 逐项裁定冻结；§8 D2（M4 中 EVIDENCED 处理）与 §8 D9（M9 接入）的跨合同前置（`P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md` §13 D2/D6、`P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md` §9 D3）已同次裁定生效，M9 剩余前置为 §7.3 读模型落地。本文件不构成代码修改、Schema/Migration、提交、合并、推送、发布或真实数据操作授权——实施仍须各自任务授权。

## 9. Owner 裁定冻结记录（2026-11-01）

Owner 于 2026-11-01 逐项裁定 §8 D1–D9，全部按推荐项生效。裁定依据：只读源码备料（`.tmp/p2-career-insights-decision-prep/`）与合并总表（`.tmp/p2-decision-merge/owner-decision-pack.md`），核实基线 `main @ 55d5a4a9`。

| # | 裁定结果 |
| --- | --- |
| D1 | A："已投递"以职位级为主 + Attempt 级申请次数辅助指标并列（ab）；legacy 降级为同职位级标注 |
| D2 | A：M4a 已完成轮次 + M4b 计划中轮次（ab）；legacy 降级"面试中职位数"并标注；`EVIDENCED` 按非 COMPLETED 不计入（随面试 §13 D6 裁定）；`statInterviews` 标签随本项 i18n 包改为不误导口径；migrated-full 用户 M4a 系统性偏低以脚注披露（G7） |
| D3 | A：M5＝"当前 Offer 阶段机会"（现 `isOfferUiStatus`），文案含"当前"；`offer-declined` 分布标签改中性（"已撤回/已结束"方向），只改显示层不改映射语义 |
| D4 | A：G1 随本包统一修复（applied7d/趋势/热力图按账户时区）；不改共享 `getLocalDayRange`（首页包共用），applied7d 所在文件跨包交接一次 |
| D5 | A：看板默认维持现状组合（计数＝当前快照/全部时间；趋势＝7d/30d 切换） |
| D6 | A：首版转化类数字全部延期，不交付任一比例指标 |
| D7 | A：M6＝overdue+today+next7 合计 + 逾期计数；blocked 下仅 Task 部分并加范围标注；新增未截断计数查询 |
| D8 | A：累计指标按活跃口径排除归档 + 脚注"不含已归档职位" |
| D9 | A：M9 就绪后接入——§2.10 三条件缺一不可，未就绪不渲染不占位、验收记未覆盖；跨合同前置已裁定生效，剩余前置为 §7.3 读模型落地 |

**附随裁定**：`JobsCalendar` `minValue={2}` 分档重叠（G6）列为实现期顺手修正；`jobsInterview`/`jobsOffer`/`priorJobs` 死字段（G4）本期不启用。
