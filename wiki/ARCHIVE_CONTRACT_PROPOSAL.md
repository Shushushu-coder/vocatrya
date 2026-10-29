# BD-ARCHIVE 实施合同提案（修订稿，待 Owner 冻结）

- 基线：`main @ 1410b8e0`
- 性质：实施合同设计稿。本文不含代码改动；所有"推荐方案"与"Owner 待决定项"在冻结前不构成产品规则。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行）；**【推荐方案】**＝本合同建议；**【待决定】**＝需 Owner 冻结的产品规则。
- 本轮变化：提醒策略改为"核查事实 + 最小方案比较"；统计口径拆分为三类分别定义；Legacy 边界给出能力矩阵；实施包按完整用户成果重组；决策清单分离产品规则与技术选择。

## 1. 范围与冻结边界

已冻结范围（用户指令）：

- 首批归档对象仅两类：**职位**与 **AI 对话历史**。
- 入口固定为：**设置 → 数据与支持 → 归档数据**。
- 归档＝可逆的可见性管理：长期保留、随时恢复、不自动过期。
- 不建设 30 天回收站；不物理删除职位、投递事实、关联记录或对话消息。
- 归档、恢复、现有删除三者语义必须清楚区分。

本合同不覆盖：简历版本、招聘批次、职业素材、AI 连接等已有 `archivedAt` 字段模型的产品化归档（后续批次）；InterviewSession、QuestionBank 等其他实体的归档。

## 2. 源码事实总览

### 2.1 两套职位数据家族并存【源码事实】

- **Canonical（A+B）`JobOpportunity`**：有 `archivedAt DateTime?`（`prisma/schema.prisma:801`）。`archivedAt` 参与 UI 状态派生：最高优先级输出 `"archived"`（`src/lib/career/uiStatus.ts:28`；SQL 派生 `jobOpportunityAdapter.ts:634`）。
- **Legacy `Job`**：**无 `archivedAt`**。Legacy"归档"是 `JobStatus` 字典值 `value="archived"` 的状态（`src/lib/data/jobStatusesData.ts:50-54`），改状态即覆盖原状态，**不可精确恢复、无时间戳**。
- 读家族由 `resolveJobsReadFamily` 分发为 `ab` / `legacy` / `blocked`（`jobsReadDispatch.ts:182-201`）。任何归档合同必须按家族分别定义行为。

### 2.2 Canonical 职位已有局部归档能力，但不是产品功能【源码事实】

- 列表：`listOpportunitiesAsJobs` 默认 `o.archivedAt IS NULL`；`filter="archived"` 时改为 `IS NOT NULL`（`jobOpportunityAdapter.ts:683-688`），可与搜索/公司/标题等组合（725-736）。
- 详情：`getOpportunityAsJob` 按 `id+userId` 读取，**不排除归档行**——直接 URL 仍可打开。
- 写入：AB 运行时下 `deleteJobById` 实际走 `archiveOpportunity`（`mutations.ts:430-434`、`jobOpportunityAdapter.ts:347-355`）；`syncApplicationFromUiStatus` 对 `"archived"` 同样写该列（`jobOpportunityAdapter.ts:188-191`）。**只写机会行，不级联写 Attempt**。
- UI：AB 模式"删除"按钮已显示为"归档"（`deleteIsArchive`：`MyJobsTable.tsx:165`、`MyJobsGrid.tsx:57`、`JobDetails.tsx:404`）。
- **没有恢复路径**：全仓无 unarchive/restore 写路径，无归档列表 UI，`JobsToolbar` 筛选无 archived 选项。
- 结论：`archivedAt` + 局部读模型 + 隐藏式归档写入 ≠ 已实现。现状是"能归档、不能恢复、无中心"。

### 2.3 Legacy 职位归档现状【源码事实】

- 归档＝`statusId` 改为字典值 `"archived"`，原状态被覆盖、无时间戳。
- `buildLegacyJobsWhere` **不排除 archived 状态**：归档职位仍在普通列表，仅 badge 区别；`filter` 可透传 `Status.value` 查询（`jobsReadDispatch.ts:225-266`）。
- Legacy "in progress" 统计把 `archived` 列入终态（`LEGACY_TERMINAL_STATUS_VALUES`，`jobsReadDispatch.ts:66-72`）；Legacy deadline 提醒排除该状态（`shared.ts:134-140`，即 `JOB_DUE_TERMINAL_STATUS_VALUES`）。
- Legacy `deleteJobById` 是 `prisma.job.delete` **物理删除**（`mutations.ts:437-442`）——同一按钮在两家族下语义不同。

