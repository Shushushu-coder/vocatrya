# Vocatrya MVP 增量实施计划

> 生成日期：2026-10-26；独立定向复审修订：2026-10-26。基线：main @ `8ff63dfb`。
> 依据：当前 Main 源码实证 + 《MAIN CONTEXT & MVP Implementation Plan》+ 《Vocatrya 职业资料 V1 回归定义与结构基线》(docs/resources)。
> 状态口径：IMPLEMENTED=业务路径已接通；PARTIAL=有基础但缺关键功能或集成；MISSING=无对应实现；UNVERIFIED=证据不足。

## 基线核实

- HEAD = `8ff63dfbbbba785ad39559537e3610a3c46cbac6`，与既定基线一致。
- 独立复审时 Root 状态：`.vscode/settings.json` 修改、`wiki/MVP_IMPLEMENTATION.md` 未跟踪，暂存区为空；无已跟踪删除。此前 7 个文件删除的状态变化未查明，不据此推断原因，也不作为 MVP 开发阻塞。以每次任务执行时的实时 Git 状态为准。
- Worktree：`.worktrees/` 内 dashboard-v2、next-datetime-01（干净，停在基线，DT-11 R1 改动未落盘）、wave1-set01 / wave1-set03 / wave1-set08（**均有未提交 Settings 相关改动**，见 C 节冲突）；`../vocatrya.worktrees/` 内 rc-01-acceptance、w1-e2e-bootstrap。
- `feature/career-profile-v1`、`feature/settings-v1` 分支对 main 均为 0 commits ahead，**已完全并入 Main，无未集成代码**。上下文中"career-profile-v1 Worktree 待核验"已过时；职业资料既有能力以 Main 为准。
- Migration 共 55 条，最新为 `20261026000000_datetime_v1_additive_columns`（10 个 DateTime 附加列）。

---

## A. Current Baseline

### A1. Career Profile（P0，缺口最大）— PARTIAL

**已有（Main 实证）：**

- Schema：`CandidateProfile`（含姓名、性别、出生日期、民族、政治面貌、籍贯、户籍、毕业届次等中国字段）、`CandidateSensitiveInfo` + `CandidateFamilyMember`（证件号、紧急联系人）、`JobSearchPreference`、`CareerMaterialItem` + 13 类 Detail + `CareerEvidence`。
- 服务：`src/lib/career/candidateProfileService.ts`、`careerMaterialService.ts`、`sensitiveMask.ts`、`applicationCopy.ts`（投影/分区/条目复制文本）。
- UI：`/dashboard/profile/application` → `ApplicationProfileWorkspace.tsx`：现有**四 Tab**工作区、基本资料编辑（**手动保存**）、求职意向编辑、按类型的素材条目 CRUD、Evidence 追加、文本复制（含已有的**“复制本条”记录级入口**）；`EmergencyContactCard.tsx` 默认掩码 + 显式揭示/复制。
- 测试：`applicationProfile.*.spec`、`candidateProfile.*.spec`、`careerMaterialInput.spec` 等。

**对照七 Tab 合同的缺口：**

- MISSING：目标七 Tab 信息架构（个人信息/教育/实习/项目/获奖/其他/网申资料）及 Tab 显隐持久化；当前已有四 Tab 工作区，不是从零建设。
- MISSING：M1 精确 35 个新增列；M2 三模型 `CareerLanguageDetail` / `CandidateReferee` / `CandidateAttachment`（已确认不在 schema.prisma）。
- MISSING：字段直接编辑 + 自动保存（现状为整组手动保存）；保存失败保留输入的状态机。
- PARTIAL：已有投影/分区文本复制和“复制本条”记录级能力；仍缺统一的字段、分组、Tab、网申按需汇总复制，以及跨类型一致性与敏感过滤合同。
- PARTIAL：敏感保护已覆盖证件/紧急联系人，但证明人、附件、证件照等默认保护范围未实现（依赖 M2）。
- PARTIAL：多条结构化记录已有（CareerMaterialItem）；教育字段已有 `gpaValue`、`gpaScale`、`rankText` 基础。仍需按冻结合同补齐科研、论文、语言多条目等差量能力，不能重复开发现有 GPA/排名字段。
- 求职意向保留现状：`JobSearchPreference` 数据保留，按合同从职业资料导航移除但**不删历史数据**。

### A2. Job UX（JOB-01～05）— PARTIAL（多数已接通）

