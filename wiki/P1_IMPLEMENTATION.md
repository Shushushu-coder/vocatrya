# Vocatrya P1 增量实施计划

> 更新日期：2026-10-28。原始评估基线：main @ `8ff63dfb`（2026-10-26），**不是当前代码版本**；ACTIVITY-RETIRE 另依据 Owner 提供的 2026-10-28 COMPLETE 审计（审计 HEAD `87985758...`）。本次为产品台账/实施合同更新，未访问当前仓库验证代码现状。
> 状态口径：`IMPLEMENTED` 表示相应业务主路径已有实现，`PARTIAL` 表示部分实现，`MISSING` 表示目标产品能力尚未完整实现。上述状态不代表用户验收完成；`passes: true` 仅在对应真实业务与必要数据/桌面 Gate 通过后设置。

## A. 范围、迁移关系与状态

本文件与 [P1_FEATURES.json](./P1_FEATURES.json) 一一对应。JSON 记录机器可读的 P1 范围、状态、交付/验收检查点及证据；本文件记录产品合同、实施依赖、边界与未决问题。`steps` 是交付/验收检查点，不代表执行授权；原始 `baseline` 只用于历史追溯。

2026-10-28 Owner 讨论形成以下**台账范围更新**：

- `ACTIVITY-RETIRE` 保持 P1 **第一修改任务**；原拆除合同及 Tasks 独立分类保护不变。
- `BD-ARCHIVE` 保留稳定 ID，但产品含义从「暂缓的全品类基础数据归档」调整为 **P1 首批职位与 AI 对话历史归档**；长期保留、随时恢复、不自动清理，不是 30 天回收站。
- 原 `SET-AI-SERVICES` 作为一条总状态不再单列，拆为 `AI-ACCOUNT-LOGIN`、`AI-BYOK`、`AI-MANAGED`，**三条均为 P1 必须分别交付和验收**。原配置/连接证据按实际覆盖路径归入子项；不能沿用原 `IMPLEMENTED` 状态代表三条都完成。
- 新增 `RESUME-BUILDER`：结构化简历素材、两栏拖拽工作台、岗位版本及导出，是 P1 的上游核心链路。
- 原 `RM-MATCH` 不再单列 P1 Feature。其候选 Agent `match_job` 记录到 `AGENT-CAPABILITIES`；**现有 canonical FAST_SCREENING/MatchAnalysisService 仍是独立可复用业务能力**，代码不因台账迁移被删除或改写。
- `AGENT-CAPABILITIES` 其余能力与扩展决策保持现状，本次只调整匹配工具的台账归属。

当前 **7 项**，其中 `IMPLEMENTED` 1 项、`PARTIAL` 2 项、`MISSING` 4 项；**全部 `passes: false`**：

| Feature | P1 范围 | 实现状态 | 当前结论 |
| --- | --- | --- | --- |
| **ACTIVITY-RETIRE（第一修改任务）** | IN_SCOPE | MISSING | 产品删除范围已确认，尚未执行 |
| **BD-ARCHIVE** | IN_SCOPE | MISSING | 职位/对话归档产品规则已确认，尚未实现 |
| **AI-ACCOUNT-LOGIN** | IN_SCOPE | IMPLEMENTED | 已测试可用，完整业务/UI 验收未覆盖 |
| **AI-BYOK** | IN_SCOPE | PARTIAL | 配置基础存在，真实 API Key 业务调用未验收 |
| **AI-MANAGED** | IN_SCOPE | MISSING | 面向用户的托管服务尚未交付 |
| **RESUME-BUILDER** | IN_SCOPE | MISSING | 模块化解析→编辑→版本→导出链路待设计实施 |
| **AGENT-CAPABILITIES** | OWNER_DECISION | PARTIAL | 现有五工具保留；`match_job` 仅登记待合同裁定 |

