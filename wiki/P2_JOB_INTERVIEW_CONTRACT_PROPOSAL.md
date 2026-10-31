# P2 JOB-CONNECTIONS + INTERVIEW-DEBRIEF 联合数据与产品合同（提案）

- **状态**：提案（Proposal），待 Owner 裁定 §13 决策表后冻结
- **基线**：`main @ 96e896e3`（本提案引用的所有"源码事实"均以此基线的实际代码核实）
- **交叉项**：§13 D6「已结束」推荐仅 `status === COMPLETED`，与 [`P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md`](./P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md) §9 D3 推荐（`completedAt`∨COMPLETED∨逾期末关闭）冲突；冻结前须由 Owner 单点裁定，供 NEXT-ACTIONS 消费同一谓词。
- **覆盖 Feature**：`JOB-CONNECTIONS`、`INTERVIEW-DEBRIEF`（`wiki/P2_FEATURES.json`，当前 `implementationStatus: NOT_ASSESSED`）
- **上游已冻结合同**：`wiki/RESUME_BUILDER_CONTRACT_PROPOSAL.md`、`wiki/ARCHIVE_CONTRACT_PROPOSAL.md`、`wiki/DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`
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
- `InterviewReflectionDialog`：手动问答行（`questionText`+`answerNotes`）+整体 `reflectionText`；AI 生成→审阅→Apply→Save，落库前全在客户端。
- `ResumeVariantWorkspace`：`targetJob` 选择（归档禁用）；`ResumeVariantList` 显示 `targetJobTitle`。
- `/dashboard/interview`：练习会话列表带 `jobTitle·companyName`；`/new` 必须成对选择 job+JD；与真实面试时间线分离。
- `/dashboard/questions`：题库 CRUD（硬删除）。

---

## 3. 已有能力 / 真实缺口 / 推荐增量 对照表

| # | 合同需求 | 源码已有能力 | 真实缺口 | 推荐增量（最小） |
|---|---|---|---|---|
| C1 | 职位→投递→轮次链 | 完整实体树 + Timeline 读模型 + UI | 无（结构层面） | 无新增实体；仅 §5 形式化语义 |
| C2 | 计划 vs 实际材料区分 | `targetJobOpportunityId`（计划，可变）+三个 `submitted*`（实际，不可变） | 职位详情未聚合展示"计划用哪版/实际投了哪版/对哪份 JD/导出物"对照 | UI 聚合视图（IP-1），不加列 |
| C3 | 提交后引用不可变 | 服务强制首绑不可换绑 + `Restrict` FK + SUBMITTED 版本不可编辑 + JD 版本不可变 | 无 | 无；合同形式化 |
| C4 | `submitted*` 字段是否满足 | 满足"简历版本+导出物+JD"追溯 | 无 cover letter 等其他材料字段 | 本期不加（非目标）；导出物字节不进备份的语义沿用 |
| C5 | 真实面试轮次实体 | `ProcessStep(INTERVIEW)` + 0..1 `InterviewDetail` 已闭环 | 无（结构层面） | 推荐复用，不新增实体（D1） |
| C6 | 面试问题防篡改 | `questionText` 快照（不受题库编辑影响） | 无题库/练习来源回链；无法区分"题库题/临场记录/练习过的题" | 可空 `sourceQuestionId`+`sourceKind`（D4）；快照仍是唯一展示真相 |
| C7 | 复盘草稿/完成状态 | 仅 `reflectionText`+items 存在性可推断"有无内容" | 无显式完成标记；"待复盘"判定只能猜 | `reflectionCompletedAt` 显式列（D2）或派生谓词 |
| C8 | 复盘修改历史 | `updatedAt` 时间戳；保存为整组替换 | 无版本留痕 | 推荐不加 revision 表，复盘是用户叙述可编辑（D3） |
| C9 | 复盘→改进动作 | 无链路 | "改进事项转入现有 Tasks"无路径 | 用户确认的预填创建 Task，不加回链列（D8） |
| C10 | 真实 vs 模拟边界 | `InterviewSession` 独立域，job+JD 成对链接 | 复盘↔练习会话无显式链（按职位聚合可看） | 不加链接列，按 job+JD 聚合展示（D11） |
| C11 | 归档/恢复/删除 | 职位归档→子树只读（复盘 save 被拒、get 放行）；Step 删除 Cascade | 删除含复盘 Step 无额外警示；`Attempt.archivedAt` 无写路径 | 删除警示文案；Attempt 独立归档本期不产品化（D9/D10） |
| C12 | 时间/精度语义 | Step 三组 frozen 三元组 + `unknown` 精度展示 | "面试实际发生时间"语义未定；"已结束、待复盘"判定未定义 | 复用 `scheduledAt`/`completedAt` 不加列（D5）；确定性谓词（D6） |
| C13 | 旧数据/备份 | 迁移不伪造材料；备份已含全部相关模型 | 若加新列需 additive migration+备份可选字段 | 单条 additive migration+备份字段+版本 bump（IP-0） |
| C14 | AI/Agent 边界 | AI 复盘已 draft-only，服务端不落库 | 无正式合同化表述 | §11 边界条款（现状已满足，合同确认） |
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