- JOB-01 草稿"已投递"撤销：**IMPLEMENTED**。`AddJob.tsx` 的 `appliedDraftAutoFill` 精确回滚仅由开关生成的 status/appliedDate；`job/status.ts` 保证 appliedDate 只记首次。
- JOB-02 薪资自由文本：**IMPLEMENTED**。legacy `salaryRange` ↔ canonical `salaryText`（`jobOpportunityAdapter.ts`），CSV 导出已含薪资列（`exportJobsCsv.ts` + `jobsExportSalary.spec.ts`）。
- JOB-03 薪资/渠道真实呈现：**IMPLEMENTED**。`JobSummaryCard.tsx` 直显 salaryRange 与 JobSource，缺失显示 "-"，adapter 将 `sourceLabel` 回填为 JobSource。
- JOB-04 来源装饰交互：**UNVERIFIED→疑似已满足**。当前来源仅以文本展示，未见装饰性交互残留；建议施工时做一次确认性核查而非重新实现。
- JOB-05 "A+B" 等内部术语：**PARTIAL**。i18n `runtimeNotice`/`runtimeReady*`/`resumeReadOnlyDescription` 中仍对用户暴露 "A+B"、"VOCATRYA_AB_RUNTIME_ENABLED"（en.json/zh-CN.json ~2155-2160 行），需面向用户重写文案。
- 一致性：`jobsReadDispatch.ts` 统一 legacy/canonical 读族；`agentCanonicalRead`、`appliedFactCrossModule` 等 spec 存在。

### A3. Application Process — 后端核心 IMPLEMENTED，用户闭环 PARTIAL

- Attempt：`ApplicationService` 已提供 createAttempt / submitApplication / createTransferredAttempt / updateStage / recordOutcome；`applicationSubmissionTruthfulness.spec` 覆盖真实性口径。**但尚未确认独立新建 Attempt 与转投的完整用户入口**；转投 action 在 Main 中未见组件调用。
- 流程事件：`ApplicationProcessStep` CRUD 全套（`createUserProcessStep/updateUserProcessStep/completeProcessStep/deleteUserProcessStep`），类别含 SCREENING/ASSESSMENT/INTERVIEW/OFFER/ONBOARDING/OTHER；Detail 表（Interview/Assessment/Offer）+ Reflection 已建。
- UI：`ApplicationTimelineTab` + `ProcessStepDialog`（已有 Attempt 选择、类别、计划/截止时间、备注、结果）+ `InterviewReflectionDialog`。Timeline 在没有 live Attempt 时可创建草稿，否则主要选择已有 Attempt；这不等于用户可自由新建独立 Attempt 或执行转投。
- Upcoming：`upcomingReadModel.ts` + `UpcomingContainer`（myjobs "即将截止" Tab，仅 AB 读模式显示）+ Dashboard `getOverviewReminders` 合并 legacy dueDate 与 canonical 事件。
- PARTIAL：独立 Attempt 新建/转投入口、事件表格/行内快捷新增改期 UX 未做（当前为对话框逐项编辑）；笔试/群面/多轮面试依赖 label 自由文本；P-PROC 精度/时区消费者未切换（对话框用裸 `Date`，新增 precision/zone 列未读写）。
- PARTIAL：Upcoming 已通，但读模型未消费 `deadlineOn/deadlinePrecision/scheduledAtZone` 列，亦无用户时区。

### A4. DateTime / Task — Foundation IMPLEMENTED，消费者 MISSING

- 基础库 `src/lib/datetime/`（dateOnly/fields/format/instant/zoned/zoneMath）+ 6 个 `datetimeV1.*.spec` 已交付；Schema 10 列与 Backup V4（`src/lib/backup/` 10-26 更新 + `backupDateTimeV1.spec`）已进 Main。
- MISSING（消费者）：`Task.dueOn/duePrecision`、`JobOpportunity.deadlineOn/deadlinePrecision`、ProcessStep 六个新列**均无任何生产代码读写**；Task 排序仍为 `dueDate asc`（`task/queries.ts`），无混合排序/NULL 排尾；用户时区设置无存储合同与 UI（Settings 无 timezone 项，en.json 仅 1 个 key）。
- DT-11 R1 进行中：`next-datetime-01` worktree 停在基线且无未提交改动，R1 修订内容未落盘于此处。
- UNVERIFIED：OD-A/B/C 决策、canonicalJobRead.ts 的 unknown 显示合同在 Main 上无对应新代码。

### A5. Basic Data — 核心维护/选择 IMPLEMENTED，扩展能力 PARTIAL

