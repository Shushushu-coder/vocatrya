# P2 JOB-CONNECTIONS + INTERVIEW-DEBRIEF 联合数据与产品合同（提案 v2 收敛稿）

- **状态**：提案（Proposal），待 Owner 裁定 §13 决策表后冻结；推荐与协调建议均不构成批准
- **基线**：`main @ 23178a4c`（v2 复核基线，全部"源码事实"已按此基线重新核实；v1 基线 `96e896e3`——两基线间本合同相关源码无实质变化：增量为 canonical `match_job` 的 `AgentToolExecution`（备份排除）、managed recharge、About 面移除、`ChatConversation.archivedAt` 索引）
- **交叉项**：§13 D6「已结束」推荐仅 `status === COMPLETED` 计入待复盘、过期未关闭只提示确认状态；与首页合同 §9 D3 的协调建议已对齐，但尚未获 Owner 批准；冻结前须由 Owner 单点裁定，供 NEXT-ACTIONS 消费同一谓词（协调建议见 §7.4）
- **覆盖 Feature**：`JOB-CONNECTIONS`、`INTERVIEW-DEBRIEF`（`wiki/P2_FEATURES.json`，当前 `implementationStatus: NOT_ASSESSED`）
- **上游已冻结合同**：`wiki/RESUME_BUILDER_CONTRACT_PROPOSAL.md`、`wiki/ARCHIVE_CONTRACT_PROPOSAL.md`（含 D6「AI 不得读取任何归档内容」）、`wiki/DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`
- **2026-11-01 集成补记**：G-AI1 已由 `8b09faf1` 独立修复。下文基线源码事实中的“未过滤归档”保留为历史核查，现状以 §11.2 为准；P-A 不重复实现该修复，其余提案仍待裁定。
- **本文件性质**：合同提案，不是实现计划；不含代码修改、Migration、i18n 或测试变更

**标注约定**：

- **[已存在]**：基线源码中已存在且经核实的能力/字段/路径。
- **[保留]**：Schema/代码中已存在但无写路径或未产品化的预留结构，本合同定义其语义归属。
- **[增量]**：本合同建议的最小新增（字段/谓词/UI 语义），均需 §13 对应决策项裁定后才生效。
- **[待核实]**：源码事实无法确证或语义有歧义的点；不得当作已实现或已缺失处理。

---

## 1. 目的与范围

### 1.1 目的

让用户能够从**目标职位**和**实际投递**追溯到当时使用的**简历版本/JD/导出物**，再关联**真实面试轮次、当时提问和复盘**；历史事实不能被后续编辑、删除、归档或恢复覆盖。

两个 Feature 必须作为一条耦合合同闭合的原因：

- `JOB-CONNECTIONS` 产出"职位 → 投递 → 材料"链；
- `INTERVIEW-DEBRIEF` 在该链的 `ApplicationProcessStep` 上挂载"真实面试轮次 → 提问 → 复盘"；
- 两者共享同一棵 `JobOpportunity → ApplicationAttempt → ApplicationProcessStep → ApplicationInterviewDetail` 实体树，分开定义必然产生重复实体或断链。

### 1.2 范围内

- `JobOpportunity` / `ApplicationAttempt` / `ApplicationProcessStep` / `ApplicationInterviewDetail` / `ApplicationInterviewReflectionItem` 的正式关系、基数与不可变性；
- 计划简历绑定 vs 实际投递材料的区分与追溯语义；
- 复盘的问题来源、快照、状态、可编辑性与删除/归档语义；
- 真实面试复盘与 `InterviewSession`（模拟/练习）的边界；
- 时间精度、"已结束、待复盘"判定、旧数据、备份恢复与 AI 边界。

### 1.3 明确不做（Non-goals）

- 不重新设计 P1 简历工作台、归档系统、模拟面试（`InterviewSession` 执行流）或题库 UI；
- 不实现 `MULTI-AGENT` / Voca Reflect；本合同只定义其未来安全读取/生成草稿的边界（§11）；
- 本期不产品化 `InterviewSession` 归档（枚举已存在但无写路径）、`ApplicationAttempt` 独立归档维度；
- 投递材料中的 cover letter、其他附件：本期非目标（`ApplicationAttempt` 当前无对应字段，P2 未要求）；
- 不改写已执行 Migration，不改 Legacy 数据迁移口径。

---

## 2. 源码事实总览（基线核实）

### 2.1 实体树与关系（`prisma/schema.prisma`）

```
User 1─N JobOpportunity ─┬─ 1─N JobDescriptionVersion（rawContent 创建后不可更新）
                         ├─ 1─N ApplicationAttempt ─┬─ 1─N ApplicationProcessStep ─┬─ 0..1 ApplicationInterviewDetail ─┬─ 1─N ApplicationInterviewReflectionItem
                         │                          │                              ├─ 0..1 ApplicationAssessmentDetail
                         │                          │                              └─ 0..1 ApplicationOfferDetail
                         │                          ├─ submittedResumeVersionId → ResumeVariantVersion (Restrict)
                         │                          ├─ submittedResumeArtifactId → ResumeArtifact (Restrict)
                         │                          └─ submittedAgainstJdVersionId → JobDescriptionVersion (Restrict)
                         ├─ 1─N ResumeVariant（targetJobOpportunityId，SetNull；计划绑定）
                         ├─ 1─N InterviewSession（jobOpportunityId+jobDescriptionVersionId 可选成对，Restrict）
                         └─ 1─N JobOpportunityNote (Cascade)
```

关键事实（均已核实）：

