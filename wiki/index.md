# Vocatrya Wiki 文档索引

`wiki/` 保存 MVP / P1 / P2 开发及扩展工具所需的**项目协调、实施记录与领域合同**，不包含运行时代码。本文是目录入口。MVP 与 P1 分别维护对应功能清单和实施台账；P2 另有清单、实施基线与已冻结的领域合同（2026-11-01 Owner 裁定）。扩展工具单独记录决策与待实施范围，不自动纳入 MVP/P1/P2 必交范围。

## 文档导航

| 文档 | 定位 | 何时阅读 |
| --- | --- | --- |
| [`MVP_FEATURES.json`](./MVP_FEATURES.json) | **MVP 功能状态与验收清单**：30 项 `IN_SCOPE` Feature，另含 1 项延期提醒；包含 ID、类别、优先级、实现状态、验收步骤和 `passes`。 | 选择下一项任务、确认功能缺口或核对验收状态时。 |
| [`MVP_IMPLEMENTATION.md`](./MVP_IMPLEMENTATION.md) | **MVP 当前实施台账**：已交付工作包、延期提醒、合同与证据索引；历史开发缺口不作为当前待办。 | 理解 MVP 范围、工作包依赖、文件归属或追溯集成情况时。 |
| [`P1_FEATURES.json`](./P1_FEATURES.json) | **P1 功能状态与验收清单**：七项工作覆盖活动退役、归档、三条 AI 路径、结构化简历工作台及 Agent 能力，分别记录范围、状态与验收条件。 | 核对 P1 范围、实施缺口与验收状态时。 |
| [`P1_IMPLEMENTATION.md`](./P1_IMPLEMENTATION.md) | **P1 实施台账**：七项工作的产品合同、现状、剩余事项、真实能力边界、依赖及验收要求。 | 裁定范围、选择 P1 任务或安排其验收时；登记不自动授权开发。 |
| [`P2_FEATURES.json`](./P2_FEATURES.json) | **P2 功能状态与验收清单**：六项工作覆盖首页旅程、下一步建议、职位关联、面试复盘、数据看板与多 Agent。 | 核对 P2 范围、合同提案与验收状态时。 |
| [`P2_IMPLEMENTATION.md`](./P2_IMPLEMENTATION.md) | **P2 产品设计与增量实施基线**：已确认原则、已冻结的领域合同、依赖与 Owner 交叉项。 | 核对 P2 范围、阅读冻结合同或安排实施包时。 |
| [`EXTENSIONS_FEATURES.json`](./EXTENSIONS_FEATURES.json) | **扩展工具功能清单**：自动网申、Notion 接入和网页面试练习三项待实施扩展，以及左侧常驻导航与三卡片 UI 决策；分别记录状态和验收条件。 | 核对扩展决策、实施边界及验收状态时。 |
| [`EXTENSIONS_IMPLEMENTATION.md`](./EXTENSIONS_IMPLEMENTATION.md) | **扩展工具实施方向**：自动网申、Notion、面试网页入口；§6 记录 MCP／工具与求职 Skills 清单、难度、浏览器状态／表单识别、邮件／日历连接及第三方技能导入「敬请期待」；§7 链接 Harness 执行规则。 | 设计工具详情页、确定接入方式或安排扩展实施时；文档登记不自动启动开发。 |
| [`HARNESS_OPTIMIZATION_ROADMAP.md`](./HARNESS_OPTIMIZATION_ROADMAP.md) | **Harness 实施台账与架构决策**：H01–H06、双路径执行及 UI 决策；新增常规设置提示词、默认权限、自动归档和无损历史压缩的实际实现、定向验证与待验收范围。 | 核对 Agent 执行架构、设置实现、恢复与审批机制或安排定向验收时。 |
| [`HARNESS_OPTIMIZATION_ROADMAP.json`](./HARNESS_OPTIMIZATION_ROADMAP.json) | **Harness 机器可读台账**：配套阶段状态、证据和 AI 服务双路径需求；已确认需求与已实现功能分别记录。 | 查询 Harness 阶段状态和已确认决策时；不替代所属 Feature 验收清单。 |
| [`RESUME_BUILDER_CONTRACT_PROPOSAL.md`](./RESUME_BUILDER_CONTRACT_PROPOSAL.md) | **结构化简历工作台实施合同 v2**：数据、导入校对、版本 Diff、分页与导出；2026-10-29 本期规则已批准。2026-10-30 修订覆盖跨分节移动、预览宽度/隐藏、DOCX 与预览对齐，以及冻结后的状态调整和版本删除。 | 进入简历工作台编码前核对范围、已批决定和技术不变量。文首同日修订优先于文中旧句。 |
| [`CAREER_SCHEMA_CONTRACT_PROPOSAL.md`](./CAREER_SCHEMA_CONTRACT_PROPOSAL.md) | **职业资料 Schema 冻结合同**（2026-10-27 已批准）：CP-SCHEMA、CP-RECORDS、CP-PRIVACY 的字段和模型基线、派生规则、备份兼容、D1–D18 决策；文首含已集成 Main 的 BD-LINKS 补充合同（`CareerSkillDetail.tagId` 真实 FK、Backup V6）。 | 实施或修改职业资料、关联数据、隐私和备份相关工作包前。 |
| [`DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`](./DATETIME_CONSUMER_CONTRACT_PROPOSAL.md) | **DateTime 消费者冻结合同**（2026-10-27 已批准）：P-TZ、P-PROC、P-JO、P-TASK 对 `src/lib/datetime` 的消费规则，包括 `DateOnly`、`Instant`、精度/时区、历史 `unknown`、排序分页、CSV 和文件 Owner 交接。 | 实施或修改时间语义及相关业务消费者前。 |
| [`ARCHIVE_CONTRACT_PROPOSAL.md`](./ARCHIVE_CONTRACT_PROPOSAL.md) | **归档冻结合同**：职位与 AI 对话长期保留、随时恢复；D6 为 AI 完全不可读归档内容。 | 实施或修改归档、恢复、AI 引用边界前。 |
| [`AGENT_MATCH_JOB_CONTRACT_PROPOSAL.md`](./AGENT_MATCH_JOB_CONTRACT_PROPOSAL.md) | **Agent `match_job` 合同**：D1–D6 已批准；canonical 实现已合入 Main（freshNativeFull，需批准）。尚未完成真实 AI 与桌面验收。 | 修改 Agent 匹配工具、执行台账或 MatchAnalysis 绑定前。 |
| [`P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md`](./P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md) | **P2 首页与下一步建议冻结合同**（2026-11-01 裁定 D1–D9，记录见 §10）：JOURNEY-OVERVIEW / NEXT-ACTIONS 的页面组织、规则与判定。 | 实施首页或下一步建议前。 |
| [`P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md`](./P2_JOB_INTERVIEW_CONTRACT_PROPOSAL.md) | **P2 职位关联与面试复盘联合冻结合同**（2026-11-01 裁定 D1–D12，记录见 §18）：JOB-CONNECTIONS / INTERVIEW-DEBRIEF 的实体树、Schema 增量与语义。 | 实施职位关联、真实面试复盘或相关 Schema 增量前。 |
| [`P2_MULTI_AGENT_CONTRACT_PROPOSAL.md`](./P2_MULTI_AGENT_CONTRACT_PROPOSAL.md) | **P2 三 Agent 面板冻结合同**（2026-11-01 裁定 D1–D10，记录见 §14）：角色、会话隔离、工具白名单、建议填入。 | 实施角色切换和聊天面板前。 |
| [`P2_CAREER_INSIGHTS_CONTRACT_PROPOSAL.md`](./P2_CAREER_INSIGHTS_CONTRACT_PROPOSAL.md) | **P2 求职数据看板冻结合同**（2026-11-01 裁定 D1–D9，记录见 §9）：计数、归档/时区口径、模式降级。 | 实施统计看板或首页数据简报前。 |
| [`MULTI_AGENT_ONBOARDING_PROPOSAL.md`](./MULTI_AGENT_ONBOARDING_PROPOSAL.md) | **多 Agent 冷启动与拒答指路提案**（2026-11-16 裁定 D1–D6+补充项，记录见 §13）：首页入口具名+口头职责、默认 Pilot（现状已满足）、阵容感知块与拒答指路、空状态角色自述；切换 widget 备档。 | 实施角色入口文案、拒答指路或空状态介绍前。 |
| [`MULTI_AGENT_ONBOARDING_FEATURES.json`](./MULTI_AGENT_ONBOARDING_FEATURES.json) | **上述提案的功能台账**：MAO-ENTRY/ROSTER/REFUSAL/EMPTYSTATE/DEFAULT/SWITCHWIDGET 六项，含确认决策、验收检查点与 `passes`。 | 跟踪该提案实施状态或安排验收时。 |
| [`AGENT_WORKSPACE_UPGRADE_PROPOSAL.md`](./AGENT_WORKSPACE_UPGRADE_PROPOSAL.md) | **Agent 窗口升级方案**（2026-11-13 裁定稿）：模型、上下文、文件、审批与 API 听写；D1–D8 带推荐待一次裁定，不代表授权编码。 | 实施 Agent 窗口模型选择、上下文、附件、审批或听写前。 |
| [`AGENT_WORKSPACE_UPGRADE_FEATURES.json`](./AGENT_WORKSPACE_UPGRADE_FEATURES.json) | **上述方案的功能台账**：独立记录，不改写 MVP/P1/P2 范围或验收状态。 | 跟踪该方案实施状态或安排验收时。 |
| [`UI_1_2_0_RC_PROPOSAL.md`](./UI_1_2_0_RC_PROPOSAL.md) | **1.2.0-rc UI 调整方案**：D1–D6 已冻结；导航/头像、概览、分类区、职位排序已集成 Main。 | 修改上述 1.2.0-rc UI 区域前。 |
| [`UI_1_2_0_RC_FEATURES.json`](./UI_1_2_0_RC_FEATURES.json) | **上述方案的功能清单**：独立维护，不改写 MVP/P1/P2/EXTENSIONS 状态。 | 核对 1.2.0-rc UI 项状态时。 |
| [`AGENT_LONG_TASK_HARNESS_PROPOSAL.md`](./AGENT_LONG_TASK_HARNESS_PROPOSAL.md) | **Agent 长任务 Harness 实施方案**（实施设计，未实施；2026-11-16 按代码核对）。 | 设计或实施 Agent 长任务执行前。 |
| [`NATIVE_SESSION_ADAPTER_CONTRACT_PROPOSAL.md`](./NATIVE_SESSION_ADAPTER_CONTRACT_PROPOSAL.md) | **已批准合同**（2026-11-17）：Codex／Devin原生会话边界；首切片 Codex 会话关联与恢复已实现（`AGENT-NATIVE-CODEX-V1`，待验收），Devin 未实施。 | 修改原生会话适配或扩展 Devin 前。 |
| [`RESUME_EVIDENCE_SKILL_CONTRACT_PROPOSAL.md`](./RESUME_EVIDENCE_SKILL_CONTRACT_PROPOSAL.md) | **已批准合同**（2026-11-17）：简历证据深挖流程、提示内容及草稿结果；首版不保存、不加载。尚未实施。 | 实施该内置技能及后续加载接口前。 |
| [`RELEASE_RUNBOOK.md`](./RELEASE_RUNBOOK.md) | **发版标准流程**：`release-notes/<version>.md` 双语摘要编写规则与三道存在性门禁；RC 手工链路与正式版 release.yml 链路、时序窗口、签名/自动更新现状。 | 每次发版（RC 或正式版）前按流程执行；发布链路变更时同步更新。 |
| [`archive/`](./archive/) | **历史报告归档**（2026-11-19 自仓库根迁入）：Beta2 托管端点修订、面试适配器集成/移植计划、Windows BYOK 打包验收。仅留档，不代表现状。 | 追溯上述历史决策或验收证据时。 |