- 公司（`admin/companies` 页 + watchlist）、职位名称、地点、渠道（JobSource）、标签、ActivityType、联系人/角色均有 actions + 容器组件 + spec；`AddJob` 内支持就地创建；`dictionaryAbReadPath.spec` 覆盖 canonical 读路径。
- P1 增量：引用关系整理、个人标签/技能与素材的复用对齐（见 B6）。现有多类字典缺统一归档字段，不能把“全部可归档”认定为已实现或无 Schema 增量的验收项目；全量归档暂缓。

### A6. Settings / Desktop — PARTIAL

- Settings V1 IA 已在 Main：九区（general/notifications/appearance/ai-services/ai-assignments/shortcuts/audio/data-privacy/about），`about` 为诚实的 unavailable 占位（SET-07 未交付）；语言持久化（SET-02）、原子 patch（`userSettings/patch.ts`）已合并。
- MISSING：Settings Timezone（P-TZ 前置合同）。General 当前主要接通语言持久化；数据/隐私区已有备份、预检和恢复入口，应复用而非重做。
- Desktop：`desktop/main/` 生命周期、启动、关闭、窗口 IPC、冷启动、迁移、备份、密钥/BYOK 基础 + 测试已在 Main。`desktop/main/preload.js` 已暴露自启、最小化启动、关闭至托盘等偏好 IPC，**Settings 前端未接线**；底层存在不代表用户可配置。实际托盘/最小化行为的 Windows 验收仍属 UNVERIFIED。AI Services 设置区仍保留 SET-04 待接线内容，不能将页面框架误判为完整交付。
- **冲突警告**：wave1-set01（settings page/sidebar + 新 SettingsDrawer）、wave1-set03（DisplaySettings）、wave1-set08（Notifications/Shortcuts/Audio 组件与 Main 上同名文件可能重复/分叉）均有未提交改动，必须先裁定归属再动 Settings 宿主。

### A7. Resume — 基础链路 IMPLEMENTED，职业资料复用 PARTIAL；Match — canonical 用户链路 MISSING

**Resume：**

- Schema 与服务已存在：`ResumeVariant/Version/Section/Item`、`ResumeExpression`、`ResumeArtifact`、`ResumeImportAttempt`；`resumeVariantService.ts`、`resumeArtifactService`、`resumeImportAttempt`、`canonicalResumeImport`。
- UI 有 `/dashboard/profile/resumes` 列表及 `[variantId]` 工作区、Preview/PrintReady/ExportControl、`SubmitResumePicker`（Attempt 绑定）、`SubmittedResumePanel`、`/resume-print/[versionId]`、CanonicalResumeImport；legacy 简历系统并存，canonical Resume 受能力门控。待结合 Career V1 做完整用户闭环核销。

**Match：**

- `MatchAnalysis` 存储/展示模型、`MatchJobButton`、FastScreening/DeepMatch 方法定义存在，**但不能据此判定 canonical Match 可用**：fresh 默认 Job 界面隐藏 Match，现有服务方法未发现生产调用链，缺少 canonical fresh-native 的用户入口和实际执行接线（见 `JobDetails.tsx`、`MatchJobButton.tsx`、`matchAnalysisService.ts`）。
- 该缺口不得写成“只需复用验收”；P1 是否接通最小 canonical Match 或延期，由 Owner 在 B7 明确选择，不将完整 Deep Match 当作首版 P0 前提。

### A8. Reminder — MISSING（条件纳入）

- 无用户提醒持久化模型与送达链路；`src/lib/scheduler` 仅服务 Automation 抓取。按范围规则不阻塞首版 MVP。

### A9. i18n / 其他横切

- `en.json` + `zh-CN.json` 双语完整（各 ~124K 行级词条）；中文界面已是默认交付物。残留工程术语见 JOB-05。
- Dashboard V2 概览/分析板、GettingStarted、ActivityCalendar 已并入 Main；`overview.ts` Owner 待冻结。

---

## B. Remaining MVP Work

> 复用既定工作包 ID；优先级 P0 > P1；每项给出可复用基础、最小范围、验收条件。

### B1. CP-V1 Career Profile 七 Tab（P0，最大增量）