| 事实 | 位置/依据 |
|---|---|
| `JobOpportunity.applicationAttempts` 1:N，`onDelete: Restrict` | `schema.prisma` `JobOpportunity` / `ApplicationAttempt` |
| `ApplicationAttempt` 复合归属 `userId + jobOpportunityId`，`processSteps` 1:N Cascade | `schema.prisma` `ApplicationAttempt` |
| 三个提交引用列：`submittedResumeVersionId`、`submittedResumeArtifactId`、`submittedAgainstJdVersionId`，全部 `Restrict` | 同上 |
| `transferredFromAttemptId` 自引用 `SetNull`（渠道转移谱系） | 同上 |
| `ApplicationProcessStep`：`category`（含 `INTERVIEW`）、`status`、`sortOrder`、三组时间+精度+时区旁路、`result`、`source`、`notes` | `schema.prisma` `ApplicationProcessStep` |
| `ApplicationInterviewDetail.applicationProcessStepId @unique` → ProcessStep 0..1 可选一对一 | `schema.prisma` `ApplicationInterviewDetail` |
| `ApplicationInterviewDetail` 含 `reflectionText` + `reflectionItems` 1:N Cascade；`interviewFormat/roundLabel/locationText/interviewerNames/durationMinutes` 存在但**无写路径**（additive-only 预留）；`structuredData` 注释明确不是复盘存储 | 同上；`interviewReflection.ts` |
| `ApplicationInterviewReflectionItem`：`questionText` 必填（纯文本快照，无 `Question` FK）、`answerNotes`、`sortOrder` | 同上 |
| `JobDescriptionVersion.rawContent` 创建后不可更新（注释/服务惯例），`contentHash` 去重、`versionNumber`、`capturedAt` | `schema.prisma` `JobDescriptionVersion`；`opportunityService` |
| `ResumeVariant.targetJobOpportunityId`（SetNull，可变的"计划绑定"）；`ResumeVariantVersion` 状态机 `DRAFT/FROZEN/SUBMITTED/ARCHIVED`，SUBMITTED 行内容不可编辑 | `schema.prisma`；简历合同 §3 |
| `ResumeVariantVersion.targetJdVersionId` 存在但**本期不接线**（简历合同已冻结） | 简历合同 |
| `ResumeArtifact`：`kind/format/storageKey/sha256`；字节不进备份（恢复后按 `bytesMissing` 重导出） | `schema.prisma`；`backup/schema.ts` |
| `Question`：用户题目，`question/answer/tags` 可变；`deletedAt/isActive` 存在；硬删除被 `QuestionInstance.sourceQuestionId`、`QuestionBankItem.questionId` 的 `Restrict` FK 阻止 | `schema.prisma`；`src/actions/question.actions.ts` |
| `QuestionBank/QuestionBankItem`：全局参考数据（`bankKey+version` 标识），备份 `wipeMode: "none"`，成员按 `question.createdBy` 归属 | `backup/ordering.ts` |
| `InterviewSession`：`status`（含 `ARCHIVED`）+`archivedAt`/`statusBeforeArchive` 存在但**无写路径**；`jobOpportunityId+jobDescriptionVersionId` 可选成对（必须同时给/同时不给，JD 必须属于该职位，复合 FK `Restrict`） | `schema.prisma`；`src/lib/interview`（无 `ARCHIVED` 写入路径，已核实） |
| `QuestionInstance`：`displayedText`（当时展示文本快照）+`sourceQuestionId`（可空 `Restrict`）+`sourceKind`+`referenceAnswerSnapshot` | `schema.prisma` `QuestionInstance` |
| `Reminder`：`PROCESS_STEP`（scheduledAt）/`JOB_DUE` 派生写穿；归档抑制 | `applicationService`；`upcomingReadModel` |
| `Question` 对复盘条目**无反关系**（D4-a 需同时加 `reflectionItems` back-relation）；`deletedAt/isActive` 仅 interview planning 读侧过滤，`getQuestionsList` 未过滤、写侧仅硬删除 | `schema.prisma`；`question.actions.ts`；`hostQueries.ts` |
| `generateInterviewReflectionDraft` 的 step 查询**未过滤父机会 `archivedAt`**——归档职位下 AI 草稿仍可生成（读放行与归档合同 D6「AI 不得读归档」不一致，记为缺口 G-AI1） | `interviewReflectionAi.ts` step 查询；归档合同 §9 D6 |
| `InterviewSession` 归档：`vocatryaInterviewPersistence.updateSessionForUser` patch 类型含 `archivedAt/statusBeforeArchive` 但**全仓无调用方写入**——无产品化归档路径；读侧 `isArchivedRow`/`SESSION_ARCHIVED` 已存在 | `src/lib/interview` |

### 2.2 服务层不变量（`src/lib/career/applicationService.ts` 等）

| 不变量 | 实现 |
|---|---|
| 提交引用**首次绑定后不可换绑** | `writeSubmissionInTransaction`：已存在绑定传入不同 id → `SUBMITTED_RESUME_PROVENANCE` / `SUBMISSION_PROVENANCE_CONFLICT`；CAS `updateMany` 只在 NULL 上写入 |
| 首次提交未传 JD 时自动绑定当时 `jobOpportunity.currentJdVersionId` | `submitApplication` / `attachSubmissionProvenance` |
| Artifact 必须属于对应 ResumeVersion；JD 必须属于该 Attempt 的职位 | 同事务校验 |
| 绑定时将简历版本置 `SUBMITTED`；`ARCHIVED` 版本不可新绑定 | `markSubmittedInTransaction` |
| 创建 Step：`assertOpportunityWritable`（归档职位拒写）；Attempt 解析（0→可自动建 draft；>1→`AMBIGUOUS`）；`sortOrder` 避开兼容槽；时间与 reminder 同事务 | `createUserProcessStep` |
| 已完成或非 `USER` 来源 Step：仅 `notes/result` 可写；`undefined` 更新输入不触碰时间三元组（不静默改写历史未知精度） | `updateUserProcessStep` |
| `completeProcessStep`/`cancelProcessStep`：写 `status` + `completedAt = new Date()` + `completedAtPrecision = "fullInstant"` | 同上 |
| `deleteUserProcessStep`：仅 `source === "USER"` 可删；Cascade 删除 detail+items；取消 reminder | 同上 |
| `getInterviewReflection`：归属+`category === "INTERVIEW"` 断言；**无** writable gate（归档职位下只读可读） | `getInterviewReflection` / `assertInterviewReflectionStep` |
| `saveInterviewReflection`：走 `requireOwnedStep → assertOpportunityWritable`（归档职位拒写）；整组替换语义（upsert 传入 id、删除未传入项、更新 `reflectionText`，单事务）；**不限** Step `source`/`status`——任意 INTERVIEW Step（含 EVIDENCED、未关闭）都可写复盘 | `saveInterviewReflection` |
| AI 复盘 `generateInterviewReflectionDraft`：`CAREER_REFLECTION` 用途、TEXT_ONLY 一次性、**服务端不写复盘存储**；prompt 含 Step 事实+detail+职位+提交 JD（`submittedAgainstJdVersion` 回退 `currentJdVersion`）+提交简历标签+当前编辑中复盘；`NOT_CONFIGURED`/`INVALID_ASSIGNMENT` 诚实态 | `interviewReflectionAi.ts`；`interviewReflectionAi.actions.ts` |
| `JobOpportunity.archivedAt` 唯一写方为 `archiveOpportunity/unarchiveOpportunity`（CAS，可逆）；归档后 `assertOpportunityWritable` 阻断全部 Attempt/Step/复盘写入；读路径放行 | `opportunityService` |
| `ResumeVariant.targetJobOpportunityId` 经 `updateTargetJob` 可变更（CAS+归档守卫）——**计划绑定可改**，与提交事实分离 | `resumeVariantService` |
| Legacy 迁移：每个 Legacy Job → 1 个 Attempt（`submittedAt` 由 `appliedDate` 回填；三个 `submitted*` 显式 `NULL`——"migration-time JD is not proof"）+至多 1 个 `status: "EVIDENCED"`、`source: PHASE3_CREATED_VIA`、`sortOrder: 0` 的 Step；Legacy `Interview`/`JobContact` `DO_NOT_MAP`，不伪造历史 | `src/lib/legacy-migration/migrator.ts` |
| `upcomingReadModel`：Step 事件排除 `COMPLETED/CANCELLED`、要求 Attempt 存活（`archivedAt` null + outcome `ACTIVE/OFFER`）+职位未归档 | `src/lib/career` |

### 2.3 备份（`src/lib/backup`）

- `BACKUP_FORMAT_VERSION = 7`，支持 1–7；`ApplicationAttempt`/`ApplicationProcessStep`/`ApplicationInterviewDetail`/`ApplicationInterviewReflectionItem`/`Question`/`QuestionBank`/`QuestionBankItem`/`InterviewSession`/`QuestionInstance` 均在 `MODEL_SPECS` 与 `INSERT_ORDER`，拓扑顺序正确、FK rewrite 完整。
- `DEFERRED_FKS` 已含 `currentJdVersionId`、`currentVersionId`、`parentVersionId`、`transferredFromAttemptId`、`currentQuestionInstanceId` 等循环/自引用。
- `ApplicationInterviewDetail.reflectionText` 在旧备份中可选（向后兼容已处理）。
- `ResumeArtifact` 字节不进备份，恢复后按 `bytesMissing` 重导出。

### 2.4 UI 现状