结论：**现有 `submittedResumeVersionId`/`submittedResumeArtifactId`/`submittedAgainstJdVersionId` 已满足合同**（含自动绑 `currentJdVersionId`、artifact↔version 一致性、Restrict 防删）。唯一缺口在**展示层**——职位详情未把"计划 vs 实际"聚合成可对照视图，属 IP-1 的 UI 增量，不加列。

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
- `[增量]`（D2-a 裁定时）：`ApplicationInterviewDetail.reflectionCompletedAt DateTime?`——显式"已完成复盘"标记；`NULL` = 草稿/未标记。
- `[增量]`（D4-a 裁定时）：`ApplicationInterviewReflectionItem.sourceQuestionId String? → Question` + `sourceKind`（`QUESTION_BANK`/`AD_HOC`/`PRACTICE_SESSION`，新值集）。

### 6.2 问题来源与快照（回答合同问题 6）

**混合方案（推荐，D4-a）**：

- `questionText` 必填快照是**唯一展示真相**——题库后续编辑、删除、恢复都不改写复盘里已保存的文本。
- `sourceQuestionId`（可空）记录"此题来自题库某题"的来源回链；`sourceKind` 区分 `AD_HOC`（临场记录）/`QUESTION_BANK`/`PRACTICE_SESSION`（从练习会话带入 `QuestionInstance.displayedText`）。
- 删除语义：若 D4-a，推荐 `Restrict`——被复盘引用的题不可物理删除（与 `submitted*` 引用同一先例）；题库"删除"对用户呈现为被阻止并说明原因。题库如需"下架"语义，用 `isActive/deletedAt` 软删（读侧已过滤）——`[待核实]`：当前 `question.actions` 的删除是硬删除，软删无写路径，需 D4 一并裁定删除 UX。

**从练习会话导入**（可选产品增强，非必须）：复盘对话框提供"带入练习过的题"——copy `QuestionInstance.displayedText → questionText`，继承 `sourceQuestionId`。不加表，仅 UI+服务读取。

### 6.3 复盘状态、可编辑性与历史（回答合同问题 7）

- **可写时机**：任意 INTERVIEW Step（含未关闭、`EVIDENCED`、非 USER 来源）均可写复盘——保留现状，支持"提前列提纲/临场记录"。归档职位下整体只读。
- **状态**（依 D2）：推荐显式 `reflectionCompletedAt`——`NULL`=草稿/未标记；非空=用户确认完成。若 D2-b（派生），完成 = detail 存在且（`reflectionText` 非空或 items ≥1）。
- **修改历史**（D3）：推荐**不加** revision 表——复盘是用户叙述而非系统事实，允许自由重编；`updatedAt` 已提供最近修改时间。若 Owner 要求留痕，后续可加 `ApplicationInterviewReflectionRevision` 附录表（本合同不展开）。
- **完成后重开**（D3）：推荐允许自由编辑，不清除 `reflectionCompletedAt`；"取消完成标记"作为显式 UI 动作（置 NULL）。复盘不锁定。
- **是否驱动申请状态**：**不驱动**。复盘完成不写 `Attempt.currentStageCategory/outcome`、不改 Step `status/result`；这些仍是用户显式管理的事实。UI 可提示但不得自动写。

### 6.4 复盘与面试轮次的绑定纪律

- 复盘挂在 `InterviewDetail`（即 Step）上，不挂 Attempt/Job——同一职位多轮面试各有独立复盘。
- `saveInterviewReflection` 已断言 `category === "INTERVIEW"`——非面试 Step 不能写复盘（服务层保证）。
- Step 删除 → detail+items 级联删除（D9 决定 UX 警示级别）。

---

## 7. "已结束、待复盘"确定性判定（回答合同问题 10）