- 可复用：`CandidateProfile`/`CandidateSensitiveInfo`/`CareerMaterialItem`+Detail/`JobSearchPreference`、`sensitiveMask`、`applicationCopy`、现有四 Tab 工作区与“复制本条”、教育 `gpaValue/gpaScale/rankText`、userSettings patch（Tab 显隐持久化可挂 settings JSON）。
- 最小范围：
  1. **CP-SCHEMA（单 Owner + 单独 Gate）**：M1 精确 35 列 diff + M2 三模型；Synthetic Migration、Backup V5、敏感字段安全审查；不动真实 DB。
  2. **CP-UI**：七 Tab 壳 + 「管理 Tab」显隐持久化；Tab 顺序与命名按冻结合同。
  3. **CP-EDIT**：字段行式直接编辑 + 自动保存（保存中/已保存/失败三态，失败保留输入可重试）；无全页编辑模式与保存按钮；Ctrl+Z 不劫持。
  4. **CP-RECORDS**：复用现有教育 GPA/排名与多条素材 CRUD，差量补齐科研、论文、语言多条及实习、项目、获奖、其他（证书/AI 技能/主页/证明人/补充）的七 Tab 呈现与所缺字段。
  5. **CP-COPY**：以已有“复制本条”为起点，补齐字段/组/记录/Tab/网申汇总五级一致体验；敏感项默认排除且单字段复制需显式操作。
  6. **CP-LEGACY**：旧 CandidateProfile/素材数据回填呈现；求职意向 Tab 从导航移除但数据保留。
- 验收：重启后七 Tab 数据一致；敏感字段默认掩码且不进批量复制；自动保存失败可恢复；Tab 显隐持久化生效；已有 GPA/排名可正确回填，新字段与多条经历可维护。

### B2. DT-CONSUMERS DateTime 消费者（P0，与 B1 并行）

- 前置：DT-11 R1 定向复审关闭 F-01～03；OD-A/B/C 决策；冻结 Settings 时区合同、Upcoming DTO、精度显示合同、Task 排序合同。
- **P-TZ**：UserSettings 时区字段（走 patch.ts）+ Settings 选择器（OD-C：IANA 搜索）。验收：设置持久化，消费者按用户时区解释 DateOnly/Zoned。
- **P-PROC**：ProcessStepDialog/时间线读写 precision/zone；笔试/面试/Offer 排期以真实精度保存。验收：DateOnly 步骤不产生 UTC 漂移；旧行按 unknown 精度显示不改写。
- **P-JO**：JobOpportunity deadlineOn/deadlinePrecision 写入（AddJob/编辑/CSV/详情），canonicalJobRead 与 Upcoming 岗位截止读取合同统一。
- **P-TASK**：Task dueOn/duePrecision 写入 + 混合排序（DateOnly 与 Instant 同列排序、NULL 排尾 OD-B）+ 数据规模性能验收（不允许错误分页）。
- **P-INT**：跨模块时间语义 + Legacy 回归（旧数据不改写、显示一致）。
- 复用：`src/lib/datetime` 全部原语；不得另起时间工具。

### B3. JOB-01～05 收尾（P0，小批量）

- JOB-04：确认性核查来源装饰残留，仅清理真实存在的无用途交互。
- JOB-05：重写 runtimeNotice 等用户可见文案，去除 "A+B"/环境变量名；统一为产品语言（i18n 双文件同步）。
- 复核点：canonical Job 详情与 legacy/Agent 读取对"已投递、薪资、渠道、来源"四事实一致性（现有 spec 基础上补断言即可）。
- 验收：JOB-01～05 各自有真实 UI 路径验证记录，不以 spec 通过代替。

### B4. PROC-UX 流程事件高频化（P0）

- 复用：ApplicationService 全部写路径 + ProcessStepDialog 表单模型。
- 最小范围：补齐用户可操作的**独立新建 Attempt 与转投入口**（复用现有 action，不新建影子业务表）；Timeline 事件表格化 + 行内快捷新增（选 Attempt→类别→时间）；快捷完成/改期/取消；类别中文标签集（笔试/测评/群面/一面…N 面/Offer/其他）落到 `label` 或受控枚举；与 Upcoming 联动即时刷新。
- 验收：用户可在同一岗位独立新建多个 Attempt、执行转投并选择目标 Attempt；笔试→两轮面试→Offer 可在详情页登记、改期、完成/取消，Upcoming 一致；窄窗口/键盘可用。

### B5. SET-MVP 设置与桌面收尾（P0/P1）