**授权边界**：`IN_SCOPE` 是产品交付范围，不代表已经批准源代码修改、破坏性删除、实际数据库迁移、真实凭据操作、Commit、Merge、Push、Release 或 Deploy。实际工作前须核查当时 HEAD/Dirty 与授权对象。其余 MVP 台账仍见 [MVP_IMPLEMENTATION.md](./MVP_IMPLEMENTATION.md) 与 [MVP_FEATURES.json](./MVP_FEATURES.json)。

## B. P1 工作包

### ACTIVITY-RETIRE：彻底移除求职活动，独立保留任务分类（第一修改任务）

**2026-10-29 Owner 冻结备份策略**：旧备份包含非空 `Activity` 组时整包拒绝，在任何写入或清空前给出明确错误；空 `Activity: []` 组兼容剥离，旧 manifest 的 `Activity: 0` 不阻断导入。不实施受控跳过非空组。该决策不代表 Main 已集成、功能验收通过或真实库迁移获授权；状态在后续集成时同步。

- **优先级 P1；范围 IN_SCOPE；实现状态 MISSING；`passes: false`。** 2026-10-28 Owner 已完成产品决策：当前版本尚未发布，极少量 Activity 历史记录仅属测试账号数据，**不归档、不迁移保留、不承担旧 Activity 备份兼容**。本工作包排在本 P1 台账第一位，但登记计划**不等于授权执行删除、真实数据库迁移、Commit、Push 或部署**。
- **审计依据**：Owner 提供的《Vocatrya Job Activity Dependency Audit Report》，结论 `COMPLETE`，审计时 main HEAD 为 `879857587552c6c1ee9689695bca90ae474c449e`。核心证据：`Activity` 是独立的时间记录/休息系统；`Task.activityTypeId` 可选且引用 `ActivityType`；任务删除受到活动行检查的应用层阻断；Dashboard/Analytics 消费活动计数或时长，投递热力图色块实际来自投递数；Activity 备份休息字段有必填限制。**这是所提供审计结论，不代表本轮已访问并复核当前仓库**，实施前须重新核对实时 HEAD/Dirty 和实际调用点。

**冻结的产品合同**

| 删除范围 | 明确保留/保护 |
| --- | --- |
| `/dashboard/activities` 页面及 Sidebar、Header、创建菜单、空账号引导等入口 | Tasks 的创建、编辑、完成、删除及可选的「任务分类 / Task Category」字段 |
| 手动补记、从历史再开始、从任务开始计时、切换确认及其 Action/Form | `ActivityType` 作为任务分类的独立底层模型，以及分类维护、筛选、分组 |
| 全局计时 Provider/Banner、自动停止/恢复、休息环、休息弹窗和应用内到点提示 | Job/投递业务、截止日期、面试日程与系统提醒 |
| Dashboard 活动计数、近期活动、未来 7 天活动；Analytics 活动时长环图、热力图小时提示 | Dashboard 其余真实指标、Analytics 投递/职位统计及按投递数着色的日历热力图 |
| `Activity` 表/外键及专属备份分组、ID 映射和专属测试/假数据 | `Task.activityTypeId` 与 `ActivityType` 的数据库关联、备份往返和任务分类数据 |

**实施顺序（依赖先于删除，避免中间态触发运行错误）**