- 职位详情 `ApplicationTimelineTab`：Attempt 列表（渠道/提交时间/阶段/结果/`transferredFrom`/`submittedResume` 摘要）+ Step 表 + 增删改/完成/取消/转移入口；INTERVIEW Step 有复盘入口（`canMutate` 时）；归档职位显示只读 banner。
- `SubmittedResumePanel` / `ApplicationResumeBindingPanel`：每 Attempt 展示/绑定提交简历版本。
- `InterviewReflectionDialog`：手动问答行（`questionText`+`answerNotes`）+整体 `reflectionText`；AI 生成→审阅→Apply→Save，落库前全在客户端；**无完成标记 UI**。
- 删除 Step 的 `DeleteAlertDialog` 文案不区分 `category`（`jobs.deleteProcessStepDescription` 只提计划/截止/备注/结果，不提示复盘级联）。
- `getTimeline` DTO 仅含 `submittedResume`（版本行摘要）——不含 `submittedResumeArtifact`、`submittedAgainstJdVersion`、计划绑定 Variant 与各 Step 的复盘状态；聚合视图所需数据缺口在 P-B。
- Task 创建：`?add-task=true` 仅打开 `TaskForm`；表单无「以给定初始值新建」的预填入口（复盘→Task 预填需新增，见 §13 D8）。
- `ResumeVariantWorkspace`：`targetJob` 选择（归档禁用）；`ResumeVariantList` 显示 `targetJobTitle`。
- `/dashboard/interview`：练习会话列表带 `jobTitle·companyName`；`/new` 必须成对选择 job+JD；与真实面试时间线分离。
- `/dashboard/questions`：题库 CRUD（硬删除）。

---

## 3. 已有能力 / 真实缺口 / 推荐增量 对照表

| # | 合同需求 | 源码已有能力 | 真实缺口 | 推荐增量（最小） |
|---|---|---|---|---|
| C1 | 职位→投递→轮次链 | 完整实体树 + Timeline 读模型 + UI | 无（结构层面） | 无新增实体；仅 §5 形式化语义 |
| C2 | 计划 vs 实际材料区分 | `targetJobOpportunityId`（计划，可变）+三个 `submitted*`（实际，不可变） | 职位详情未聚合展示"计划用哪版/实际投了哪版/对哪份 JD/导出物"对照 | UI 聚合视图（P-B），不加列 |
| C3 | 提交后引用不可变 | 服务强制首绑不可换绑 + `Restrict` FK + SUBMITTED 版本不可编辑 + JD 版本不可变 | 无 | 无；合同形式化 |
| C4 | `submitted*` 字段是否满足 | 满足"简历版本+导出物+JD"追溯 | 无 cover letter 等其他材料字段 | 本期不加（非目标）；导出物字节不进备份的语义沿用 |
| C5 | 真实面试轮次实体 | `ProcessStep(INTERVIEW)` + 0..1 `InterviewDetail` 已闭环 | 无（结构层面） | 推荐复用，不新增实体（D1） |
| C6 | 面试问题防篡改 | `questionText` 快照（不受题库编辑影响） | 无题库/练习来源回链；无法区分"题库题/临场记录/练习过的题" | 可空 `sourceQuestionId`+`sourceKind`（D4）；快照仍是唯一展示真相 |
| C7 | 复盘草稿/完成状态 | 仅 `reflectionText`+items 存在性可推断"有无内容" | 无显式完成标记；"待复盘"判定只能猜 | `reflectionCompletedAt` 显式列（D2）或派生谓词；首页读取契约见 §7 |
| C8 | 复盘修改历史 | `updatedAt` 时间戳；保存为整组替换 | 无版本留痕 | 推荐不加 revision 表，复盘是用户叙述可编辑（D3） |
| C9 | 复盘→改进动作 | 无链路 | "改进事项转入现有 Tasks"无路径；`TaskForm` 无预填入口 | 用户确认的预填创建 Task（深链+表单初始值），不加回链列（D8） |
| C10 | 真实 vs 模拟边界 | `InterviewSession` 独立域，job+JD 成对链接 | 复盘↔练习会话无显式链（按职位聚合可看） | 不加链接列，按 job+JD 聚合展示（D11） |
| C11 | 归档/恢复/删除 | 职位归档→子树只读（复盘 save 被拒、get 放行）；Step 删除 Cascade | 删除 INTERVIEW Step 的确认文案不提示复盘级联；`Attempt.archivedAt` 无写路径；AI 草稿读未过滤归档（G-AI1） | INTERVIEW 删除警示文案；AI 读过滤补齐；Attempt 独立归档本期不产品化（D9/D10） |
| C12 | 时间/精度语义 | Step 三组 frozen 三元组 + `unknown` 精度展示 | "面试实际发生时间"语义未定；"已结束、待复盘"判定未定义 | 复用 `scheduledAt`/`completedAt` 不加列（D5）；确定性谓词与读取契约（D6，§7） |
| C13 | 旧数据/备份 | 迁移不伪造材料；备份已含全部相关模型 | 若加新列需 additive migration+备份可选字段 | 单条 additive migration+备份字段+版本 bump（P-A 内） |
| C14 | AI/Agent 边界 | AI 复盘已 draft-only，服务端不落库 | 无正式合同化表述；草稿读未排除归档父机会（G-AI1） | §11 边界条款 + P-A 归档过滤修复 |
| C15 | InterviewDetail 元数据列 | `interviewFormat/roundLabel/locationText/interviewerNames/durationMinutes` 存在 | **无写路径**（additive-only 预留） | 本期保留不接线（D7）；AI prompt 已读 |
| C16 | 复盘可写时机 | 任意 INTERVIEW Step（含未关闭/EVIDENCED/SYSTEM 来源）可写 | —— | 保留现状：预记录允许（§6.4） |

---

## 4. 联合领域模型：正式关系与基数

### 4.1 核心链（合同定义）

- `JobOpportunity` **1—N** `ApplicationAttempt`：一个职位可有多次投递事实（多渠道/多次申请）。Attempt 归属且仅归属一个职位。
- `ApplicationAttempt` **1—N** `ApplicationProcessStep`：步骤按 `sortOrder` 排序，类别由 `category` 区分。
- `ApplicationProcessStep` **0..1** `ApplicationInterviewDetail`：**真实面试轮次 = `category === "INTERVIEW"` 的 ProcessStep + 其可选一对一 detail**。`roundLabel` 不是轮次事实源——轮次身份 = Step 行（`sortOrder`/`category`/时间三元组）；`label`/`roundLabel` 仅为展示辅助。多轮面试 = 多个 INTERVIEW Step。
- `ApplicationInterviewDetail` **1—N** `ApplicationInterviewReflectionItem`：有序（`sortOrder`，10/20/30 约定）问答条目，`questionText` 为当时问题文本快照。
- `JobOpportunity` **1—N** `JobDescriptionVersion`：JD 版本只增不改；`currentJdVersionId` 指向"当前展示版本"（可变），`submittedAgainstJdVersionId` 指向"投递时版本"（不可变）。
- `ResumeVariant` → `JobOpportunity`（`targetJobOpportunityId`，0..1，可变）：**计划绑定**——"打算为这个职位用这份简历家族"，具体版本随 `currentVersionId`/编辑流转。
- `ApplicationAttempt` → `ResumeVariantVersion` / `ResumeArtifact` / `JobDescriptionVersion`（三个 `submitted*`，各 0..1，**不可变首绑**）：**实际投递事实**。
- `JobOpportunity` **1—N** `InterviewSession`（+ 成对 `jobDescriptionVersionId`）：模拟/练习会话，属于练习域，不是真实面试轮次（§8）。
- `Question` ← 0..1（可选，`[增量]` 若 D4-a 裁定）`ApplicationInterviewReflectionItem.sourceQuestionId`：复盘问题的题库来源回链；`questionText` 快照仍是唯一展示真相。
- `Task`：与复盘无外键关系；改进事项经用户确认的预填创建（D8），不回链。