- Settings Timezone（随 P-TZ）；**桌面偏好 UI** 接通现有自启、最小化启动、关闭至托盘 IPC，提供真实状态、保存结果与失败反馈，不新增虚假开关；AI Services 现存 SET-04 待接线内容按 MVP 必需能力裁定；About 区可维持诚实占位。Notifications/Audio/Shortcuts 与 worktree 未提交版本**先裁定再集成**；数据/隐私已有备份、预检、恢复入口，直接复用。
- 桌面：在 UI 接线后针对性验证自启、最小化启动、关闭至托盘、退出和重开；发现实际缺陷再修复，不为单纯“核验”另开独立施工轨道。
- 验收：语言/时区/外观与已开放桌面偏好在重启后持久，设置失败有反馈；关闭至托盘与真正退出可区分，桌面关闭—重开数据无损。

### B6. BD-V1 基础数据收口（P1）

- 复用现有 CRUD，**本轮不新增 Schema**；收口点：公司/职位/地点/渠道/标签的维护与表单选择、就地创建一致性，以及标签/技能与职业素材的引用关系。
- **全品类归档延期**：当前没有统一归档字段，不以删除替代归档；若未来将归档纳入必需验收，必须另定范围并由 Schema Owner 评估。
- 验收：高频基础数据可创建、编辑、选择与重新打开，跨模块引用正确；不以“全部可归档”为本轮通过条件。

### B7. RM-V1 Resume 复用收口 + Match 决策（P1）

- **Resume（明确施工）**：复用 ResumeVariant、版本冻结、导出与 Attempt 绑定机制；Career V1 落地后核销素材→简历引用、`SubmitResumePicker/attachAttemptResumeVersion`、冻结版本与历史查询的真实用户路径。验收：简历版本可创建/复用、绑定投递、冻结、导出并回看历史。
- **Match（未交付，待 Owner 选择）**：canonical fresh 用户入口和生产执行链路缺失。若纳入本阶段 P1，则只实现最小 canonical Job → Match 入口、现有匹配服务调用与结果呈现/持久化，并做真实路径验证；不重构整个 AI 或承诺完整 Deep Match。若不纳入，则明确延期，并禁止在 Feature List 中标记为已通过。
- **首版 P0 边界**：完整 Match/Deep Match 不自动阻塞职业资料—职位—投递—流程—时间—简历复用闭环。

### B8. REM-V1 提醒（条件纳入）

- 仅在持久化模型 + Windows 通知送达链路完整后开放；不展示假功能。不阻塞 B1–B7。

---

## C. Dependencies & Parallel Work

### C1. 真实依赖（阻塞面最小化）

| 依赖                                    | 影响面                                                       | 处理                                                         |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| DT-11 R1 复审 + OD-A/B/C + 接口冻结     | P-TZ/PROC/JO/TASK 的写入合同                                 | Phase 0 关闭；冻结后即可并行                                 |
| CP-SCHEMA Gate（M1/M2 + Backup + 安全） | 仅 CP-V1 的 Schema 部分                                      | CP-UI 原型与复制层可先施工，落库前合并                       |
| Settings 宿主归属裁定                   | SET-MVP、P-TZ 设置项、桌面偏好 UI                            | 先处置 wave1-set01/03/08 未提交改动；保留现有 IPC            |
| P-PROC/PROC-UX 共享文件归属             | 两项任务的 ProcessStepDialog、Timeline、application action/service | 同一 Process Owner 控制共享文件的实施/交接，不并行改同一文件 |
| G-A 旧版门禁                            | 真实环境启用 canonical 写入                                  | 阻塞真实启用，不阻塞隔离开发                                 |

### C2. 可并行轨道（接口冻结后）

- 轨道 A（DateTime）：先冻结 P-TZ 时区合同，再让 P-PROC/P-JO/P-TASK 在不冲突文件上并行 → P-INT；完整 P-TZ 设置 UI 不阻塞其他消费者在隔离环境开发。
- 轨道 B（Career）：CP-SCHEMA（单 Owner）∥ CP-UI/EDIT/RECORDS/COPY（Schema 冻结前可基于现有模型开发壳与非新增字段）。
- 轨道 C（Job UX）：JOB-04/05 + 一致性复核，独立小批量。
- 轨道 D（Process UX）：PROC-UX（含独立 Attempt/转投入口）可并行处理独立组件；`ProcessStepDialog`、Timeline 与 application action/service 必须与 P-PROC 由同一 Process Owner 修改或明确顺序交接，不允许两个 Agent 同时改这些文件。
- 轨道 E（Settings/BasicData/Resume 收口）：SET-MVP、BD-V1、Resume 收口按真实文件所有权并行；Match 是否进入本期由 Owner 选择。

### C3. 共享文件单一 Owner（必须显式指派）