### 2.4 统计/读模型现状【源码事实】

按三类口径区分（这是 §8 D2 的事实基础）：

- **活跃职位口径**（"现在还在跟进什么"）：Board totals 只统计 `archivedAt:null`（`jobsReadDispatch.ts:656`）；Interview 计数要求 Attempt 与机会均未归档（661-670）；`loadJobStatusDistribution` 排除归档（752）；`loadRecentJobs`/`listOpportunitiesAsJobs` 默认排除。→ 归档排除是**正确语义**，本合同不改变。
- **窗口期投递事实口径**（"近 N 天投递了几份"）：`attemptInRangeWhere` 同时排除 `archivedAt`（Attempt 自身）与 `jobOpportunity.archivedAt`（父机会）（`jobsReadDispatch.ts:439-452`），被 `loadDashboardJobCounts`（464-488）与 `loadJobsAppliedDateCounts`（548-557）复用。→ **归档已投递职位会让窗口期投递数与热力图回落**——把"曾发生的事实"当成了"当前可见状态"。
- **历史存在性口径**（"用户是否有记录"）：`loadJobsExistence` 统计**全部**机会含归档（737-738），防止 Dashboard 误判新用户。→ 已正确。
- Legacy 家族：Board totals 含 archived 行（691-721）、状态分布含 archived 桶、普通列表不排除 archived——Legacy 的归档本来就**不改变统计**（它只是个状态值）。

### 2.5 提醒状态机现状【源码事实】（§8 D3 的事实基础）

- `Reminder` 持久化派生表（`schema.prisma:990-1020`），状态 `PENDING|FIRED|CANCELLED|EXPIRED`，`(userId, sourceType, targetId)` 唯一。
- 写穿状态机 `applyReminderDesired`（`reminderService.ts:85-131`）：
  - 无行+desired → 建 PENDING；PENDING+desired → 按最新排程改写；
  - **PENDING+null → CANCELLED（终态，113-121）**；
  - **EXPIRED+desired → revive 回 PENDING（122-130）**——"重新排程"是合法复活；
  - **FIRED/CANCELLED → 永不改写（107-112）**。
- `expireStaleReminders`：anchorAt 早于 `REMINDER_OVERDUE_WINDOW_MS`=**24h** 的 PENDING → EXPIRED（`reminderService.ts:247-262`、`shared.ts:30`）。
- `claimDueReminders`：先 expire 再原子领取 `fireAt<=now` 的 PENDING → FIRED（271-296）。渲染器 tick `tickReminders` 每次调用都**先 reconcile 再 expire 再 claim**（`reminder.actions.ts:26-33`）。
- 提醒来源两类：`PROCESS_STEP`（canonical 流程步骤 scheduledAt）与 `JOB_DUE`（**仅 Legacy `Job.dueDate`**，`reconcileReminders` 查询的是 `db.job`）。Canonical 职位归档只影响 PROCESS_STEP 提醒。
- `computeProcessStepReminder` 要求 Attempt 与机会均未归档（`shared.ts:147-168`）→ **归档机会的步骤 desired=null**。
- `reconcileReminders`（`reminderService.ts:190-240`）：对每个"活的锚点"写 desired，再把**不在活锚点集合内的 PENDING 行 CANCELLED**（234-238）。
- **关键推论**：
  1. 归档职位后，**下一次 tick/reconcile** 即将该职位步骤的 PENDING 提醒永久 CANCEL（不是下次启动才发生——每个渲染器 tick 都跑 reconcile）。恢复职位后 desired 恢复非空，但 CANCELLED 行被早退（107-112）→ **提醒静默永久丢失**。
  2. **行上无法区分取消原因**：deleted target、step 关闭/取消、scheduledAt 清空、Attempt 终态/归档、父机会归档全部汇聚到同一个 CANCELLED，无原因列。区分原因只能：(a) 在 compute 层按来源分类（可行——归档判定就在 `shared.ts:156-158`）；或 (b) 行上加原因列（Schema 变更，不推荐）；或 (c) 恢复时按"当前 desired 是否非空"复活（不需原因列，见 §5.2 R2）。
  3. 没有"用户主动取消单条提醒"的产品路径——`cancelPendingReminder` 仅用于目标删除（`applicationService.ts:951`）；prefs.enabled 只门控投递不取消行（tick 里 reconcile 仍跑）。因此"取消原因"目前是**系统内部**问题，不是用户可见分类。
  4. 幂等：`applyReminderDesired`/`cancelPendingReminder` 全部走 `updateMany` 条件更新（CAS）+唯一键兜底，重复归档/恢复与并发 reconcile 不会产生撕裂态，只可能有"过期 reconcile 快照 vs 已恢复"的瞬态陈旧，下一次 desired 同步即收敛。