### 4.2 "计划使用"vs"实际投递"（回答合同问题 2/3/4）

| 维度 | 计划使用 | 实际投递 |
|---|---|---|
| 载体 | `ResumeVariant.targetJobOpportunityId`（+`currentVersionId` 指向当前版本） | `ApplicationAttempt.submittedResumeVersionId` / `submittedResumeArtifactId` / `submittedAgainstJdVersionId` |
| 可变性 | 可变：换绑职位、编辑出新 DRAFT、切换版本都合法 | **首绑后不可变**：服务层 CAS 只允许在 NULL 上写入，冲突报 `*_CONFLICT` |
| 语义 | "打算/正在准备" | "当时真实投出的版本+文件+针对的 JD" |
| 追溯键 | Variant id（家族）+ 动态版本 | 版本行 id（不可再编辑的快照行）+ artifact `sha256` + JD version id |

结论：**现有 `submittedResumeVersionId`/`submittedResumeArtifactId`/`submittedAgainstJdVersionId` 已满足合同**（含自动绑 `currentJdVersionId`、artifact↔version 一致性、Restrict 防删）。唯一缺口在**展示层**——职位详情未把"计划 vs 实际"聚合成可对照视图，属 P-B 的 UI 增量，不加列。

### 4.3 投递后不可变清单（合同形式化）

以下在写入后成为历史事实，任何后续编辑/删除/归档/恢复不得改写：

1. `ApplicationAttempt.submittedAt`、三个 `submitted*` 引用（服务强制 + `Restrict` FK）。
2. `ResumeVariantVersion` 处于 `FROZEN/SUBMITTED` 的内容（简历合同已冻结：`cloneAsDraft` 产生新行 id，主键不能作跨版本对应键）。
3. `JobDescriptionVersion.rawContent/contentHash/versionNumber/capturedAt`。
4. `ResumeArtifact` 行的 `kind/format/storageKey/sha256`（字节丢失≠事实丢失，可重导出）。
5. `ApplicationInterviewReflectionItem.questionText`（题库侧后续编辑不影响快照——`Question` 可变但快照独立；用户自己改复盘条目属 §6.3 的叙述编辑，不是"被覆盖"）。
6. ProcessStep 已完成状态的时间三元组：完成后仅 `notes/result` 可写，`undefined` 输入不触碰历史精度。

归档/恢复语义：归档只改 `archivedAt` 并置子树只读；恢复移除 `archivedAt`；**两者都不触碰以上任何字段**（与归档合同一致）。

---

## 5. 真实面试轮次：复用现有结构（回答合同问题 1/5）

**推荐：不新增"真实面试"实体。** `ProcessStep(INTERVIEW)` + `InterviewDetail` 1:1 已能承载轮次身份、时间与复盘，理由：

- 轮次事实源（顺序、计划/截止时间、完成状态、结果、来源）已在 `ProcessStep`；`InterviewDetail` 是"该轮为面试"的详情根，`@unique` 保证 1:1。
- 新实体会复制 `scheduledAt/completedAt` 三元组、status、sortOrder、reminder 联动等已有能力，产生双写风险。
- `ApplicationAssessmentDetail`/`ApplicationOfferDetail` 已证明该"category + 可选 detail"模式是仓库既定形状。

`InterviewDetail` 上的**预留元数据列**（`interviewFormat/roundLabel/locationText/interviewerNames/durationMinutes`）当前无写路径；D7 决定本期是否接线编辑面。`structuredData` 仍**不是**复盘存储（源码注释即此意）。

`[待核实]` `ApplicationAssessmentDetail`/`ApplicationOfferDetail` 的写路径同样未见——与 INTERVIEW 平行确认即可，不在本合同范围。

---

## 6. 复盘合同（回答合同问题 6/7）

### 6.1 存储形状（[已存在]，增量见 D 项）

- 整体复盘：`ApplicationInterviewDetail.reflectionText`（自由文本）。
- 逐题：`ApplicationInterviewReflectionItem { questionText*, answerNotes, sortOrder }`，`questionText` 非空。
- 保存语义：整组替换（传入 id 的 upsert + 删除未传入项 + 更新 `reflectionText`，单事务）——**复盘是用户叙述，可整组重编**。
- `[增量]`（D2-a 裁定时）：`ApplicationInterviewDetail.reflectionCompletedAt DateTime?`——显式"已完成复盘"标记；`NULL` = 草稿/未标记。存量行一律 `NULL`，不回填（§10）。
- `[增量]`（D4-a 裁定时）：`ApplicationInterviewReflectionItem.sourceQuestionId String? → Question`（`Restrict`，`Question` 侧需同时加 `reflectionItems` back-relation）+ `sourceKind String?`，值集 `REFLECTION_ITEM_SOURCE_KIND = { QUESTION_BANK, AD_HOC, PRACTICE_SESSION }`——复盘条目独立值集，不与 `QuestionInstance.sourceKind`（`USER_PROVIDED/QUESTION_BANK/AI_GENERATED/TEMPLATE`）混用；`PRACTICE_SESSION` 项的 `sourceQuestionId` 自 `QuestionInstance` 继承。

### 6.2 问题来源与快照（回答合同问题 6）

**混合方案（推荐，D4-a）**：

- `questionText` 必填快照是**唯一展示真相**——题库后续编辑、删除、恢复都不改写复盘里已保存的文本。
- `sourceQuestionId`（可空）记录"此题来自题库某题"的来源回链；`sourceKind` 区分 `AD_HOC`（临场记录）/`QUESTION_BANK`/`PRACTICE_SESSION`（从练习会话带入 `QuestionInstance.displayedText`）。
- 删除语义：若 D4-a，推荐 `Restrict`——被复盘引用的题不可物理删除（与 `submitted*` 引用同一先例）；题库"删除"对用户呈现为被阻止并说明原因。题库如需"下架"语义，用 `isActive/deletedAt` 软删（interview planning 读侧已过滤；`getQuestionsList` 未过滤，启用软删需一并补过滤）——已核实：当前 `question.actions` 删除为硬删除、无软删写路径，需 D4 一并裁定删除 UX（被引用题的拒绝提示文案）。

**从练习会话导入**（可选产品增强，非必须）：复盘对话框提供"带入练习过的题"——copy `QuestionInstance.displayedText → questionText`，继承 `sourceQuestionId`。不加表，仅 UI+服务读取。

### 6.3 复盘状态、可编辑性与历史（回答合同问题 7）