1. **只读再核查与隔离**：记录实施时实际仓库 HEAD、分支、工作区改动及迁移/备份版本；按审计重新检索 `Activity` 与 `ActivityType` 的生产调用、路由、i18n、测试、Electron 场景。不得把 `CareerCampusActivityDetail`、`InterviewSession`、`getJobsActivityForPeriod`、提醒调度器的定时器等名称相似的无关功能一起删除。保护原有 Dirty、未跟踪文件和 sibling worktree。
2. **先独立任务分类**：维持 `Task.activityTypeId` 可空，支持未分类任务与分类的创建、编辑、查询、筛选、分组；从 Activity 写入和引用计数中解耦类型 CRUD，删除类型时继续保护任务引用；界面称「任务分类 / Task Category」。底层 `ActivityType` 是否重命名由最小风险决定，**不把重命名当成本轮必选动作**。
3. **解除跨模块硬依赖**：移除 `deleteTaskById` 对历史活动行的拒绝，去掉 Tasks 的开始活动操作；移除 `getOverviewStats`、`getRecentActivities`、`getOverviewDataState` 中的活动统计/空账号逻辑，保持空账号引导基于实际保留业务；移除 `getJobsActivitySummary` 的活动时长图和 `getActivityCalendarData` 中小时提示及其活动查询，保留投递色块、职位/流程统计和提醒。清理未使用的 `getActivityDataForPeriod` 等独占代码。
4. **拆除 Activity 产品与运行时**：移除活动页及路由、Top Bar/Sidebar/引导入口、Action/Query、ActivityProvider、GlobalActivityBanner、计时休息组件、定时器与状态持久化恢复、相关开发假数据；同步处理 i18n、测试、导航策略、桌面路由清单和不再适用的文档。不要引入设置隐藏开关、替代计时器或新的效率评分。
5. **数据库与备份收口**：在确认没有生产调用后，新增独立 Prisma Migration（只追加新的迁移文件）以移除 `Activity` 模型对应表与外键；不编辑既有已执行迁移。同步移除 `Activity` 在备份 Schema/manifest、ordering、idmap、emptiness 等中的分组和引用，按现有版本策略处理 schema/format 契约；**不为旧 Activity 行（含缺少休息字段的旧行）维护数据恢复兼容**；按 2026-10-29 Owner 决策，含非空 Activity 组的历史备份在任何写入或清空前整包拒绝并明确提示，空组兼容剥离，不静默丢失其他业务数据；必须保证其他备份分组仍可导入导出，特别是 `ActivityType` → `Task` 的分类关系。活动行是可丢弃测试数据，不能据此误删任务、类型、职位或任何真实业务数据。
6. **分层验证与授权门槛**：先做类型检查、相关 lint/单测、静态残余引用搜索、备份导出导入往返、隔离合成数据库的新迁移及外键校验，再做 Dashboard、Tasks、Analytics、投递日历及隔离 Windows Electron 的受影响路由/交互验收。触及真实本地或生产数据库的迁移与物理删除，必须先单独核实库身份、备份策略及获得 Owner 明确授权；Commit、Merge、Push、Release、Deploy 均需各自授权。

**最低验收矩阵**

| 验收项 | 必须满足 |
| --- | --- |
| 导航/运行时 | 求职活动页面、入口、全局计时条与休息体验均不存在；无 Activity 专属后台读写或恢复；桌面路由与 UI 文案一致。 |
| 任务 | 分类字段不填仍可创建；填写后可编辑、筛选、分组；任务创建/完成/删除不需活动；分类 CRUD 和被任务引用时保护正常。 |
| 总览与统计 | 活动数量/时长/未来七天活动/近期活动内容已移除；非活动指标正常；新账号空状态正确，不因已删除模型抛错。 |
| 职位/日历/提醒 | 投递热力图继续按职位投递数着色，去掉小时提示；职位流程、截止日期和提醒行为不受影响。 |
| Schema/备份 | `Activity` 模型/表和专属备份组被删除；`ActivityType` 与 `Task.activityTypeId` 均保留；非活动备份往返成功，分类外键/映射正确，无静默丢失任务或职位。 |
| 回归与证据 | 更新或删除旧 Activity 专属测试，保留并更新任务、Dashboard、Analytics、备份、导航/Electron 相关回归；完成实际受影响界面的验收并记录证据后才能将 `passes` 改为 `true`。 |

**完成定义**：活动模块在产品、运行时、数据库与专属备份层均被干净移除；任务分类独立可用；所有保留业务验证通过。隔离环境验收与真实目标数据库执行是不同 Gate，是否允许在真实库尚未迁移时标记 `passes` 必须在实施前明确；未完成已冻结的真实用户可见验收不得提前标记完成。