### 2.6 关联完整性现状【源码事实】

- `ApplicationAttempt.archivedAt` 字段存在且被广泛读取（`schema.prisma:929`），但**没有写路径设置它**——独立第二维度。`ApplicationService` 只对已归档 Attempt 拒绝新流程步骤（`ATTEMPT_ARCHIVED`，1144-1149）。
- 归档机会下的 Attempt、ProcessStep、JD 版本、MatchAnalysis、JobOpportunityNote、ResumeVariant 绑定均不被触碰。FK：Note 为 Cascade；Attempt/JD版本/提交的简历版本/Artifact 均 Restrict——归档行仍阻止物理删除。
- `InterviewSession.jobOpportunityId` 可空反关联，会话有独立 `archivedAt`，不随职位归档。
- Agent 上下文：`loadOwnedJob`（`conversationContext.server.ts`）经 `getOpportunityAsJob` **不过滤归档**——已归档职位仍可作为对话上下文解析；`listOwnedContextOptions` 走 `listJobs`（排除归档）。上下文引用以 `labelSnapshot` 快照持久化，实体归档后引用文字不丢。

### 2.7 AI 对话现状【源码事实】

- `ChatConversation`（`schema.prisma:670-704`）：`messages`(JSON)、`context`(JSON)、AI 锁三列、活跃请求锁 `activeRequestId/activeRequestExpiresAt`。**无 `archivedAt`**。
- `ConversationSummary` 为 1:1 transcript 压缩缓存，随对话 Cascade——删除对话删它，不动职业事实。
- Store（`chatConversationStore.ts`）：全部 `conversationId+userId` 约束；`deleteOwnedChatConversation` 物理删除（Cascade 摘要）。
- Action 层（`agentChat.actions.ts`）：`requireUser()`；list/delete 均无归档概念。AI 锁创建后不改写。活跃对话 ID 仅存 localStorage/cookie。

### 2.8 归档中心入口现状【源码事实】

- `SettingsSidebar.tsx`：`data-support` 组当前仅 `data-privacy`、`about` 两项，无 `archive-data`。
- `settings/page.tsx`：`data-privacy` 渲染 `DataSettings` + 非 fresh-native-full 时的 MCP 设置。无归档区块/action。

### 2.9 备份现状【源码事实】

- `JobOpportunity.archivedAt`（`backup/schema.ts:452`）、`ApplicationAttempt.archivedAt`（513）等已以 `optDt` 随备份往返。
- `ChatConversation` 备份 Schema（383-398）无 `archivedAt`；可选字段 `.optional()` 兼容旧备份是先例（380-382、389-390）。Manifest `formatVersion` 门禁 + `SUPPORTED_BACKUP_FORMAT_VERSIONS` 白名单。导入=全量恢复，归档状态作为普通字段往返。

### 2.10 既有"归档类"先例【源码事实】

- `archiveVariant` 幂等早退 + `assertNotArchived` 禁写守卫，**无恢复**；`archiveApplicationMaterial/Referee/Attachment` 各自单列写入。
- `tag.actions.ts:163-166`：归档素材仍计入删除保护计数——归档≠不存在。
- 结论："单列写入 + 默认排除 + 归档禁写"范式齐备；缺的是**恢复、集中视图与跨家族合同**。

## 3. 领域模型与语义定义【推荐方案】

### 3.1 三个动词的语义边界

| 动词 | 语义 | 数据效果 |
|---|---|---|
| 归档（Archive） | 可逆可见性管理。"这段历史不再活跃使用，但保留"。 | 仅写归档标志列；不动关联行、不改写历史事实、不删除消息/事件。 |
| 恢复（Restore） | 撤销归档，回到默认可见集合。 | 仅清除归档标志列；不重算状态、不重建派生数据（提醒例外见 §5）。 |
| 删除（Delete） | 既有破坏性操作，不归档合同管理。 | 按各实体现有物理/级联语义；与归档入口分开呈现。 |

- 归档不是状态机成员：`JobOpportunity.status`（ACTIVE/CLOSED/EXPIRED/UNKNOWN）保持原值；`archivedAt` 是独立可见性标志。
- 归档不是"过期/关闭"：`status=CLOSED/EXPIRED` 是业务事实；`archivedAt` 是用户选择。可共存、互不归并。

### 3.2 归档标志的位置