- **可写时机**：任意 INTERVIEW Step（含未关闭、`EVIDENCED`、非 USER 来源）均可写复盘——保留现状，支持"提前列提纲/临场记录"。归档职位下整体只读。
- **状态**（依 D2）：推荐显式 `reflectionCompletedAt`——`NULL`=草稿/未标记；非空=用户确认完成。若 D2-b（派生），完成 = detail 存在且（`reflectionText` 非空或 items ≥1）。
- **完成标记写路径**（D2-a）：`saveInterviewReflection` 输入扩展 `reflectionCompleted: boolean`——「保存并标记完成 / 保存为草稿」是同一事务内的同一写路径；`reflectionCompletedAt` 由服务端置 `new Date()` 或 `NULL`，不接受客户端时间。已标记完成后再次保存默认保留标记；「取消完成」为显式 UI 动作置 `NULL`。空保存沿用现有早退语义；已标完成的复盘被清空内容时仍保留标记（有标记无内容是合法但无意义的用户选择，谓词按 §7 判其"已复盘"）。
- **旧数据默认值**（D2-a）：存量行一律 `reflectionCompletedAt = NULL`（=未标记/草稿），不回填推断；UI 对"有内容未标记"的老数据显示"草稿·未标记完成"，用户一次保存即可标记（§10）。
- **修改历史**（D3）：推荐**不加** revision 表——复盘是用户叙述而非系统事实，允许自由重编；`updatedAt` 已提供最近修改时间。若 Owner 要求留痕，后续可加 `ApplicationInterviewReflectionRevision` 附录表（本合同不展开）。
- **完成后重开**（D3）：推荐允许自由编辑，不清除 `reflectionCompletedAt`；"取消完成标记"作为显式 UI 动作（置 NULL）。复盘不锁定。
- **是否驱动申请状态**：**不驱动**。复盘完成不写 `Attempt.currentStageCategory/outcome`、不改 Step `status/result`；这些仍是用户显式管理的事实。UI 可提示但不得自动写。

### 6.4 复盘与面试轮次的绑定纪律

- 复盘挂在 `InterviewDetail`（即 Step）上，不挂 Attempt/Job——同一职位多轮面试各有独立复盘。
- `saveInterviewReflection` 已断言 `category === "INTERVIEW"`——非面试 Step 不能写复盘（服务层保证）。
- Step 删除 → detail+items 级联删除（D9 决定 UX 警示级别）。

---

## 7. "已结束、待复盘"确定性判定与首页读取契约（回答合同问题 10）

### 7.1 确定性谓词（供概览/NEXT-ACTIONS 消费，本合同只定义判定不实现概览）

```
awaitingReflection(interviewStep) :=
    step.category === "INTERVIEW"
 ∧  step.status === "COMPLETED"              -- 用户显式标记结束（completedAt/completedAtPrecision 同写）
 ∧  reflectionComplete(step.interviewDetail) === false
```

`reflectionComplete(detail)` 依 D2 裁定：

- D2-a：`detail.reflectionCompletedAt IS NOT NULL`
- D2-b：`detail` 存在且（`reflectionText` 非空白或 `reflectionItems >= 1`）

- `CANCELLED` 不计"已结束"（面试未发生）；`PENDING/IN_PROGRESS` 不计。
- **不**用 `scheduledAt < now` 推断"已结束"——用户可能未标记完成；过期未关闭只走 §7.2 弱提示，不进确定性谓词。
- `[待核实]` 迁移产生的 `status: "EVIDENCED"` 不在 `PROCESS_STEP_STATUS` 常量内：若其语义确认为"该阶段已发生"，谓词应纳入；裁定前按"非 COMPLETED"处理（不误报）。
- 时间精度：谓词只依赖 `status`（枚举）与完成标记（instant），**不依赖** `scheduledAt` 精度——历史未知精度不影响判定。

### 7.2 过期未关闭：确认提示，不计入

`category=INTERVIEW` 且 `status` 未关闭（`PENDING/IN_PROGRESS`）且 `scheduledAtPrecision === "minute"` 且 `scheduledAt < now`（Instant 比较，展示按账户时区，DATETIME 合同）的 Step **不进入** `awaitingReflection`，但产生一条弱提示"该面试时间已过，确认是否已结束？"——用户确认 → 标记 `COMPLETED` 后才可能进入待复盘；用户标记 `CANCELLED` 则终结。`scheduledAt` 不支持 DateOnly；缺失、unknown 或非法精度 **不触发**该提示（不过度猜测）。

### 7.3 首页读取契约（DTO 形状，概览 Owner 消费）

新读模型 `listAwaitingReflectionInterviews(userId, { limit })`（建议落 `upcomingReadModel` 同层，服务侧实现）：

```ts
interface AwaitingReflectionInterviewItem {
  stepId: string;
  attemptId: string;
  jobOpportunityId: string;
  jobTitle: string;
  companyName: string | null;
  stepTitle: string;
  roundLabel: string | null;        // InterviewDetail.roundLabel
  scheduledAt: string | null;       // ISO；渲染按精度走 DATETIME 合同
  scheduledAtPrecision: "minute" | "unknown" | null;
  completedAt: string | null;
  completedAtPrecision: "fullInstant" | "unknown" | null;
  hasReflectionDraft: boolean;      // detail 存在且有内容但完成标记为空（D2-a）
}
interface AwaitingReflectionResult {
  items: AwaitingReflectionInterviewItem[];   // completedAt desc（空值末尾），同值按 stepId 升序
  totalCount: number;                        // 待复盘总数，截断前计数
  overdueUnclosedCount: number;               // §7.2 弱提示计数，与 items 分离
}
```

- 过滤：`userId` 链式校验 + 父 `JobOpportunity.archivedAt IS NULL` + `ApplicationAttempt.archivedAt IS NULL`（归档职位的待复盘**不进首页聚合**；职位详情内仍只读可见）。
- 查询有界且无 N+1：采用聚合/批量查询（数量不随 Step 条数增长），返回按调用方 limit 截断的 items 与待复盘总数 totalCount；计数和分页使用同一过滤/谓词，供首页准确展示 +N。不要求 Prisma 必须生成单条 SQL JOIN。
- Attempt outcome 范围随 D6 共同裁定：本提案推荐未归档终态 Attempt 下的 COMPLETED 轮次仍可待复盘（复盘不等同于继续投递/准备行动）；此为推荐非批准。首页不得自行再过滤 outcome，裁定变更时由本领域统一调整过滤。
- 消费方：概览/NEXT-ACTIONS 只读本结果，不自行重算谓词。

### 7.4 与概览合同的交叉协调（Owner 单点裁定）

概览合同 §9 D3 与本合同 §13 D6 已统一协调建议为仅 status=COMPLETED，过期未完成仅提示确认状态；该建议尚未获 Owner 批准。冻结前由 Owner 同一次裁定两处，并同时裁定 D2 完成标记语义；若选择 D2-a，首页不得在字段/接口未就绪时用“有内容即完成”代替——NEXT-ACTIONS 只能消费同一个判定结果，不允许两模块各算各的。

---

## 8. 真实面试复盘 vs InterviewSession 边界（回答合同问题 8）

| | 真实面试（本合同） | 模拟/练习（InterviewSession） |
|---|---|---|
| 事实性质 | 真实发生的事（用户记录） | 练习产物 |
| 挂载 | `ApplicationAttempt → ProcessStep(INTERVIEW) → InterviewDetail` | `InterviewSession`（可选 job+JD 成对链接） |
| 问题 | `ReflectionItem.questionText`（快照）+可选 `sourceQuestionId` | `QuestionInstance.displayedText`（快照）+`sourceQuestionId`+`sourceKind` |
| 状态机 | Step `PENDING/IN_PROGRESS/COMPLETED/CANCELLED`（+复盘完成标记） | `DRAFT/IN_PROGRESS/COACHING/COMPLETED/ARCHIVED`（`ARCHIVED`/`archivedAt`/`statusBeforeArchive` 存在；持久化 patch 类型可写但**全仓无调用方**——无产品化归档路径，本期不产品化，`[待核实]` 语义归属归档合同后续批次） |
| 复盘归属 | `reflectionText`+items | 练习无"复盘"概念（`AnswerAttempt`/评估属于练习域） |