### BD-ARCHIVE：设置 → 数据与支持 → 归档数据

- **P1 / IN_SCOPE / MISSING / `passes: false`。** 首批只覆盖 **职位**和 **AI 对话历史**；简历、面试题库、面试练习数据及其他类型**不在首批**。过去所说的「全品类基础数据归档」不再是本项交付范围。
- 归档是可逆的**可见性管理**：将归档内容从常规工作视图隐藏，通过设置中的归档数据入口集中查询并恢复；原始记录、职位及其申请关联事实、对话消息及用户归属不应因归档而被物理删除。
- **长期保留、随时恢复、无自动到期**；不建设 30 天回收站、不在后台自动清理归档数据。现有**删除确认**继续存在；归档、恢复与永久删除应有不同的操作与文案，不将删除伪装成归档。
- 完成验收须覆盖归档前后列表可见性、独立用户数据隔离、恢复后内容一致、申请历史/历史对话引用完整性、备份往返及隔离 Windows Electron 真实交互。
- **实施合同待细化**：归档职位对各统计指标、筛选与历史关联视图的影响；恢复时名称/关联冲突；归档中心的永久删除入口是否另设，均需按现有业务语义明确，不能凭空改变删除和统计逻辑。Schema、备份契约及任何真实数据写入仍须独立审查授权。

### AI-ACCOUNT-LOGIN：账号登录型 AI

- **P1 / IN_SCOPE / IMPLEMENTED / `passes: false`。** 用户已经实际试用并确认相关聊天功能可用；但服务级探测与部分人工操作**不等于完整业务/UI 验收**。
- 原 `SET-AI-SERVICES` 的有效证据归属本项：Codex CLI 0.164.0 与 0.165.0 分别完成经授权的流式 4 项及结构化 9/9 desktop connection-service 认证；保留精确版本门控。相关 UI/环境状态问题已修复，159 项定向测试、类型检查和 ESLint 通过；隔离 Electron fresh-native/full 构建 `G79eH1Wz4YriE8lYq4jPN` 已核对模型与发送按钮，用户反馈聊天复制/重新生成可用。
- 剩余：在真实账号连接下验证连接/模型分配、已支持业务的流式与结构化执行、错误恢复、刷新和隔离 Windows Electron 的完整用户路径；证据只覆盖已验证的具体运行时和版本，不外推到 BYOK 或托管 AI。

### AI-BYOK：用户自带 API Key

- **P1 / IN_SCOPE / PARTIAL / `passes: false`。** 配置、模型分配及账号/BYOK 隔离的基础已有记录，但**尚未证实真实 API Key 能成功执行实际业务调用**。
- 核查密钥存储/访问边界、连接和模型选择的真实状态，验证未配置、无效 Key、模型不可用、额度/网络错误等情况不虚报可用。
- 使用明确授权的真实服务商 API Key，验证实际已接入的流式/结构化业务能力与模型分配在桌面端生效；记录失败恢复、用户反馈及密钥不泄露的证据。Mock、连接探测或账号登录成功不能替代 BYOK 验收。

### AI-MANAGED：Vocatrya 托管 AI

- **P1 / IN_SCOPE / MISSING / `passes: false`。** MISSING 指**面向用户的完整托管能力尚未交付**，不宣称仓库中没有任何既有托管 AI 设计/基础设施。
- 托管服务必须由**部署/服务端保管上游网关凭据**；模型目录由服务端控制，稳定产品模型 Key 与上游模型 ID 分离；订阅/Entitlement 决定模型可用范围和用量，需具备配额、可靠用量记录、并发/异常恢复及用户可理解的状态。
- 用户已向**青云 TOP 客服**询问中国市场相关接入并得到“没有问题”的商务回复；据此可继续推进方案，但不能替代获授权真实网关的技术测试、服务稳定性、额度记账和上线验收。
- 先核对已有 Managed AI 工程阶段与真实环境准备状态，再在隔离 Beta 环境、真实授权网关/测试预算下执行业务 E2E；最后验收订阅权益、模型选择、额度边界、失败记账、三条 AI 路径隔离和 Windows Electron 用户体验。真实凭据/部署/目标数据库需要专项 Gate。