- 职位（canonical）：复用 `JobOpportunity.archivedAt`，不新增第二字段。
- 职位（legacy）：`Job` 无字段、只有 `"archived"` 状态值——能力矩阵见 §4.3 与 §8 D1。
- 对话：`ChatConversation` 新增 `archivedAt DateTime?`（实现级选择，见 §7）。
- Attempt：保留 `archivedAt` 现有独立维度语义；归档职位**不级联写** Attempt；恢复因此是纯单列操作。Attempt 级独立归档产品化属后续批次。

### 3.3 可见性规则（归档后）【推荐方案】

以"默认排除、归档中心可达、详情可直达"为基线；与现有 AB 读模型一致。

| 表面 | 归档后行为 | 备注 |
|---|---|---|
| 职位列表/搜索/筛选 | 不显示（现状）。归档中心内可对归档集合同等搜索。 | 复用 `filter="archived"` 通道或独立服务方法。 |
| 职位详情（直接 URL） | 可打开、只读、带归档标记；编辑类操作服务层拦截。 | 补"归档态禁写"守卫（对齐 `assertNotArchived`）。 |
| Dashboard 活跃口径（Board/分布/Interview/近期） | 默认排除（现状正确）。 | 见 §8 D2。 |
| Dashboard 窗口期投递口径（7天投递/热力图） | **现状回落；推荐改为保留事实**。 | 见 §8 D2——产品决定项。 |
| Dashboard 存在性口径 | 仍计入（现状正确）。 | `loadJobsExistence` 不改。 |
| Upcoming/流程事件 | 归档职位及其事件不出现；事件行保留，恢复后回归。 | 现状已满足。 |
| Reminder | 归档职位的 PENDING 提醒不投递；恢复后语义见 §5 与 §8 D3。 | 现状是 reconcile 永久 CANCEL——**需改造**，非简单冻结。 |
| 历史关联（公司页、JD、Match、简历绑定、面试会话） | 数据保留；各表面按自身规则显示；Restrict 删除保护继续计入归档行。 | InterviewSession 不随职位隐藏，除非自身归档。 |
| Agent `list_jobs`/上下文选择器 | 不返回归档职位（现状）。 | — |
| Agent `get_job`/上下文解析 | 仍可解析；DTO/上下文标记 `archived`。 | 保证历史对话引用可读、归档中心可查阅。 |
| 对话列表（Agent 历史） | 归档对话不出现；归档中心单独列出。 | 需 `archivedAt` 字段+过滤。 |
| 对话详情/消息写入 | 归档对话**只读**：可看完整 transcript，不可发送、不改写锁与消息。 | 需 store 层守卫。 |

### 3.4 归档的写效应【推荐方案】

- 职位归档 = `JobOpportunity.archivedAt = now` 单条件更新；顺带**将本职位步骤的 PENDING 提醒转 EXPIRED（推荐方案 R1，见 §5.2）**；不改 `status`、不动 Attempt/JD/Note/Match/简历绑定/InterviewSession。
- 对话归档 = `ChatConversation.archivedAt = now`；同时清除 `activeRequestId/activeRequestExpiresAt`（进行中锁视为放弃——归档后不再允许写消息）；`messages/context/AI 锁/title` 不动；`ConversationSummary` 保留。
- 幂等：对已归档对象再次归档不产生副作用放大（早退或已归档结果码，实现层二选一）。

### 3.5 恢复的写效应【推荐方案】

- 恢复 = `archivedAt` 置回 `null`。不动 `status`、不重跑派生、不回填派生数据。
- 恢复后：职位回到默认列表与活跃统计；Upcoming 回归；提醒语义按 §5.2 执行；对话回到历史并恢复可写。
- 恢复不保证还原"归档前瞬间的派生视图"，只保证**归档行及其显式关联完整无损**。

## 4. 归档中心合同【推荐方案】

入口：设置 → 数据与支持 → **归档数据**（新增 `archive-data` section）。

### 4.1 功能面

- 两个列表：归档职位、归档对话。条目展示标题/公司（或对话标题）、归档时间、原始更新时间、简介元数据与"恢复"操作。
- 归档集合内搜索：职位支持标题/公司/地点/来源关键字（复用现有 search）；对话支持标题关键字。
- 归档中心可打开**只读详情**（职位快照、对话 transcript），不做编辑。
- 不提供删除入口（§8 D4 未决前）。

### 4.2 行为规则