| 文件/区域                                                    | 建议 Owner                                      | 现存冲突                                                     |
| ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `prisma/schema.prisma` + migrations + `src/lib/backup/`      | Schema/Integration Owner                        | CP-SCHEMA 唯一写入口                                         |
| `src/lib/career/upcomingReadModel.ts`                        | Process Owner（含岗位截止读取合同）             | P-JO/P-PROC 经由此合同，不直接改                             |
| `ProcessStepDialog.tsx`、`ApplicationTimelineTab.tsx`、关联 application action/service | **Process Owner**（同时协调 P-PROC 与 PROC-UX） | 共享 UI/写路径只允许单 Owner 修改；其他 Agent 通过接口或明确交接接入 |
| `src/actions/dashboard/overview.ts`                          | 开工前冻结指派                                  | Dashboard/Upcoming/Task 三路交汇                             |
| `src/app/dashboard/settings/page.tsx` + `SettingsSidebar.tsx` + 各 Settings 卡片 | Settings Owner                                  | **wave1-set01/03/08 未提交改动必须先裁定**                   |
| `src/i18n/messages/{en,zh-CN}.json`                          | i18n Owner 分批集成                             | JOB-05/CP/DT/PROC 文案统一汇入                               |
| `src/actions/job/*`、`jobOpportunityAdapter.ts`              | Job UX Owner                                    | P-JO 写入共享，需协调                                        |
| `src/lib/datetime/*`                                         | DateTime Owner                                  | 只增不改，消费者各自落位                                     |

### C4. 明确不授权项

- 真实数据库 Migration、G: 安装版、Root 既有 Dirty、他人 Worktree 未提交改动。
- Commit/Merge/Push/Release 均分别授权；本文件不构成任何 Git 操作许可。

---

## D. MVP Candidate Acceptance

以真实用户闭环验收（全部在 Windows 桌面端、隔离 Synthetic DB 完成；真实数据不动）：

1. **职业资料**：七 Tab 可建/读/改/重启一致；多条教育/实习/项目/获奖记录；字段自动保存三态正确，失败可恢复；证件/紧急联系人/证明人默认保护且不被批量复制带出；Tab 显隐持久化；求职意向历史数据仍在（只移出导航）。
2. **职位**：添加职位（薪资自由文本、渠道真实值）；列表/详情/CSV 一致；"已投递"草稿可撤销、已保存投递事实不被误擦除；界面无 A+B 等内部术语。
3. **投递与流程**：登记独立 Attempt（可多 Attempt/转投）；在详情页完成笔试→多轮面试→Offer 的新增/改期/完成/取消；Timeline 与 Upcoming 即时一致。
4. **时间**：岗位截止日、流程计划/截止、任务到期按用户时区与精度正确显示与排序；历史 instant 数据显示为原事实不被改写；Task 混合排序在既定数据规模下达标。
5. **复用**：简历版本绑定投递、冻结、导出并可查历史；素材/资料内容可经复制层进入网申场景。Match 不计为已完成；只有 Owner 决定纳入本期，才另行按最小 canonical 用户链路验收。
6. **设置与桌面**：语言、时区、外观及已开放桌面偏好持久；自启/最小化启动/关闭至托盘/退出的 UI 操作符合真实 IPC 能力；桌面安装/启动/关闭/重开闭环在 Windows 通过；旧安装版不破坏新数据（G-A 门禁结论生效后方可启用 canonical 写入路径）。

工期参照：内部 MVP Candidate 以约 10–15 个工作日为规划目标（非承诺）；P0 以真实闭环为准，不以 UI 静态展示代替功能。

---

## 附：无法确认/需 Owner 澄清

1. `next-datetime-01` worktree 干净停在基线 —— DT-11 R1 的修订工作未见落盘，需确认实际位置。
2. OD-A/B/C 决策、G-A 门禁结论不在代码内，需 Owner 状态。
3. 桌面托盘/最小化行为未逐文件核验（标记 UNVERIFIED）。
4. wave1-set01/03/08 未提交改动与 Main 的关系需归属裁定（疑似部分已被后续集成取代）。
5. Career M1"精确 35 列"清单与 16 包准备方案未在仓库 docs 中定位（仅检索到产品冻结文档），实施前需 Owner 提供或确认以冻结合同字段表为准。
6. Match：Owner 需选择本期最小 canonical 接线（P1）或正式延期；选择不阻塞其他 MVP P0 Coding。
7. 2026-10-26 独立复审 Git 状态未见此前 7 个已跟踪删除文件；历史差异原因无证据，不据此判断当前产品状态。