- 复盘**不引用** `InterviewSession`/`QuestionInstance` 作为主数据（D11 推荐不加链接列）；两域只在职位+JD 维度聚合展示（"为这个职位练过哪些会话/投过哪些 Attempt/面过几轮"）。
- 练习会话可继续绑定 job+JD（现状）；真实面试轮次的创建入口在 Attempt 时间线，不在 `/dashboard/interview`。

---

## 9. 归档、删除、权限与恢复（回答合同问题 9）

- **职位归档**：`JobOpportunity.archivedAt` → 全子树只读（Attempt/Step/detail/reflection 写入全被 `assertOpportunityWritable` 阻断）；读取（含复盘 get）放行——符合归档合同"详情只读"。恢复后恢复写入。**归档/恢复不改写任何历史字段**。
- **Attempt 独立归档**：`ApplicationAttempt.archivedAt` 存在但无写路径（`[保留]`）。本期**不产品化**（D10）；若后续启用，复盘跟随 Attempt 的只读语义，规则同职位归档。
- **跨用户隔离**：所有读写经 `userId` 链式校验（`requireOwnedStep`/`requireOwnedAttempt`/`assertOwnedOpportunity`）；复盘/AI 草稿同样 scope；备份按用户导出。**无跨用户共享面**。
- **删除策略**：
  - `submitted*` 引用的版本/artifact/JD version：`Restrict` FK 物理防删（现状）。
  - `ProcessStep` 删除：仅 `source === "USER"`；Cascade 删 detail+items。D9 推荐保持可删+强化确认；备选"有复盘禁删"。INTERVIEW Step 删除确认文案必须额外明示"将同时删除该轮的面试详情与 N 条复盘问答"（`DeleteAlertDialog` 现按统一文案，需按 `category`/detail 存在性加分支）；非 INTERVIEW Step 文案不变。
  - `InterviewDetail` 无独立删除入口（只随 Step 级联）——清空复盘内容保留空 detail，行存在性不作"有无复盘"信号（§6.3）。
  - `Question`：若 D4-a（Restrict 回链），被复盘引用的题不可物理删除；未引用题维持现状删除路径。
  - `InterviewSession`：无删除/归档写路径（`[待核实]`），本合同不要求新增。
- **Legacy**：`Interview`/`JobContact` `DO_NOT_MAP` 不迁移；迁移不伪造提交材料/面试历史——新列回填规则见 §10。

---

## 10. 迁移、备份与恢复（回答合同问题 11）

若 D2-a/D4-a 裁定通过（本合同推荐的唯一 Schema 增量）：

1. **一条 additive migration**（不得改写已执行 migration）：
   - `ApplicationInterviewDetail` + `reflectionCompletedAt DateTime NULL`
   - `ApplicationInterviewReflectionItem` + `sourceQuestionId TEXT NULL → Question`（`Restrict`）+ `sourceKind TEXT NULL`
   - 新索引：`ReflectionItem(sourceQuestionId)`（可选，查询来源用）。
2. **回填**：**无**——老行 `NULL` 语义安全（`= 未标记完成/无来源记录`）。不推断历史复盘是否"完成"：`reflectionCompletedAt` 老行保持 NULL，UI 对"有内容但未标记"的老数据按"草稿/未标记"展示（D2-a 语义）；若产品要求老数据视为已完成，需在冻结时显式裁定一次性回填（本合同默认不回填）。
3. **备份**：`backup/schema.ts` 相应 optional 字段 + `ApplicationInterviewReflectionItem.fks` 增 `sourceQuestionId → "Question"`（`Question` 在 `INSERT_ORDER` 远早于复盘项，顺序安全）；`BACKUP_FORMAT_VERSION` bump 至集成时下一个版本；旧格式备份恢复→新列 NULL。
4. **恢复顺序**：沿用现有拓扑；新 FK 不构成环，不进 `DEFERRED_FKS`。
5. **原子性**：新列随现有事务写入；导入失败沿用现行整体失败策略，不允许部分恢复。

---

## 11. Agent / AI 边界（回答合同问题 12）

### 11.1 可读上下文（userId scope，未归档）

未来 Agent 生成复盘草稿可读取：职位行（title/company/status）、Attempt（`submittedAt`/`currentStageCategory`/`outcome`/`submitted*` 引用 + 提交物摘要——`ResumeVersion.contentJson` 或 artifact 提取文本的**裁剪摘要**，非全量）、Step 全链、InterviewDetail+items、JD 版本（`parsedJson`/`rawContent` 裁剪）、该 job+JD 下练习会话的存在性与计数（不默认喂全文）。沿用 `interviewReflectionAi` 的 `clip()`/字段白名单模式——**只取生成所需字段**。

### 11.2 归档与权限

- 父 `JobOpportunity.archivedAt` 非空的上下文**不得进入** AI/Agent 输入（归档合同 D6「AI 不得读归档」）。**G-AI1 已独立修复集成**（8b09faf1）：入口及配置解析后检查归属/存在性与两级归档状态，再组装模型请求；归档错误码透传。该保护是执行层调用前的快照检查，不是 Provider 全生命周期锁；验证及未覆盖边界见 P2_FEATURES.json 的 INTERVIEW-DEBRIEF 记录。
- 全部读/写维持 `userId` 链式校验；无跨用户共享面。

### 11.3 生成与落库边界

- **现状已满足**（合同确认并形式化）：`generateInterviewReflectionDraft` 只产草稿、服务端不落库；持久化必经用户 Apply+Save 走 `saveInterviewReflection`。
- 本合同的复盘生成路径（含未来 Voca Reflect 的复盘草稿能力）**不得**：直接写 `reflectionText`/items、置 `reflectionCompletedAt`、改 `submitted*`/`submittedAt`、改 Step `status/completedAt`、替用户"完成"复盘或标记面试结束、创建 `Task`/`JobOpportunity`/`ApplicationAttempt`/`ProcessStep`/`InterviewDetail` 行。
- 上述禁令仅约束复盘生成路径，不撤销其他业务工具已授权的行为（如 Pilot 的 add_job 及 Insight 的批准制匹配分析）；角色与工具边界仍按各自合同。
- 复盘 AI/Agent **可以**：产出建议文本/问题候选/复盘草稿——全部停在客户端草稿态，用户显式确认后走现有写路径（含复盘→Task 预填，§13 D8）。
- `CAREER_REFLECTION` 用途与 TEXT_ONLY 边界沿用；新增 AI 能力需走既有 purpose 注册与 `NOT_CONFIGURED` 诚实态模式。

---

## 12. 与上游冻结合同的一致性检查

| 上游语义 | 本合同 |
|---|---|
| 简历版本 `DRAFT/FROZEN/SUBMITTED/ARCHIVED`，提交行不可编辑，`cloneAsDraft` 新行 id | 沿用；提交引用绑到版本行而非家族，符合"主键不作跨版本对应键" |
| `ResumeVariantVersion.targetJdVersionId` 本期不接线 | 不动；JD 关联走 `submittedAgainstJdVersionId` |
| 归档不是删除；canonical 职位可恢复；历史关联保留 | 沿用；复盘随父级只读/恢复；不要求 Legacy Job 精确恢复语义 |
| 归档拒绝新增 Attempt/Step/笔记/投递写入（服务层 `userId` 隔离） | 已核实一致：复盘 save 走同一 `assertOpportunityWritable` |
| `DateOnly`/`Instant`、未知精度展示 `unknown`、`undefined` 不触碰原字段 | 沿用；"已结束"谓词不依赖 `scheduledAt` 精度 |
| 未设账户时区用运行时系统时区且不回写 | 沿用；本合同不新增时区写路径 |
| 投递引用永久防改写 | 沿用；新增 `sourceQuestionId` 选 `Restrict` 与之一致 |
| AI 不得读归档（归档合同 §9 D6） | G-AI1 已独立集成（8b09faf1），现有守卫与边界见 §11.2 |