- 查询全部按 `userId` 归属过滤；blocked runtime 保留 typed blocked/degraded 语义，不把读失败当空态。
- 恢复：`updateMany({ id, userId, archivedAt: notNull }) → archivedAt:null` 条件更新（CAS）；0 行=已恢复/并发改动，幂等成功。
- 并发：归档/恢复用条件更新而非先读后写；并发冲突以最后提交为准（时间戳列即事实源）；列表每次操作后重拉。
- 权限：`requireUser()` + `userId` 归属过滤；服务层必须校验归属与当前归档态，不依赖前端隐藏。
- 失败恢复：单行条件更新天然原子；失败返回受控错误（`handleError`/`CareerRuntimeError` 模式），不留半态。
- 归档对象在归档中心之外不可编辑：服务层对归档机会的内容写统一拒绝（对齐 `assertNotArchived`/`ATTEMPT_ARCHIVED`），归档后不得新增 Attempt/流程步骤/笔记；恢复后一切如常。

### 4.3 家族能力矩阵【推荐方案——取代"是否列出 Legacy"的悬置表述】

| 运行时/家族 | 查看归档记录 | 归档操作 | 恢复 |
|---|---|---|---|
| AB / fresh-native canonical | ✓（归档中心完整列表+只读详情） | ✓（归档中心+各职位"归档"操作） | ✓ |
| Legacy `Job` | 归档中心按 §8 D1 决定：**不列出**（推荐）或**只读列出带"旧版记录"标识**；Legacy 普通列表现状本来就内联显示 archived badge | **不新增**归档动作（status=archived 是现有状态编辑语义，不是可逆归档） | **不提供**——状态覆盖不可逆，无法兑现"恢复原状态"承诺；不给 `Job` 加字段 |
| blocked | 保留现有 typed blocked 语义 | — | — |

- 一致性规则：**界面上出现的任何"恢复"按钮必须背后有精确语义**；Legacy 行若列出则明示"仅查看"，且不与 canonical 行混排（分区或标识）。Legacy 既有"删除"入口的物理删除语义不归本合同管理（见 §6）。

### 4.4 恢复时的缺失/冲突处理【推荐方案】

- Canonical 关键关联全部 Restrict/SetNull 保护且归档不删行——"关联缺失"正常路径几乎不可能。防御规则：
  - 恢复前置校验＝CAS 的 WHERE 条件本身（存在+归属+仍归档）。
  - 关联完整性作为恢复前**只读检查**：必需关联（公司、提交的简历版本、JD 版本）意外缺失 → 整体失败明确报错（数据损坏信号，走备份恢复而非应用内修补）；不做部分恢复。
  - Agent 上下文/对话引用（`labelSnapshot` JSON 快照）不参与校验——本就脱离实体存在。
- 对话恢复：同样条件更新；无外部关联校验（`resolvedConnectionId` 悬空是既定契约——只读快照）。

## 5. 提醒语义专项【推荐方案——本轮核查重写】

### 5.1 目标与约束

- 归档不应产生**可见的正确性损失**：归档≠用户放弃提醒排程，除非 Owner 明确如此决定。
- 提醒表是派生状态，不是事实源；恢复提醒本质是"重新让 desired 生效"。

### 5.2 最小可行方案比较

| 方案 | 机制 | 恢复行为 | 改动面 | 评价 |
|---|---|---|---|---|
| **R1（推荐）抑制→EXPIRED+自动复活** | compute 返回三态（deliver / suppress / cancel）：父归档→suppress→`PENDING→EXPIRED`；其余 desired=null 原因仍→CANCELLED。归档写在同事务内对本职位步骤提醒 `PENDING→EXPIRED`（堵tick窗口漏投）；reconcile 三态化兜底所有绕过归档服务的写路径（`syncApplicationFromUiStatus`、备份恢复等）。 | desired 非空时 `EXPIRED+desired→PENDING` 走**既有**复活路径（`applyReminderDesired` 122-130），恢复写或下一次 reconcile 自动生效。 | `shared.ts` compute 三态 + `applyReminderDesired` 增 suppress 分支 + 归档/恢复写各一处条件更新。无新状态、无 Schema、不改终态不变量。 | 语义收敛、覆盖全部写路径、复用既有 revive 机制；EXPIRED 行上仍不区分"归档抑制"与"自然过期"——但复活只依赖当前 desired，**不需要**区分原因。 |
| R2 维持 CANCELLED+恢复显式复活 | 归档维持 reconcile→CANCELLED；恢复时对该职位步骤重算 desired，非空者 `CANCELLED→PENDING` 显式复活。 | 恢复点按"当前 desired"复活，不依赖取消原因。 | 恢复写一处重算+条件更新；状态机本体不动。 | 改动最小，但**改写"终态行"**（违背 §2.5 文档化不变量"FIRED/CANCELLED 永不改写"），且归档到下次 reconcile 之间 PENDING 行可能先投递（漏投窗口需归档写内同步 CANCELLED 才能堵）。 |
| R3 维持现状+文案披露 | 不改提醒代码；归档确认文案明示"提醒排程将被放弃且不可恢复"。 | 提醒永久丢失。 | 零代码，仅文案。 | 用户伤害真实存在且不可逆；只作 Owner 显式选择的兜底。 |