## 使用原则

- **先按任务读取**：普通功能开发不必通读整个 `wiki/`。先查对应 Feature；仅当涉及范围、依赖或领域约束时再打开相关文档。
- **状态与验收分离**：代码已实现、已集成 Main，不等于最终验收通过。`passes: true` 只能在该 Feature 指定的用户验收步骤全部通过后设置；`passes: false` 也不代表尚未编码。
- **状态单一 Owner**：`MVP_FEATURES.json`、`P1_FEATURES.json`、`P2_FEATURES.json` 与 `EXTENSIONS_FEATURES.json` 均由 Main 集成 Owner 维护；每个 Feature 仅在所属清单记录，执行 Agent 不直接争用状态文件。
- **合同优先**：简历、职业资料、DateTime、归档合同已获批准，不能按“待讨论草案”处理。`match_job` 合同 D1–D6 已批准且实现已合入。四份 P2 合同已于 2026-11-01 经 Owner 逐项裁定冻结（记录见各合同文末）；涉及相应工作包时遵守已冻结约束及文件 Owner/交接顺序；如需改变合同，先明确提出变更。
- **避免重复记录**：Feature 状态以所属 MVP/P1/P2/EXTENSIONS JSON 为准；当前实施安排以对应 IMPLEMENTATION 文档为准，历史实施证据见 Feature 的 implementationNotes；具体领域决策以对应合同为准。不要把同一进度复制到多个文件。