**定义（谓词，供概览/NEXT-ACTIONS 消费，本合同只定义判定不实现概览）**：

```
待复盘(interviewStep) :=
    step.category === "INTERVIEW"
 ∧  step.status === "COMPLETED"          -- 用户显式标记结束（completedAt/completedAtPrecision 同写）
 ∧  复盘未完成:
       D2-a:  step.interviewDetail.reflectionCompletedAt IS NULL
       D2-b:  step.interviewDetail IS NULL
              OR (reflectionText 空白 AND reflectionItems 为空)
```

- `CANCELLED` 不计"已结束"（面试未发生）；`PENDING/IN_PROGRESS` 不计。
- **不**用 `scheduledAt < now` 推断"已结束"——用户可能未标记完成；`scheduledAt` 过期可以作为弱提示，但不进入确定性谓词（D6 可裁定是否纳入弱提示）。
- `[待核实]` 迁移产生的 `status: "EVIDENCED"` 不在 `PROCESS_STEP_STATUS` 常量内：若其语义确认为"该阶段已发生"，谓词应纳入；裁定前按"非 COMPLETED"处理（不误报）。
- 时间精度：谓词只依赖 `status`（枚举）与 `reflectionCompletedAt`（instant），**不依赖** `scheduledAt` 精度——历史未知精度不影响判定。

---

## 8. 真实面试复盘 vs InterviewSession 边界（回答合同问题 8）

| | 真实面试（本合同） | 模拟/练习（InterviewSession） |
|---|---|---|
| 事实性质 | 真实发生的事（用户记录） | 练习产物 |
| 挂载 | `ApplicationAttempt → ProcessStep(INTERVIEW) → InterviewDetail` | `InterviewSession`（可选 job+JD 成对链接） |
| 问题 | `ReflectionItem.questionText`（快照）+可选 `sourceQuestionId` | `QuestionInstance.displayedText`（快照）+`sourceQuestionId`+`sourceKind` |
| 状态机 | Step `PENDING/IN_PROGRESS/COMPLETED/CANCELLED`（+复盘完成标记） | `DRAFT/IN_PROGRESS/COACHING/COMPLETED/ARCHIVED`（`ARCHIVED`/`archivedAt` 存在但**无写路径**——本期不产品化，`[待核实]` 语义归属归档合同后续批次） |
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
  - `ProcessStep` 删除：仅 `source === "USER"`；Cascade 删 detail+items。D9 推荐保持可删，删除确认文案明示"将同时删除该轮复盘"；备选"有复盘禁删"。
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

- **现状已满足**（合同确认并形式化）：`generateInterviewReflectionDraft` 只产草稿、服务端不落库；持久化必经用户 Apply+Save 走 `saveInterviewReflection`。
- 任何 AI/Agent（含未来 Voca Reflect）**不得**：直接写 `reflectionText`/items、置 `reflectionCompletedAt`、改 `submitted*`/`submittedAt`、改 Step `status/completedAt`、替用户"完成"复盘或标记面试结束。
- AI/Agent **可以**：读取（在 `userId` scope 内）职位/Attempt/Step/detail/复盘/JD/提交简历摘要；产出建议文本/问题候选/复盘草稿——全部停在客户端草稿态，用户显式确认后走现有写路径。
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

未发现冲突。

---

## 13. Owner 决策表（编号；每项 2–3 互斥选项）