**对任务核查问题的明确回答：**

- **恢复时已过提醒时间会不会立即补发？** 在 R1/R2 下会——但规则与现有"重启追发"完全一致：anchor 落在 24h 过期窗口内→revive 为 PENDING 后 fireAt 已过→下一次 claim 立即投递（补发）；超过 24h→`expireStaleReminders` 复归 EXPIRED，不投递。即"过期窗口内补发、过期窗口外不补"。是否将"归档恢复"排除在补发窗口外是产品微调点，归入 §8 D3 备选注记。
- **用户取消、正常过期、归档抑制能否区分？** 行上当前不能（全部汇成 CANCELLED 且无原因列）；R1 在 compute 层区分到"suppress vs cancel"两类已足够——复活只看 desired，精确原因列（Schema）不推荐。
- **重复归档/恢复与 reconcile 并发是否幂等？** 行级幂等成立（全部 `updateMany` CAS+唯一键）；reconcile 与恢复并发只可能产生"过期快照写入"的瞬态陈旧，下一次 desired 同步收敛，无撕裂态。

### 5.3 已过期提醒与未来提醒的行为定义（R1 下）

- 归档时：该职位全部步骤提醒 `PENDING→EXPIRED`（不动 FIRED/CANCELLED 历史）。
- 恢复时：desired 非空的 EXPIRED 行 → PENDING（fireAt=anchor-lead 重算）。**未来提醒**按原排程投递；**24h 窗口内的已过提醒**下一次 tick 补发一次；**窗口外已过提醒**复归 EXPIRED 不投递。不区分"归档期间错过"与"本来就过期"——以 anchor 时间为准。

## 6. 现有删除与归档/恢复的语义差异【推荐方案】

- AB 的"删除"实为归档：正式命名"归档"，文案打通归档中心（提示可在归档中心恢复）。
- Legacy 的"删除"物理删除：与归档入口明显文案区分；Legacy 是否提供归档动作见 §4.3 矩阵（不新增）。
- 对话删除 `deleteChatConversation` 物理删除（连带摘要）：对话界面同时提供"归档"与"删除"两入口，文案明确区分"归档可恢复、删除不可恢复"。删除入口语义不改。
- 归档中心内不出现删除按钮。

## 7. 实施包拆分与 Owner 边界【推荐方案——按完整用户成果重组】

不按 Schema/服务/UI/Agent 分独立窗口。**两个闭环包**即可交付用户成果；共享面标唯一 Owner 与先后关系。

### P-JOB：职位归档与恢复闭环

- **用户成果**：职位可归档、可恢复、归档后全读模型一致隐藏、归档中心可管理。
- **拥有**：
  - 服务：`opportunityService.ts`（archive/restore CAS）、`jobOpportunityAdapter.ts`（unarchive 适配、archived DTO 标记透传）、`mutations.ts`（归档/恢复 action 与既有 delete 分流）、`applicationService.ts`（归档禁写守卫）。
  - 提醒：`reminderService.ts`/`shared.ts`（§5.2 选定方案的实现）。
  - 统计：D2 决定后的 `jobsReadDispatch.ts` 窗口期调整（若采纳保留事实口径）。
  - **归档中心外壳与职位区**：`SettingsSidebar.tsx`、`settings/page.tsx`、新增 `ArchiveSettings` 组件骨架、归档职位列表/搜索/恢复 UI、只读详情壳。
  - **本特性全部 i18n 键**（`en.json`/`zh-CN.json` 的 archive 相关键面）——词典单一 Owner；P-CONV 所需键以准确 key+中英文文本交接口径给本 Owner 落地。
  - Agent 读取契约：`get_job` DTO archived 标记、上下文解析标记（消费面小，随本包带）。
- **先落约束**：归档中心外壳与共享 i18n 键面由本包先行冻结接口（组件槽位、action 签名、键名约定），P-CONV 按契约接入。

### P-CONV：对话归档与恢复闭环