跨合同共同待裁定一项：§7.4「已结束」谓词口径 vs 概览合同 §9 D3——Owner 单点裁定后两合同对齐，不算两合同各自实现的自由。其余未发现冲突。

---

## 13. Owner 决策表（编号；每项 2–3 互斥选项）

| # | 待决项 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D1 | 真实面试轮次实体 | (a) 复用 `ProcessStep(INTERVIEW)+InterviewDetail`；(b) 新增 `RealInterview` 实体；(c) 扩展 `InterviewSession` | **(a)** | (a) 零 Schema、无双写；(b)/(c) 复制时间/状态/reminder 能力并混淆练习域 |
| D2 | 复盘完成/草稿标记 | (a) `InterviewDetail.reflectionCompletedAt` 显式列；(b) 派生谓词（有内容=已复盘）；(c) 不区分 | **(a)** | (a) 确定性、支持"有内容但未完成"草稿态，NEXT-ACTIONS 可直接消费；(b) 无法区分草稿；(c) "待复盘"无法判定 |
| D3 | 复盘可编辑性/留痕 | (a) 自由编辑+`updatedAt`，完成后可重编；(b) 完成后锁定+显式重开；(c) revision 历史表 | **(a)** | (a) 复盘是用户叙述，最简；(b) 增加状态复杂度；(c) 新表+备份+UI，范围扩大（可后续追加） |
| D4 | 面试问题↔题库 | (a) 快照+可空 `sourceQuestionId`/`sourceKind`（`Restrict`）；(b) 纯快照不加引用；(c) 仅引用不快照 | **(a)** | (a) 可回溯"哪题来自题库/练习"，编辑题库不篡改历史；(b) 丢来源但已满足防篡改；(c) 题库编辑会改写历史——**不可接受** |
| D5 | 面试实际发生时间 | (a) 复用 `scheduledAt`（计划/可调）+`completedAt`（标记结束时刻），不加列；(b) 新增 `occurredAt` 三元组 | **(a)** | (a) 零 Schema，scheduledAt 可由用户改到实际时间；(b) 第三套时间语义，迁移/UI 成本 |
| D6 | "已结束、待复盘"判定 | (a) 仅 `status === "COMPLETED"`（§7.1 谓词）；(b) 过期未关闭也计入（宽口径）；(c) 用户手动标记"待复盘" | **(a)**；过期未关闭另设 §7.2 确认提示，不计入 | (a) 确定性最强、与协调建议一致；(b) 为宽口径备选，会误报未标记完成的轮次；**两合同当前均推荐 (a)，仍须 Owner 同一次批准**（§7.4）；(c) 放弃自动化；本项附带裁定未归档终态 Attempt 是否保留待复盘（§7.3），首页同步消费 |
| D7 | `InterviewDetail` 元数据列接线 | (a) 本期接线编辑面；(b) 保留不接线；(c) 删除列 | **(b)** | (b) 最小增量，AI prompt 已可读；(a) 扩大 UI 范围可后续单独排期；(c) 破坏已部署列的备份兼容 |
| D8 | 复盘→改进任务 | (a) UI"转为任务"预填创建 `Task`，不加回链列；(b) `Task` 加 `sourceType/sourceId` 回链；(c) 不做 | **(a)** | (a) 用户确认即建，零 Schema；(b) 需动共享 Task 模型；(c) 不满足 P2"改进转入 Tasks"决定 |
| D9 | 含复盘 Step 的删除 | (a) 保持可删+删除确认明示级联复盘；(b) 有复盘则禁删（先清空复盘）；(c) 复盘独立归档 | **(a)** | (a) 尊重用户数据自主，成本最低；(b) 增加删除摩擦；(c) 引入新状态维度 |
| D10 | `Attempt.archivedAt` 独立归档 | (a) 本期不产品化，保留列语义；(b) 本期产品化 | **(a)** | (a) 对齐归档合同"后续批次"口径；(b) 需完整 UI/恢复路径，范围扩大 |
| D11 | `InterviewSession`↔真实轮次显式链 | (a) 不加列，按 job+JD 聚合展示；(b) `InterviewSession.applicationProcessStepId` 可空链 | **(a)** | (a) 零 Schema，聚合已可达；(b) 需处理 Step 删除/转移一致性，收益小 |
| D12 | 复盘字段结构 | (a) 保持 `reflectionText` 自由文本+逐题 `answerNotes`；(b) 拆结构化字段（表现/改进/行动） | **(a)** | (a) 最小增量，AI 草稿已产分段自由文本；(b) 便于机器消费但增加 Schema/UI，可由 Voca Reflect 阶段再评估 |

**裁定后冻结点**：D2/D4 决定是否进 P-A 的 Schema 增量；其余为产品语义冻结，不动 Schema。

---

## 14. 冻结后的实施包、依赖与 Owner

### 14.1 包划分（按用户成果；Schema/Migration/备份并入业务交付，不设纯技术包）

| 包 | 成果 | 主要文件 | 依赖 |
|---|---|---|---|
| **P-A INTERVIEW-DEBRIEF 复盘核心（单一 Owner）** | D2-a/D4-a 裁定列 + additive migration + 备份字段/FK/版本 bump；save DTO 扩展（`reflectionCompleted`/`sourceQuestionId`/`sourceKind`）；§7.1 谓词 + §7.3 `listAwaitingReflectionInterviews` 读取模型（首页契约提供方）；对话框 UI（完成标记/题库引用/可选练习导入）；保留已集成 G-AI1 归档守卫；INTERVIEW 删除级联警示；复盘→Task 预填入口 | `prisma/schema.prisma`、`prisma/migrations/<new>/`、`src/lib/backup/schema.ts`、`src/lib/backup/ordering.ts`、`src/lib/career/interviewReflection.ts`、`src/lib/career/applicationService.ts`、`src/lib/career/upcomingReadModel.ts`（新读模型同层）、`src/lib/career/interviewReflectionAi.ts`、`src/components/myjobs/job-details/InterviewReflectionDialog.tsx`、`ApplicationTimelineTab.tsx`、`TaskForm.tsx`/Task 创建入口 | 必须先冻结 D1–D12；无其他包前置 |
| **P-B JOB-CONNECTIONS 聚合视图** | 职位详情"计划 vs 实际投递"对照：计划绑定 Variant、每 Attempt 的提交版本/artifact/JD 版本摘要、该职位练习会话计数 | `src/lib/career/applicationTimeline.ts`（DTO 扩展）、`src/lib/career/jobOpportunityAdapter.ts`（include）、`src/components/myjobs/job-details/ApplicationTimelineTab.tsx`、`SubmittedResumePanel.tsx`（小改或新增对照面板） | 不依赖 P-A 新列（只读现有字段），可与 P-A 并行 |
| **P-C 首页/NEXT-ACTIONS 消费（概览合同 Owner）** | "待复盘面试"卡片/计数接入 §7.3 读取模型；§7.2 过期确认提示入口 | 概览侧首页组件与 NEXT-ACTIONS 组装（概览合同文件集） | **可先行**：UI 壳、空态、加载态、路由接线不依赖本合同；**必须等 P-A**：真实数据接入需 §7.3 读取模型落地 + D6 口径裁定 |
| **P-D Agent 复盘生成（后续批次）** | Agent 读取 §11.1 上下文产出草稿 | `interviewReflectionAi.ts` 复用/扩展 | 必须等：P-A 完成（完成标记语义；G-AI1 已独立集成）+ §11.1 冻结 |