**三条路径共同原则**：共享可复用业务调用契约，但账号登录、BYOK、托管网关的身份/凭据/模型能力/计费边界不得混用；不默默切换到另一种路径。每条 AI 各自维护 `implementationStatus`、证据与 `passes`，一个通过不代表其他通过。

### RESUME-BUILDER：结构化模块简历工作台（P1 核心）

- **P1 / IN_SCOPE / MISSING / `passes: false`。** 现有 Career Material、Resume Variant 等基础能力不等于已实现新的模块化导入、拖拽工作台、分页与导出。实施前先对照真实 Schema、当前简历数据流与格式/导出能力作设计核查。

**冻结的两栏布局**：

| 顶部横向控制区 | 工作区左栏：素材模块库 | 工作区右栏：简历编辑与实时预览 |
| --- | --- | --- |
| 版本选择/创建、关联目标职位、模板/排版、篇幅、导出 | 长期素材：教育、工作/实习、项目、技能、证书、自定义模块及要点 | 将素材拖入当前版本，调整 Section/要点顺序、选择/隐藏/局部改写；所见即所得地检查分页和篇幅 |

**必须形成的业务链路**：

1. **导入与解析**：将简历解析为稳定、可校对的结构化 JSON，映射为教育/经历/项目/技能等模块。保留原文/来源关联，不确定解析内容提示用户核对；不能将 AI 猜测当作用户事实。PDF、DOCX 等输入格式及解析精度须在实施合同中核实。
2. **模块与要点级定制**：素材库与当前简历版本分离；用户能拖拽组合、排序、隐藏或删减 Section 和 Bullet，并在当前版本局部编辑。**从一个版本移除内容，不删除原始素材库记录**。
3. **岗位版本**：可基于目标岗位创建多个简历版本，保留各自的模块选择、排序、内容改写与职位绑定。AI 生成/修改默认创建新 Resume Variant 版本，支持 Diff、来源追溯和回退，不无痕覆盖原始内容。
4. **篇幅与排版**：支持一页/两页等篇幅目标、实时溢出提示和稳定分页；顶部统一管理版本、模板与排版。首版优先受控模板而不是完全自由画布。
5. **导出与外部精修**：可导出可用简历文件（目标为 PDF 和可编辑文档）；用户可在导出后自行细修排版。要求预览与导出分页尽可能一致，不能只展示假分页或“导出”空入口。

**最低验收**：选用真实形态的简历样例，在隔离 Windows Electron 中完成导入→解析校对→拖拽/局部编辑→创建岗位版本→恢复/对比→篇幅校验→导出并打开；验证素材完整性、旧版本不可被静默覆盖、导出内容与预览一致。具体 JSON Schema、解析支持格式、可编辑导出格式及排版引擎应先设计/审查，不把这些设计决策冒充已实现事实。

### AGENT-CAPABILITIES：保留既有五工具；登记候选 `match_job`