- **用户成果**：对话可归档/恢复，历史列表默认不显示归档项，归档中心可管理。
- **拥有**：
  - **Schema/Migration/备份单一 Owner**：`prisma/schema.prisma`（`ChatConversation.archivedAt`+索引；P-JOB 的 `JobOpportunity [userId,archivedAt]` 索引规格一并随本迁移）、新 Migration、`src/lib/backup/schema.ts`（`archivedAt: optDt.optional()`）。
  - Store/Action：`chatConversationStore.ts`（列表过滤、归档/恢复、归档态写守卫）、`agentChat.actions.ts`（archive/restore actions）。
  - UI：Agent 历史列表（归档操作+默认排除）、归档中心对话区（接入 P-JOB 外壳槽位）。
- **依赖**：归档中心外壳契约由 P-JOB 提供；Schema/Store 部分可与 P-JOB 并行开发。

### 共享面归属与先后

| 共享物 | 单一 Owner | 先后 |
|---|---|---|
| `prisma/schema.prisma` + Migration + 备份 schema | P-CONV | P-JOB 把职位索引规格交 P-CONV 同迁移落地 |
| 归档中心外壳 + 设置入口 + archive 键 i18n | P-JOB | 先冻结槽位/键名契约，P-CONV 接入 |
| `jobsReadDispatch`/`reminderService` | P-JOB | 随 P-JOB 闭环交付 |
| `wiki/P1_FEATURES.json`/台账 | 主协调窗口 | 各 Owner 不动 |

### 验收职责

- 各 Coding Owner 对本包做必要定向验证（纯函数/服务/隔离库/UI 测试按影响选择）。
- 最终隔离 Windows Electron 实测由主协调窗口统一调度（桌面重型验证串行）；**不单设例行 Review 或 Gate 工作包**。

## 8. Schema / 迁移 / 备份最小变化【实现级选择——不再逐项请 Owner 确认】

- `ChatConversation`：新增 `archivedAt DateTime?` + `@@index([userId, archivedAt])`，一次新 Migration。
- `JobOpportunity`：同迁移补 `@@index([userId, archivedAt])` 支撑归档中心列表。
- `Job`（legacy）：不动。
- 备份：`ChatConversation` 备份 Schema 增 `archivedAt: optDt.optional()`（沿用可选字段先例）；旧备份缺字段恢复为 NULL，语义安全；纯可选增量不 bump `formatVersion`。
- 不新增归档关系表/审计表。

## 9. Owner 待决定项汇总（仅产品规则）

每项给推荐、备选与可见影响。**实现级选择（§7 与下表"实现注记"）不再请 Owner 逐项确认**，按本合同推荐默认执行。

| # | 产品决定项 | 推荐 | 备选 | 可见影响 |
|---|---|---|---|---|
| D1 | **Legacy 家族在归档中心的呈现** | 归档中心仅承诺 canonical；legacy 运行时下归档数据显示"适用于新版职位记录"的说明态（Legacy 的 archived 状态行继续在普通列表内联显示）。不给 `Job` 加字段、不提供 Legacy 恢复。 | 只读列出 Legacy `status=archived` 行并明示"旧版记录·仅查看"（分区、不与 canonical 混排）——多一处家族分发查询与标识 UI。 | Legacy 用户体验口径；归档中心查询是否按家族分发；验收是否覆盖 legacy 模式。 |
| D2 | **窗口期投递统计口径** | **保留历史事实**：窗口期投递数/热力图按 Attempt 事实统计，去掉 `jobOpportunity.archivedAt` 过滤（保留 Attempt 自身归档过滤）；活跃口径与存在性口径不变。用户含义："归档隐藏的是职位，不是发生过的事实"；改动成本小（`attemptInRangeWhere` 及其两处 groupBy where，加定向测试）。 | 冻结现状（归档即回落）+归档确认文案披露"统计将减少"——零代码但语义上等于"归档改写历史报告"。 | Dashboard 数字语义与验收断言；用户对归档的心理预期。 |
| D3 | **归档对 PENDING 提醒的语义** | **R1**：归档抑制→EXPIRED（归档写内同步翻转+reconcile 三态兜底），恢复后 desired 非空自动复活；补发沿用 24h 过期窗口（窗口内已过→补发一次、窗口外→不投）。 | R2 维持 CANCELLED+恢复显式复活（改最小但改写终态行、留漏投窗口需额外堵）；R3 维持永久取消+确认文案明示放弃排程（零代码、用户伤害不可逆）。 | `reminderService`/`shared.ts` 状态机增量与验收用例；"归档后是否仍排程"的用户承诺。备选注记：恢复是否豁免 24h 内补发也可单独决定（默认不豁免，与重启追发一致）。 |
| D4 | **归档中心内永久删除入口** | 本期不新增；归档中心只提供恢复。 | 新增需独立合同（第三语义、级联范围、二次确认、备份提示）。 | 是否扩项。 |
| D5 | **普通职位列表"归档"筛选入口** | 不加；归档视图集中在归档中心，`filter="archived"` 能力备用。 | 加入口需改 `JobsToolbar`/`useJobFilters`。 | 列表复杂度。 |
| D6 | **Agent 侧归档可见度** | `list_jobs`/上下文选择器排除；`get_job`/上下文解析可达并标记 `archived`；归档对话不出现在 Agent 历史；归档/恢复只走 UI action 不进 Agent 工具。 | 对 Agent 完全隐藏归档对象（get_job 也拒绝）——历史对话引用将无法解析，不推荐。 | Agent 能否如实陈述归档数据；DTO 增量。 |
| D7 | **归档态可编辑边界** | 全禁写：内容、Attempt、流程步骤、笔记均拒绝，仅查看与恢复。 | 允许笔记类轻编辑——破坏"封存"语义一致性，不推荐。 | 各写入服务补统一守卫；详情页只读壳。 |
| D8 | **归档/恢复操作审计** | 本期不写审计表；`updatedAt`/`archivedAt` 提供基本事实。 | 新增审计表属扩项。 | 是否扩项。 |