| # | 待决项 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| D1 | 真实面试轮次实体 | (a) 复用 `ProcessStep(INTERVIEW)+InterviewDetail`；(b) 新增 `RealInterview` 实体；(c) 扩展 `InterviewSession` | **(a)** | (a) 零 Schema、无双写；(b)/(c) 复制时间/状态/reminder 能力并混淆练习域 |
| D2 | 复盘完成/草稿标记 | (a) `InterviewDetail.reflectionCompletedAt` 显式列；(b) 派生谓词（有内容=已复盘）；(c) 不区分 | **(a)** | (a) 确定性、支持"有内容但未完成"草稿态，NEXT-ACTIONS 可直接消费；(b) 无法区分草稿；(c) "待复盘"无法判定 |
| D3 | 复盘可编辑性/留痕 | (a) 自由编辑+`updatedAt`，完成后可重编；(b) 完成后锁定+显式重开；(c) revision 历史表 | **(a)** | (a) 复盘是用户叙述，最简；(b) 增加状态复杂度；(c) 新表+备份+UI，范围扩大（可后续追加） |
| D4 | 面试问题↔题库 | (a) 快照+可空 `sourceQuestionId`/`sourceKind`（`Restrict`）；(b) 纯快照不加引用；(c) 仅引用不快照 | **(a)** | (a) 可回溯"哪题来自题库/练习"，编辑题库不篡改历史；(b) 丢来源但已满足防篡改；(c) 题库编辑会改写历史——**不可接受** |
| D5 | 面试实际发生时间 | (a) 复用 `scheduledAt`（计划/可调）+`completedAt`（标记结束时刻），不加列；(b) 新增 `occurredAt` 三元组 | **(a)** | (a) 零 Schema，scheduledAt 可由用户改到实际时间；(b) 第三套时间语义，迁移/UI 成本 |
| D6 | "已结束、待复盘"判定 | (a) 仅 `status === "COMPLETED"`（§7 谓词）；(b) 再纳入 `scheduledAt` 过期弱提示；(c) 用户手动标记"待复盘" | **(a)**，(b) 可作展示层补充 | (a) 确定性最强；(b) 会误报未标记完成的轮次，仅适合提示不计数；(c) 放弃自动化 |
| D7 | `InterviewDetail` 元数据列接线 | (a) 本期接线编辑面；(b) 保留不接线；(c) 删除列 | **(b)** | (b) 最小增量，AI prompt 已可读；(a) 扩大 UI 范围可后续单独排期；(c) 破坏已部署列的备份兼容 |
| D8 | 复盘→改进任务 | (a) UI"转为任务"预填创建 `Task`，不加回链列；(b) `Task` 加 `sourceType/sourceId` 回链；(c) 不做 | **(a)** | (a) 用户确认即建，零 Schema；(b) 需动共享 Task 模型；(c) 不满足 P2"改进转入 Tasks"决定 |
| D9 | 含复盘 Step 的删除 | (a) 保持可删+删除确认明示级联复盘；(b) 有复盘则禁删（先清空复盘）；(c) 复盘独立归档 | **(a)** | (a) 尊重用户数据自主，成本最低；(b) 增加删除摩擦；(c) 引入新状态维度 |
| D10 | `Attempt.archivedAt` 独立归档 | (a) 本期不产品化，保留列语义；(b) 本期产品化 | **(a)** | (a) 对齐归档合同"后续批次"口径；(b) 需完整 UI/恢复路径，范围扩大 |
| D11 | `InterviewSession`↔真实轮次显式链 | (a) 不加列，按 job+JD 聚合展示；(b) `InterviewSession.applicationProcessStepId` 可空链 | **(a)** | (a) 零 Schema，聚合已可达；(b) 需处理 Step 删除/转移一致性，收益小 |
| D12 | 复盘字段结构 | (a) 保持 `reflectionText` 自由文本+逐题 `answerNotes`；(b) 拆结构化字段（表现/改进/行动） | **(a)** | (a) 最小增量，AI 草稿已产分段自由文本；(b) 便于机器消费但增加 Schema/UI，可由 Voca Reflect 阶段再评估 |

**裁定后冻结点**：D2/D4 决定是否进 IP-0 的 Schema 增量；其余为产品语义冻结，不动 Schema。

---

## 14. 冻结后的实施包、依赖与 Owner

### 14.1 包划分（按用户成果，不按前端/后端/测试拆）

| 包 | 成果 | 主要文件 | 依赖 |
|---|---|---|---|
| **IP-0 Schema/备份/迁移（单一 Owner）** | D2-a/D4-a 裁定列 + additive migration + 备份字段/FK/版本 bump | `prisma/schema.prisma`、`prisma/migrations/<new>/`、`src/lib/backup/schema.ts`、`src/lib/backup/ordering.ts` | 必须先冻结 D2/D4；**阻塞 IP-2** |
| **IP-1 JOB-CONNECTIONS 聚合视图** | 职位详情"计划 vs 实际投递"对照：计划绑定 Variant、每 Attempt 的提交版本/artifact/JD 版本摘要、该职位练习会话计数 | `src/lib/career/applicationTimeline.ts`（DTO 扩展）、`src/lib/career/jobOpportunityAdapter.ts`（include）、`src/components/myjobs/job-details/ApplicationTimelineTab.tsx`、`SubmittedResumePanel.tsx`（小改或新增对照面板） | 不依赖 IP-0（只读现有列），可与 IP-2 并行 |
| **IP-2 INTERVIEW-DEBRIEF 核心** | 复盘完成标记写路径、`sourceQuestionId/sourceKind` 读写、"已结束待复盘"谓词服务、对话框 UI（完成标记/题库引用/可选练习导入） | `src/lib/career/interviewReflection.ts`、`src/lib/career/applicationService.ts`（save/get/谓词）、`src/components/myjobs/job-details/InterviewReflectionDialog.tsx`、`src/lib/career/interviewReflectionAi.ts`（prompt 按需） | **依赖 IP-0**（新列） |
| **IP-3 收尾联动** | 删除级联警示文案、复盘→Task 预填创建、归档中心只读核对 | `ApplicationTimelineTab.tsx`、Task 创建入口（实施时定位）、`job-details` 归档 banner 核对 | 依赖 IP-2 的谓词/字段 |