### 14.2 串行/并行与单一 Owner

- **必须先完成**：D1–D12 裁定 → P-A 启动（其 Schema/备份/migration 段为**单一 Owner**，含 `prisma/schema.prisma` 与 `src/lib/backup/*`，作为业务交付的一部分，不单独派技术包）。
- **可与首页并行**：P-C 的 UI 壳/空态/加载态/路由接线；P-B 聚合视图（只读现有列）。
- **必须等待**：P-C 真实"待复盘"数据（等 P-A 读取模型 + D6 裁定）；P-A 内部复盘 UI/写路径（等 D2/D4 列语义，同包内顺序）；题库引用 UI（等 D4-a）；P-D Agent（等 §11.1 冻结；G-AI1 已独立集成）。
- **共享物理文件唯一 Owner**：`ApplicationTimelineTab.tsx` 同时被 P-A（删除警示）与 P-B（对照面板）触及——不按 hunk 分两个 Owner 并行改；指定唯一 Owner（建议归 P-B，P-A 的警示文案作为顺序交接的第二个改动）或由主协调裁定顺序。`src/i18n/messages` 由主协调指定一名 Owner，各包提 key 清单合入；`wiki/P2_FEATURES.json`/`P2_IMPLEMENTATION.md` 仅 Main 集成 Owner 在集成后更新。
- **测试归属**：各包自带定向验证（隔离 DB migration、服务不变量、组件测试），不拆独立"测试包"。

### 14.3 建议依赖顺序

```
D1–D12 裁定冻结 ─→ P-A（复盘核心，含 Schema/备份）─┬→ P-C 数据接入（概览 Owner 消费 §7.3）
                 ├→ P-D（Agent 生成，后续批次）
                 └─ P-B（聚合视图，可与 P-A 并行启动，注意共享文件顺序交接）
```

（若 D2-b/D4-b 裁定——即不加列——P-A 的 Schema/备份段为空包，其余不变；P-C 谓词改用 D2-b 派生定义。）

---

## 15. 最小验收矩阵（仅定义，不执行）

| # | 场景 | 验证点 |
|---|---|---|
| A1 | **隔离数据库** | 全新 migrate 后新列存在且可空；从变更前备份升级到新版可恢复，老行 `reflectionCompletedAt/sourceQuestionId` 为 NULL 且语义安全 |
| A2 | **历史快照不变量** | 编辑/克隆简历版本→`submitted*` 引用与 SUBMITTED 行不变；编辑题库题→复盘 `questionText` 不变；新建 JD 版本→`submittedAgainstJdVersionId` 不变；归档→恢复→全部历史引用逐字段不变 |
| A3 | **归档/恢复** | 归档职位：Attempt/Step/复盘写入被拒、读取正常、upcoming 抑制；恢复后写入恢复；复盘在归档期保持只读可见 |
| A4 | **跨用户隔离** | 用户 B 无法读写 A 的 Attempt/Step/detail/reflection（服务+Action 层）；AI 草稿请求亦 scoped；备份导出仅含本用户 |
| A5 | **真实用户路径** | 建职位→绑计划简历→投递（绑版本+artifact+JD）→加 INTERVIEW Step→标记完成→复盘（题目+回答+总评+标记完成）→"待复盘"出现→完成标记后消失→归档→恢复→删除含复盘 Step 时警示 |
| A6 | **备份/恢复回环** | 导出含新列与 `sourceQuestionId` 重写；恢复后回链指向恢复库内 Question；旧版本备份恢复后新列 NULL |
| A7 | **删除拒绝** | 删 `submitted*` 引用对象被拒（Restrict）；删被复盘引用的题库题（D4-a）被拒；非 USER 来源 Step 不可删 |
| A8 | **谓词确定性** | CANCELLED/PENDING 不计"已结束"；`EVIDENCED`（待核实口径确认后）按裁定处理；`scheduledAt` 未知精度不影响判定 |
| A9 | **AI 边界** | AI 生成后未确认不落库；确认后走 `saveInterviewReflection`；`NOT_CONFIGURED` 诚实态；归档职位下 AI 草稿请求被拒（G-AI1 修复后） |
| A10 | **首页谓词/读模型** | `listAwaitingReflectionInterviews` 只返回 COMPLETED 且复盘未完成项；归档职位不计入；`overdueUnclosedCount` 与谓词分离；与概览 NEXT-ACTIONS 消费同一结果 |
| A11 | **复盘→Task 预填** | 入口仅用户显式触发；TaskForm 以初始值新建；保存走现有 Task 写路径；无自动创建/回链 |
| A12 | **复盘完成标记** | "有内容未标记"老数据显示草稿态；标记/取消标记/再编辑保存语义符合 §6.3 |

---

## 16. 待核实项汇总

| 项 | 现状 | 需要的确认 |
|---|---|---|
| `ProcessStep.status = "EVIDENCED"` | migrator 写入，但不在 `PROCESS_STEP_STATUS` 常量（`PENDING/IN_PROGRESS/COMPLETED/CANCELLED`） | 兼容值语义："已发生"是否纳入"已结束"判定；是否应入常量 |
| `ApplicationAttempt.archivedAt` | 列存在无写路径 | 语义归属（本合同按"保留，本期不产品化"处理） |
| `InterviewSession` `ARCHIVED`/`archivedAt`/`statusBeforeArchive` | 枚举+列存在；持久化 patch 类型可写但全仓无调用方（无产品化归档路径） | 是否属归档合同后续批次（本合同按"本期不产品化"处理） |
| `generateInterviewReflectionDraft` 归档过滤 | step 查询未过滤父机会 `archivedAt` | G-AI1 已独立集成，P-A 保留守卫（§11.2），不重复开发 |
| `InterviewDetail` 元数据列 | 存在无写路径 | D7 裁定 |
| `ApplicationAssessmentDetail`/`ApplicationOfferDetail` 写路径 | 未见 | 与 INTERVIEW 平行，不在本合同范围 |
| `Question.deletedAt/isActive` | interview planning 读侧过滤已核实；`getQuestionsList` 未过滤；写侧仅硬删除（被 `QuestionInstance` 引用的题 `Restrict` 阻止） | D4-a 裁定时需一并定题库删除 UX |
| `INTERVIEW_SESSION`/`QUESTION` 等在 upcoming/概览中的消费面 | 未全量核实 | NEXT-ACTIONS（另一合同）的职责，本合同只提供谓词 |

---

## 17. 附：推荐数据方案一句话

> 复用 `JobOpportunity → ApplicationAttempt → ProcessStep(INTERVIEW) → InterviewDetail → ReflectionItem` 现有树与 `submitted*` 不可变首绑；唯一 Schema 增量为 `InterviewDetail.reflectionCompletedAt` 与 `ReflectionItem.sourceQuestionId/sourceKind`（快照仍为唯一真相）；复盘是用户叙述可自由编辑、不驱动申请状态、AI 只产草稿；归档/恢复不改写任何历史字段；"待复盘"= `COMPLETED` 且完成标记为空（§7.1），首页经 `listAwaitingReflectionInterviews` 消费，过期未关闭仅提示确认。