- **P1 / OWNER_DECISION / PARTIAL / `passes: false`。** 本轮不重新规划其他 Agent 扩展。已记录的 fresh-native/full 五项工具仍为：`list_jobs`、`get_job`、`add_job`、`get_resume`、`review_resume`。`add_job` 需用户确认且不代表实际投递；`review_resume` 不自动保存至 Resume Variant。`match_job`、`generate_cover_letter` 仍未在当前生产模式开放。
- 原 **RM-MATCH 的 P1 台账归属**改为本 Feature 下的 **候选 Agent Tool：`match_job`**，当前仅登记，**不是 Tool 已接通、执行授权或新增功能验收通过**。其余 Agent 能力范围保持待裁定，不因本次记录自动加入职位更新、投递流程或简历写入工具。
- **不迁移/删除独立业务服务**：canonical 职位详情已有 FAST_SCREENING 最小链路：素材来源选择 → `MATCH_ANALYSIS` 分配 → 结构化执行 → `MatchAnalysisService` 持久化 → 历史读取与 stale 标记。此前已有 fastScreening 12 项、matchAnalysis 8 项定向测试及类型/ESLint 证据；**真实生产连接 E2E 与隔离 Windows Electron 验收仍未完成**。FAST_SCREENING 是当前匹配业务模式，MATCH_ANALYSIS 是该路径使用的 AI 分配能力，不应混淆为 Agent 工具。
- 将来如批准 `match_job`，应复用该独立 canonical 服务，使用经确认的职位与简历版本输入，验证权限、持久化、历史读取和失败语义；可受益于 RESUME-BUILDER 的结构化版本。不能直接解除旧 Legacy `match_job` 门控，也不能只修改提示词就宣称支持匹配。Deep Match 不在已交付能力中。
- 现有五工具的真实连接与批准边界仍按既定验收执行；其他 Agent 新工具**暂不讨论**。Activity 已决定退役，不再将读取 Activity 列为未来待增工具。

## C. 依赖、未决实施合同与所有权

| 工作包 | 依赖与实施约束 |
| --- | --- |
| ACTIVITY-RETIRE | 先解耦 Task 分类再移除 Activity；Schema/Backup 由单一 Owner 收口；旧 Activity 备份已冻结为非空整包拒绝、空组兼容剥离；**真实目标库迁移是否进入 `passes` 门槛**仍须明确，不得静默丢失其他数据。 |
| BD-ARCHIVE | 与职位/对话列表、统计口径、引用与用户数据隔离相关；应明确归档状态的持久化、恢复冲突和备份行为，不自动变成 30 天清理/回收站。 |
| AI 三路径 | 可共用业务 AI 执行接口与 Settings 的 Model Assignment，但认证、凭据、用量、能力验证及每条路径的验收独立；Managed AI 的服务端部署/网关/预算须另设 Gate。 |
| RESUME-BUILDER | 先核查当前 Resume/Career Material/Variant 契约，明确结构化 JSON Schema、文件格式和导出/分页合同；不以旧匹配功能存在代替简历编辑器验收。 |
| AGENT `match_job` | 复用独立 canonical Match 服务；不因为从 RM-MATCH 台账移动而更改/删除其服务，亦不把候选 Tool 当作可用工具。 |

共享设置宿主、工具注册/提示、Schema/备份、双语词典与简历格式各由实际任务指定唯一协调责任方；派工时重新核实仓库 HEAD、Dirty、工作树、测试环境和已有证据。原审计及历史里程碑是参考，不是最新代码事实。

## D. 完成口径与执行边界

- `passes` **按七个 Feature 分别**认定：ACTIVITY-RETIRE 需要拆除与保留功能回归、备份/隔离迁移及桌面证据；BD-ARCHIVE 需要职位和对话归档/恢复与长期保留的验证；三条 AI 各自需要真实业务调用及隔离桌面体验；RESUME-BUILDER 需要解析、拖拽、版本、分页、导出的完整用户闭环；AGENT 保持原工具验收和待裁定扩展边界。
- 真实业务数据、凭据、数据库迁移、生产系统与发布不能由台账范围自动授权。原则上先使用合成数据和隔离环境完成最小充分验证，不盲目重复既有有效版本认证；必要的真实连接验收另取明确授权。
- 原 P1 文件是**历史评估**，本次是**文档更新**：并未运行代码、Schema 迁移、真实网关/Windows Electron 验收，也未提交、合并、推送、发布或部署。完成情况只能据后续实际证据改写，不得因本次产品决策把 `passes` 设为 `true`。