### 14.2 串行/并行与单一 Owner

- **必须先完成**：D2/D4 裁定 → IP-0（Schema/备份/Migration **单一 Owner**，含 `prisma/schema.prisma` 与 `src/lib/backup/*`）。
- **可并行**：IP-1（只读现有列）与 IP-2 可并行；IP-1 与 IP-2 若同触 `ApplicationTimelineTab.tsx`/`applicationService.ts`，按"共享文件单一 Owner"归并——建议 `applicationService.ts` 归 IP-2 Owner，`ApplicationTimelineTab.tsx` 的展示扩展归 IP-1 Owner、复盘相关改动归 IP-2 Owner，按 hunk 划分或顺序提交。
- **共享文件单一 Owner**：`prisma/schema.prisma`+`src/lib/backup/*`（IP-0）；`src/i18n`/`messages`（由主协调指定一名 Owner，各包提 key 清单合入）；`wiki/P2_FEATURES.json`/`P2_IMPLEMENTATION.md`（仅 Main 集成 Owner 在集成后更新）。
- **测试归属**：各包自带定向验证（隔离 DB migration、服务不变量、组件测试），不拆独立"测试包"。

### 14.3 建议依赖顺序

```
D 项裁定冻结 → IP-0（Schema/备份）→ IP-2（复盘核心）┐
              └─────────────────→ IP-1（聚合视图）──┴→ IP-3（联动收尾）→ 集成/验收
```

（若 D2-b/D4-b 裁定——即不加列——则 IP-0 仅含合同冻结，IP-1/IP-2 可完全并行。）

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
| A9 | **AI 边界** | AI 生成后未确认不落库；确认后走 `saveInterviewReflection`；`NOT_CONFIGURED` 诚实态 |

---

## 16. 待核实项汇总

| 项 | 现状 | 需要的确认 |
|---|---|---|
| `ProcessStep.status = "EVIDENCED"` | migrator 写入，但不在 `PROCESS_STEP_STATUS` 常量（`PENDING/IN_PROGRESS/COMPLETED/CANCELLED`） | 兼容值语义："已发生"是否纳入"已结束"判定；是否应入常量 |
| `ApplicationAttempt.archivedAt` | 列存在无写路径 | 语义归属（本合同按"保留，本期不产品化"处理） |
| `InterviewSession` `ARCHIVED`/`archivedAt`/`statusBeforeArchive` | 枚举+列存在无写路径 | 是否属归档合同后续批次（本合同按"本期不产品化"处理） |
| `InterviewDetail` 元数据列 | 存在无写路径 | D7 裁定 |
| `ApplicationAssessmentDetail`/`ApplicationOfferDetail` 写路径 | 未见 | 与 INTERVIEW 平行，不在本合同范围 |
| `Question.deletedAt/isActive` | 读侧（interview planning）过滤已核实；写侧无软删路径，UI 删除为硬删除（Restrict 阻止已引用题） | D4-a 裁定时需一并定题库删除 UX |
| `INTERVIEW_SESSION`/`QUESTION` 等在 upcoming/概览中的消费面 | 未全量核实 | NEXT-ACTIONS（另一合同）的职责，本合同只提供谓词 |

---

## 17. 附：推荐数据方案一句话

> 复用 `JobOpportunity → ApplicationAttempt → ProcessStep(INTERVIEW) → InterviewDetail → ReflectionItem` 现有树与 `submitted*` 不可变首绑；唯一 Schema 增量为 `InterviewDetail.reflectionCompletedAt` 与 `ReflectionItem.sourceQuestionId/sourceKind`（快照仍为唯一真相）；复盘是用户叙述可自由编辑、不驱动申请状态、AI 只产草稿；归档/恢复不改写任何历史字段。