**已降级为实现级选择的原决定项**：D2(ChatConversation 字段)、备份兼容、CAS 机制、归档幂等形态、详情只读壳、activeRequest 锁清除、labelSnapshot 免校验——按 §7/§3/§4 推荐执行，不再单列确认。

## 10. 最小验收矩阵【推荐方案】

通用前置：全部用**隔离/合成数据**；区分 Web 检查与 **Windows Electron** 实测（浏览器通过不得代替）；持久化用例须"操作→重开应用→复查"。

| 维度 | 用例 | 通过标准 |
|---|---|---|
| 可见性 | 归档职位后：列表/搜索/筛选/活跃统计/Upcoming 不含该项；归档中心可见可搜索；详情直达只读。对话同口径。 | 各表面一致隐藏；无残留提醒投递。 |
| 恢复一致性 | 恢复职位→回列表/统计/Upcoming；Attempt、步骤、JD、Match、笔记、简历绑定逐项在；对话恢复→回历史且可写。 | 关联完整；重复恢复幂等。 |
| 提醒语义 | 按 D3 冻结口径：归档后 PENDING 提醒不投；恢复后未来提醒按排程投、窗口内已过按约定补/不补、窗口外不投；重复归档/恢复与 reconcile 交错无撕裂。 | 与冻结语义逐条一致。 |
| 统计口径 | 按 D2 冻结口径：活跃口径排除、窗口期口径按冻结结果断言、存在性计入。 | 三类口径各自正确、互不污染。 |
| 家族边界 | 按 D1 冻结口径验证 legacy 模式下归档中心呈现；canonical 下完整闭环。 | 不出现无法兑现的恢复承诺；legacy 行不混排。 |
| 用户隔离 | 双用户合成数据：A 的归档项不出现在 B 任何表面；B 不能经 id 恢复/读取 A 的归档项。 | 跨用户 0 泄漏；服务层拒绝。 |
| 关联完整性 | 归档职位下 Attempt/事件/简历绑定/上下文快照完整可读；Restrict 引用不因归档可删。 | 关联逐项存在；删除保护仍生效。 |
| 备份往返 | 含归档职位+归档对话导出→导入隔离库→归档状态/关联/消息逐项一致；旧格式备份（无对话 archivedAt）导入不报错且恢复为未归档。 | 完整往返；旧格式兼容。 |
| Windows Electron | 桌面宿主走"归档→重开→确认保留→恢复→再重开"闭环（含归档中心路径）。 | 长期保留与恢复结果正确，与 Web 一致。 |
| 边界 | blocked runtime、空归档集合、重复归档、归档后原"删除"语义区分（对话删除仍物理删、AB 职位"删除"即归档文案）。 | 各边界有明确非误导表现。 |

## 11. 明确不做的事

- 不改写已执行 Migration；不做全仓扫描式重构。
- 不建 30 天回收站、不做自动过期、不写归档审计表（D8 未决前）。
- 不在归档中心提供删除/永久删除（D4 未决前）。
- 不把其他 `archivedAt` 模型纳入首批产品化。
- 不修改共享台账 `P1_FEATURES.json`/`P1_IMPLEMENTATION.md`。
- 不给 `Reminder` 加"取消原因"列（原因区分在 compute 层解决，行级归因无必要）。
