# Vocatrya P1 增量实施计划

## 当前调度与证据边界（2026-11-18）

11 月 13 日的暂缓安排已由后续获授权的定向复验接续。驱动提交 3a177c42 已经 a646e203 集成，后续 159b7b21、7c6b068e 修正双 Tab 定位与 lifecycle 独立前置；产品计时补丁未重做。

本次在 main@0c81a6f6 直接核对三组 Windows Electron fresh-native/full 的 manifest、results、scope 与 launcher-result：quota 为 7 PASS/1 BLOCKED，lifecycle 为 11 PASS，entitlement 为 7 PASS，各组其余场景是 NOT_RUN。源码摘要均为 `aac4803e763930de8ded7add62a9e331dbc98a51693cee42dc963298a0dacfe2`；quota 驱动基线 159b7b21，另两组为 7c6b068e。证据具体位置见 [P1_FEATURES.json](./P1_FEATURES.json)。

额度/权益拒绝的可见提示与零增量证据保留；但结果中的错误码仍未捕获（BODY_READ_FAILED、observedCode=null、hostedDenial=null），不能把原报告的权威账本补齐说法当作已核实事实。驱动仅在要求提交的无回退场景强制校验 Hosted 错误码，该场景因缺可用竞争连接仍 BLOCKED。重跑合成 no-fallback 前置通过，仅证明驱动。

合成本地 Hosted/上游不等于公网网关或真实模型；lifecycle 成功不证明历史 DPAPI/退出根因。正式周期、额度、产品模型及客服规则待裁定，生产部署未完成，AI-MANAGED 保持 PARTIAL / passes:false / COMING_SOON。旧段落按日期保留历史证据，不再作为当前统一阻塞。


> 更新日期：2026-10-31。原始评估基线：main @ `8ff63dfb`（2026-10-26），**不是当前代码版本**。最新 Main 已合入 BYOK 验证收口（`43d9795b`，merge `a8009d64`）、`match_job` 合同提案（`90a1a6af`，merge `264b463d`）与 canonical `match_job` 实现（`67a3adf6`，merge `393155fc`）；活动退役与归档补丁已在 Main `39a5a1d3` 的同一 Windows Electron 构建中完成联合复验。BYOK 已在 Main `673e3460` 的相同集成代码上完成 DeepSeek 真实服务与 Windows Electron fresh-native/full 验收，零产品代码修改。功能验收与代码集成分别记录。
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

当前 **7 项**，其中 `IMPLEMENTED` 6 项、`PARTIAL` 1 项、`MISSING` 0 项；**6 项 `passes: true`、1 项 `passes: false`**：

| Feature | P1 范围 | 实现状态 | 当前结论 |
| --- | --- | --- | --- |
| **ACTIVITY-RETIRE** | IN_SCOPE | IMPLEMENTED | Windows Electron fresh-native/full 联合复验 38/38，通过 |
| **BD-ARCHIVE** | IN_SCOPE | IMPLEMENTED | Windows Electron fresh-native/full 联合复验 55/55，通过 |
| **AI-ACCOUNT-LOGIN** | IN_SCOPE | IMPLEMENTED | Codex 账号真实流式、错误恢复、MATCH_ANALYSIS 和 Electron 重开验收通过，`passes: true`。Antigravity（`agy`）增量已登记，登录、目录、推理、流式与权限均未验证 |
| **AI-BYOK** | IN_SCOPE | IMPLEMENTED | DeepSeek 真实 Key 服务链路 29/29、Windows Electron fresh-native/full 17/17 通过 |
| **AI-MANAGED** | IN_SCOPE | PARTIAL | 隔离 Beta 真实网关、充值Key、记账与Electron链路已验；正式产品参数/发布及剩余边界待收口 |
| **RESUME-BUILDER** | IN_SCOPE | IMPLEMENTED | 四项工作台修订及 B7 已集成；Windows Electron fresh-native/full 最低验收闭环，`passes: true` |
| **AGENT-CAPABILITIES** | OWNER_DECISION | IMPLEMENTED | canonical `match_job` 已完成限定模型/运行时的真实 AI 与 Electron 验收，`passes: true`；其他扩展仍待 Owner 决定 |

**授权边界**：`IN_SCOPE` 是产品交付范围，不代表已经批准源代码修改、破坏性删除、实际数据库迁移、真实凭据操作、Commit、Merge、Push、Release 或 Deploy。实际工作前须核查当时 HEAD/Dirty 与授权对象。其余 MVP 台账仍见 [MVP_IMPLEMENTATION.md](./MVP_IMPLEMENTATION.md) 与 [MVP_FEATURES.json](./MVP_FEATURES.json)。

## B. P1 工作包

### ACTIVITY-RETIRE：彻底移除求职活动，独立保留任务分类（第一修改任务）

**2026-10-29 Owner 冻结备份策略**：旧备份包含非空 `Activity` 组时整包拒绝，在任何写入或清空前给出明确错误；空 `Activity: []` 组兼容剥离，旧 manifest 的 `Activity: 0` 不阻断导入。不实施受控跳过非空组。实现已随 `81f939b8` 集成；该决策不等于功能验收通过或真实库迁移获授权。

- **优先级 P1；范围 IN_SCOPE；实现状态 IMPLEMENTED；`passes: true`。** Activity 页面、计时/休息、专属统计、模型及备份分组已移除；保留 ActivityType、Task.activityTypeId、任务分类与投递统计。新增 `20261029000000_retire_activity_table` 迁移，未改历史迁移、未执行真实库迁移。2026-10-30 在 Main `39a5a1d3` 的 Windows Electron fresh-native/full 生产构建 `Jtz89Wr0azHP7RnkA_zTH` 中完成 38/38 联合定向复验，包含此前 D-1 任务分类术语补丁、隔离迁移、非空旧 Activity 备份写前拒绝、空组恢复、任务分类及保留业务回归；未操作真实用户库。
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

- **P1 / IN_SCOPE / IMPLEMENTED / `passes: true`。** 首批只覆盖 **职位**和 **AI 对话历史**；简历、面试题库、面试练习数据及其他类型**不在首批**。过去所说的「全品类基础数据归档」不再是本项交付范围。2026-10-30 在 Main `39a5a1d3` 的同一 Windows Electron fresh-native/full 构建中完成 55/55 联合定向复验，覆盖归档中心查看/恢复、跨用户隔离、投递与对话引用保持、提醒抑制及 24h 补发、AI fail-closed 守卫与最终备份引用往返；未调用真实外部 AI，模型调用前 409 守卫证据不外推为真实模型 E2E。
- 归档是可逆的**可见性管理**：将归档内容从常规工作视图隐藏，通过设置中的归档数据入口集中查询并恢复；原始记录、职位及其申请关联事实、对话消息及用户归属不应因归档而被物理删除。
- **长期保留、随时恢复、无自动到期**；不建设 30 天回收站、不在后台自动清理归档数据。现有**删除确认**继续存在；归档、恢复与永久删除应有不同的操作与文案，不将删除伪装成归档。
- 完成验收须覆盖归档前后列表可见性、独立用户数据隔离、恢复后内容一致、申请历史/历史对话引用完整性、备份往返及隔离 Windows Electron 真实交互。
- **2026-10-29 合同已冻结并实现集成**：保留历史投递事实；归档抑制提醒、恢复后沿用 24h 补发窗口；本期只读查看/恢复，不新增永久删除和普通列表归档筛选；AI 完全不可读取归档对象及历史引用快照。历史引用涉及归档职位的对话与摘要禁止送入模型，用户可恢复职位或另开对话。原有对话删除入口保留。详见 ARCHIVE_CONTRACT_PROPOSAL.md；原 Windows Electron fresh-native/full 37/37 通过，最终备份引用修复未重跑桌面验收，passes 仍 false。
- **2026-10-29 备份恢复修复收尾**：仅重映射已知结构化引用，正文、代码与消息 ID 保持原样；独立恢复关联使仅正文/未知工具中的历史职位引用在后续归档、上下文编辑和再次备份恢复后仍受 AI 隔离。无法安全保留关联的畸形上下文会在破坏性写入前拒绝导入，既有安全快照策略保留。定向 6 文件共 84 项、完整类型检查、改动文件 ESLint 和差异检查通过；最终补丁未执行生产构建、Windows Electron、真实 AI 或真实库操作。原桌面证据与最终补丁证据分开记录，详见 JSON。

### AI-ACCOUNT-LOGIN：账号登录型 AI

- **2026-11-18 UX 修正已编码待验证：已连接服务不再显示「连接」按钮。** 真实数据根排查确认重复连接成因：`AiConnectionsCard` 的「连接 xx」按钮只检查运行时 READY，不检查同 `accountProvider` 是否已有连接行；`connect()` 每次 mint 新 ticket 建新行，用户在「ChatGPT via Codex 已连接」状态下再点一次就重开登录并产生第二条连接（实机上 `4f2d49ca` DISCONNECTED + `621eabf1` CONNECTED 并存，既有会话锁还指向已断开的旧行）。已获用户确认的收敛方向：同一 `accountProvider` 存在连接行（非仅判断 backendKind，OpenCode Go/Zen 同 runtime 属两个 provider）时隐藏对应「连接 xx」按钮，重认证/重连走已有连接行的「重新连接」；同 provider 多账号若确有需要，以次级「再添加一个账号」+确认为准。配套的聊天面板原生会话入口修正记录于 [MVP_IMPLEMENTATION.md](./MVP_IMPLEMENTATION.md)。已实现：`AiConnectionsCard` 按 `accountProvider` 隐藏已有连接行的「连接 xx」按钮（连接行上的重新连接/断开/验证/模型/冒烟动作不变），定向组件测试通过；桌面实测未执行。
- **2026-11-18 Antigravity 增量，未验证。** 设置页「Agent 账号登录」增加 Antigravity，身份是 `ANTIGRAVITY` + `ANTIGRAVITY_RUNTIME`，不复用 BYOK 的 `GEMINI`。本机 `agy` 1.5.12 的 `--help` / `agy acp --help` 已核对：登录命令是 `agy acp --login`；没有无头 `auth status` 或 `auth logout`。空 `USERPROFILE` 下 `agy models` 仍打印模型表，因此该表不能当成 Google 账号会话，模型发现保持不可用。状态解析只认 “not signed in”，其余输出是 `UNKNOWN`，不能完成 `CONNECTED`。`--print` 带上 `--sandbox` 与 `--mode plan`，提示词走 stdin；stdin 是否被 CLI 读取、流式、`--json-schema` 和 Windows 沙箱都没有托管试跑。`USERPROFILE` 能把 `~\.gemini` 挪进托管目录；官方文档中的钥匙串令牌不在这次隔离范围内，`multiAccountIsolation` 为 false。断开连接只删 Vocatrya 连接行，`--version` 不是登出，不清理钥匙串。登录、真实目录、真实推理、流式、结构化输出和权限对抗均为 `PENDING`。既有 Codex 验收不外推到 Antigravity，本项 `passes` 不因此改回 false，也不把 Antigravity 记为已验收。

- 2026-10-29 集成 `68212510`：测试认证版本断言对齐已认证的 Codex 0.165.0，未放宽精确版本门控；代码/隔离测试证据已核对，真实账号业务与 Windows Electron 完整验收仍待完成。

- **P1 / IN_SCOPE / IMPLEMENTED / `passes: true`。** 用户已经实际试用并确认相关聊天功能可用；但服务级探测与部分人工操作**不等于完整业务/UI 验收**。
- 原 `SET-AI-SERVICES` 的有效证据归属本项：Codex CLI 0.164.0 与 0.165.0 分别完成经授权的流式 4 项及结构化 9/9 desktop connection-service 认证；保留精确版本门控。相关 UI/环境状态问题已修复，159 项定向测试、类型检查和 ESLint 通过；隔离 Electron fresh-native/full 构建 `G79eH1Wz4YriE8lYq4jPN` 已核对模型与发送按钮，用户反馈聊天复制/重新生成可用。
- 2026-10-31 收口：上述连接/分配、真实流式、usage-limit 后恢复、结构化 MATCH_ANALYSIS、刷新及完整退出重开均已在隔离 Windows Electron fresh-native / AB_ENABLED / full 验证。集成 strict schema 全键 required 修复，保留三字段 nullable；真实调用 ChatGPT-via-Codex / gpt-6-astra 一次，COMPLETED 记录及空值落库正确，无 BYOK/Hosted 回退。证据 `.tmp/worktree-closure/retained/account-match-schema-fix/.tmp/account-match-schema-revalidation/results.json`；末尾 diag-note 纠正仅失败路径才输出的 executeText 日志探针。独立审查无必须修复项，passes=true 仅覆盖实际运行时/模型。

### AI-BYOK：用户自带 API Key

- 2026-10-29 集成 `68212510`：补充 BYOK 凭据故障操作指引、隔离测试代理环境，修复真实截止信号被误判成普通取消的问题；18 项 BYOK 执行测试覆盖 one-shot/streaming 截止与取消。真实 API Key 业务调用未执行，保持 PARTIAL 与 `passes: false`。
- 2026-10-30 Main 集成 `43d9795b`（merge `a8009d64`）：云端验证器及模型列表查询增加有界超时，输入 trim/长度与 malformed body 校验、未知异常脱敏、Gemini Key URL 编码；OpenRouter 改用官方认证的 `GET /api/v1/key`，不再以公开模型目录误判无效 Key。合并前独立审查通过；直接相关 3 文件/30 项、改动 ESLint 与完整类型检查通过。扩展 24 文件集合中 23 文件/308 项通过，唯一失败为既有 `settingsPage.spec.tsx` 未纳入已集成的“归档数据”设置入口，与 BYOK Diff 无关。真实 Key Gate、Windows Electron 和完整业务调用仍 NOT_RUN，保持 PARTIAL / `passes:false`。
- 2026-10-30 验收闭环：在 Main `673e3460` 的独立 Worktree 中复用已集成实现，零产品代码修改。隔离服务环境使用获授权 DeepSeek 测试 Key 完成 29/29，覆盖真实目录、`deepseek-flash` 结构化与增量流式业务调用、模型分配、诚实失败、截止/取消、断连恢复、严格凭据绑定及泄露扫描。随后从同一源码执行生产 Next 构建与桌面装配，在 Windows Electron fresh-native/AB_ENABLED/full 中完成 17/17 阶段，覆盖 safeStorage/DPAPI `os:v1` 信封、真实 Job Match/Chat、模型溯源、无静默回退、失败恢复、两次 quit IPC 退出重开及持久化。明文临时 Key 已移除，Worktree 干净、无残留进程；证据位于 `.tmp/worktree-closure/retained/p1-byok-e2e-closure/.tmp/p1-byok-e2e-closure/`，实际 25 张截图。真实外部调用只覆盖 DeepSeek；OpenRouter、Gemini、OpenAI 本轮仅做错误 Key/保留字符验证及既有单测，不外推为这些服务商真实业务 E2E。未执行安装包、发布或真实用户数据迁移。

- **P1 / IN_SCOPE / IMPLEMENTED / `passes: true`。** 已证实获授权 DeepSeek API Key 能在隔离服务和 Windows Electron 中执行真实结构化与流式业务调用，模型分配、凭据保护、失败恢复及账号/托管路径隔离符合合同。该结论限于本轮真实覆盖的 DeepSeek/`deepseek-flash`；其他服务商仍按各自实际证据判断。

### AI-MANAGED：Vocatrya 托管 AI

- **2026-11-12 任务 B 审查修复并集成**：broker 读/写/清理预算从 5 秒改为 20 秒；复核发现 Hosted 查询的 5 秒预算原本在等凭据前启动，现改为取得 token 后计时，保留调用方取消。新增慢读成功、读/写/清理截止、Hosted 截止和取消回归，定向 4 文件/75 项、归档扫描 2 项、完整类型检查与 ESLint 通过。DPAPI 冷启动尚无分段计时证据，不能认定为已证实根因。
- **实际应用证据与复核边界**：Owner 在 `cd09eb66` 加原 B 未提交补丁的生产构建 `q5e8GhkT0CKpYa0guG7yq`（源码摘要 `81130bc09d37aa18a835e0d10b4bd17412161285a1c107ab540991851128d6dc`）上完成 Windows Electron fresh-native/full，原脚本 20/20；实际 main/preload、独立 backend、正常退出 IPC 与同目录重开有记录，三次 launch 均有退出阶段日志。证据 `.tmp/worktree-closure/retained/managed-ai-closure/.tmp/managed-closure-ready/desktop-runs/1df240c1-d8a3-4913-b3fe-7d176e522853/`；失败对照 `419534b9-745d-4048-9a70-7b2b2f769331/` 保留。真实本地 Hosted/持久账本 HTTP 17/17，桌面账本 2 条 SUCCEEDED；合成上游不是正式网关或真实模型。历史退出超时未复现，根因仍未证实。
- **安全证据纠正与剩余事项**：原 ZIP 扫描压缩字节会漏检，现逐条目解压；既有 ZIP 独立复核 2 个文件条目、4 个仍保留的会话 token 及 3 个 fixture 凭据均未泄露，managed credentialRef=null。原无回退场景虽记录 submitted=true、零新增上游/记账及无禁止调用，但响应错误码未捕获，竞争凭据为不可调用合成引用，不能宣称可用账号/BYOK 组合已完整验收；新脚本要求真实提交、期望错误码和 observer 请求完成记录。最终客户端计时补丁及加强后的桌面脚本未重跑 Electron/生产构建，不把原 20/20 当作最终版本通过。仍需当前版本定向复验、可用竞争配置无回退补验，以及正式规则、公网网关/真实模型、部署发布授权；`PARTIAL / passes:false` 保持，COMING_SOON 不变。fixture 均 STOPPED，Worktree 和证据保留。

- **2026-11-12 任务 A 修复集成（功能验收未闭环）**：基于 Main `dd6f6d45` 修复会话读取失败处理并增加脱敏 broker/退出阶段日志。解密失败保留密文，解密成功但格式非法时清理；Windows 在所属根进程存活时异步终止进程树，persistent runtime 清理经服务与主退出链完整等待。复核定向 8 文件/145 项通过，含真实 Windows 父/后代终止、无关进程隔离及待完成清理等待；改动 ESLint 与语法检查通过。
- **证据边界**：原 Owner 的真实 Electron/DPAPI 探针验证写读、超过 60 秒读取、过期清除和同数据目录退出重开，证据 `.tmp/worktree-closure/retained/electron-credential-shutdown/.tmp/electron-credential-shutdown/run-1794450580165/`（`out/phase1-result.json`、`out/phase2-result.json`）。探针使用自定义 main、同进程客户端及 `app.quit()`，早于本次复核补丁；不覆盖实际应用 renderer 退出 IPC、独立 backend、生产装配路径。本轮未重跑 Electron、生产构建或完整 E2E；客户端 5 秒超时不能中断 broker 内同步文件操作。历史读取/退出失败的确切根因仍待定位，实际应用共享阻塞未宣称解除，`PARTIAL / passes:false` 保持，后续按原剩余条件复验。

- **2026-11-11 Main 实测未通过**：复用逐文件核对的 Main `21d81f5e` 生产装配，Windows Electron fresh-native/full、本地合成Hosted/假上游，合并续测证据为7 PASS/7 FAIL/2 NOT_RUN/2 BLOCKED。Key/连接、正常调用溯源和记账通过；额度耗尽提示通用错误、设置状态/用量及无权益/过期/续期反馈未通过；会话到期后密文文件清理观察超时。换Key/断开未覆盖，退出重开受A共享退出超时阻塞。fixture清理报告失败，复核相关进程已结束；不因重试或进程最终消失认定根因。真实模型未调用，PARTIAL/passes:false不变。具体证据和边界见JSON最新notes及 `.tmp/main-ab-20261111/results.json`。

- **2026-11-10 准备包集成**：受控工具见 `scripts/managed-closure-ready/README.md`。补齐本地权益/额度/幂等/UNKNOWN/会话到期验证和下一阶段桌面入口；不改变发布门，不设 passes:true。旧11/01格式错误与数据根问题已由11/10补丁及复验收口，不再重复派开发。真实服务证据转存目录见 JSON 最新 notes。

- **P1 / IN_SCOPE / PARTIAL / `passes: false`。** 本地真实 HTTP 调用与权益/额度链路、用户会话兑换和断开入口已补齐，**面向用户的完整托管能力尚未交付**；隔离 Beta 真实网关、Key 兑换及桌面主链已有证据；正式套餐/客服规则、生产开放及剩余边界验收仍待完成，生产可用性保持 COMING_SOON。
- **2026-10-31 隔离真实网关 Beta 复验**：本机 hosted 服务（127.0.0.1:8787）+ `.private/managed-upstream.env` 真实上游凭据，beta-user-1 会话与 beta plan；`ManagedAiUsage` 实记 text×2/stream/structured 共 4 条，3 条 SUCCEEDED 含真实 token 计数，1 条 FAILED 仍 COMMITTED 计费。证据 `.tmp/managed-beta/`。会话仍由 `provision-session` 手工发放、dev env 注入，非用户产品链路。
- **2026-11-01 Owner 决定**：订阅形态为「订阅充值」设置页——Key 填入 + 无 Key 联系客服备注，不做支付闭环；`VOCATRYA_HOSTED_ENDPOINT` loopback 为 operator beta 通道，生产构建（含 Windows Electron）由此放行 managed 链路进入充值页验收，非 loopback 值不改变发布门。桌面验收待执行，`PARTIAL`/`passes:false` 保持。
- **2026-11-01 Windows Electron 验收通过**（`.worktrees/managed-recharge` 未提交构建，fresh-native，生产模式后端 + loopback hosted 127.0.0.1:8787）：注册登录 → 设置「订阅充值」页；错误格式 Key（非 43 字符）正确拒绝 `MANAGED_AUTH_REQUIRED` 且不落盘；beta 会话 Key 兑换后 CONNECTED——托管账号 beta-user-1、订阅 ACTIVE、套餐 beta、已用额度 4/1000（与 hosted 账本一致）；会话经 safeStorage 写入 `hosted-sessions/<sha256>.dat` 74B 密文（DB/备份无明文），`AIConnection` 行 status=CONNECTED/credentialRef=null。证据 `.tmp/worktree-closure/retained/managed-recharge/.tmp/managed-recharge/`。待办：错误格式与网关拒绝同码 `MANAGED_AUTH_REQUIRED` 的 UX 区分；dev 启动下 `hosted-sessions` 落在 `.codex-tmp/desktop-poc` 而非 `VOCATRYA_DESKTOP_DATA_ROOT`（packaged 路径正确），交桌面入口 Owner。
- **2026-11-01 端到端 managed 调用补充**（同实例，GLOBAL_DEFAULT → managed deepseek-flash）：Electron Agent 面板发消息 → `/api/ai/chat` → hosted 网关 → 上游真实回复渲染（「你好，我是 Vocatrya 助手…」）；hosted 账本新增 2 条 CAREER_DIALOGUE usage（SUCCEEDED/COMMITTED，真实 token 3219/16 与 932/43，committedUnits 4→6，CAREER_DIALOGUE binding 按需铸造）；应用侧 `ChatConversation` 落库且 `managedAiProvenance` 记录 managedBindingId 全链路溯源；重启应用后会话/连接保持 CONNECTED（safeStorage 持久化生效）。此前发送无请求的根因：preflight 未就绪时按钮禁用下 force-click 不产生提交，非缺陷。
- 托管服务必须由**部署/服务端保管上游网关凭据**；模型目录由服务端控制，稳定产品模型 Key 与上游模型 ID 分离；订阅/Entitlement 决定模型可用范围和用量，需具备配额、可靠用量记录、并发/异常恢复及用户可理解的状态。
- 用户已向**青云 TOP 客服**询问中国市场相关接入并得到“没有问题”的商务回复；据此可继续推进方案，但不能替代获授权真实网关的技术测试、服务稳定性、额度记账和上线验收。
- 先核对已有 Managed AI 工程阶段与真实环境准备状态，再在隔离 Beta 环境、真实授权网关/测试预算下执行业务 E2E；最后验收订阅权益、模型选择、额度边界、失败记账、三条 AI 路径隔离和 Windows Electron 用户体验。真实凭据/部署/目标数据库需要专项 Gate。

**三条路径共同原则**：共享可复用业务调用契约，但账号登录、BYOK、托管网关的身份/凭据/模型能力/计费边界不得混用；不默默切换到另一种路径。每条 AI 各自维护 `implementationStatus`、证据与 `passes`，一个通过不代表其他通过。

### RESUME-BUILDER：结构化模块简历工作台（P1 核心）

- 2026-10-29 已集成 [工作台实施合同 v2](./RESUME_BUILDER_CONTRACT_PROPOSAL.md)（`06efa71b`）与本聊天批准的剩余六组规则；本次经用户明确授权，将 `codex/resume-builder @ 559a2bce` 的实现合并 Main。依赖已锁定：`@dnd-kit/core` 6.3.1、`sortable` 10.0.0、`utilities` 3.2.2、`docx` 9.15.0。AI 改写与粘贴导入继续延期。

- **P1 / IN_SCOPE / IMPLEMENTED / `passes: true`。** 本期两栏素材工作台、Section/Item/Expression 排序/隐藏恢复、素材与证据快照、版本对比/新草稿/岗位绑定、篇幅软目标与分页预览、服务端 DOCX 导出主链路已集成。161 项定向测试、真实字体 Chromium 分页 5 样例、浏览器组件 7 项、类型/lint、隔离库 61 条迁移与备份往返已有证据；集成源码与测试来源一致。本次没有执行 Windows Electron/E2E 或真实业务完整往返，未达成的验收条件继续保留，不将浏览器组件 Mock 证据视作功能验收。

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

**最低验收**：选用真实形态的简历样例，在隔离 Windows Electron 中完成导入→解析校对→拖拽/局部编辑→创建岗位版本→恢复/对比→篇幅校验→导出并打开；验证素材完整性、旧版本正文不被静默改写、导出内容与预览一致。具体 JSON Schema、解析支持格式、可编辑导出格式及排版引擎应先设计/审查，不把这些设计决策冒充已实现事实。

**2026-10-30 现行行为**（细则见 [工作台合同](./RESUME_BUILDER_CONTRACT_PROPOSAL.md) 文首同日修订；`passes` 仍 false）：

- 草稿中的条目可以拖到其他分节，或用「移动到分节」移入。同一职业素材不能在目标分节重复出现。
- 预览栏可以拖拽或方向键调整宽度，也可以隐藏。宽度和隐藏记在本机，不进版本。
- Word 导出与打印预览对齐联系方式/链接分行、分节大写、非正文项目符号和姓名字号。分页仍以导出 PDF 为准。
- 草稿、已冻结、已投递可以改状态。改回草稿不改写正文。这些版本可以删除，除非已被申请或深度匹配引用。删光版本后可以新建空白草稿。
- 同日早些时候，在与 Main `9bbe0ecc` 产品树一致的 `673e3460` 装配上，隔离 Electron fresh-native/full 用 DeepSeek `deepseek-flash` 完成真实导入预览、排除 `Contoso Lumen Internship`、确认保留 `Northwind Atlas Frontend`，以及退出后重开。证据在 `.tmp/worktree-closure/retained/p1-resume-ai-import-acceptance/.tmp/p1-resume-ai-import-acceptance/RESULT.md`。该装配不含上述四项修订。用户随后在该装配上确认检查 1–5 通过。AI 改写和粘贴导入仍不在本期。


- **2026-10-31 集成与验收收口**：四项修订及 B7 设备级偏好快照纳入 Main。结合此前通过项，Windows Electron fresh-native / AB_ENABLED / full 本轮 B7 在端口 63829→62016、同一隔离 data/config 下完整退出重开恢复隐藏及宽度，C7–C9 全过；C6 为驱动竞态且数据库正确。当前冻结范围最低验收满足。证据 `.tmp/worktree-closure/retained/resume-preview-persistence-fix/.tmp/resume-preview-revalidation/evidence/results.json`。独立审查无必须修复项；historicalIntegrity 两个既有返回形状失败未扩项。未重复构建/桌面验收，未操作真实库。

### AGENT-CAPABILITIES：fresh-native/full 六工具；canonical `match_job` 已集成

- **P1 / OWNER_DECISION / PARTIAL / `passes: false`。** 本轮不重新规划其他 Agent 扩展。`add_job` 需用户确认且不代表实际投递；`review_resume` 不自动保存至 Resume Variant。`generate_cover_letter` 仍未在 freshNativeFull 开放。
- 2026-10-30 Main 集成 [`AGENT_MATCH_JOB_CONTRACT_PROPOSAL.md`](./AGENT_MATCH_JOB_CONTRACT_PROPOSAL.md)（`90a1a6af`，merge `264b463d`）：合同区分源码事实、推荐与待决定；2026-10-31 同步 Owner 已批准 D1–D6 全部推荐。
- **2026-10-31 Main 集成 canonical `match_job`**（`67a3adf6`，merge `393155fc`）：仅 `freshNativeFull` 用 canonical 实现替换 `match_job`；输入不接收 `jobId`（会话职位）；`needsApproval` 恒真；缺省 career-profile 简历；`VERSION_NOT_SUBMITTABLE` 拒绝；每次显式用户轮次新分析行。新增 `AgentToolExecution`（去重键 `(conversationId, toolName, turnKey)`，`turnKey` 为持久化用户消息 ID；`operationKey` 唯一；`matchAnalysisId` 唯一；分析行与 `PENDING→COMPLETED` 同事务）。Legacy `match_job` 保留给非 freshNativeFull 运行时。原窗口报告 `tsc`、相关 ESLint、48 项定向测试、隔离 SQLite `migrate deploy` 与 `db:verify-migration-invariants` 通过。未跑完整 Build、Windows Electron E2E、真实 AI 或真实库迁移。
- 原 **RM-MATCH 的 P1 台账归属**仍在本 Feature。其余 Agent 能力范围保持待裁定，不因本次实现自动加入职位更新、投递流程或简历写入工具。
- **不迁移/删除独立业务服务**：canonical 职位详情 FAST_SCREENING 最小链路继续由 `match_job` 复用。Deep Match 不在已交付能力中。
- 现有工具的真实连接与批准边界仍按既定验收执行；其他 Agent 新工具**暂不讨论**。Activity 已决定退役，不再将读取 Activity 列为未来待增工具。

## C. 依赖、未决实施合同与所有权

| 工作包 | 依赖与实施约束 |
| --- | --- |
| ACTIVITY-RETIRE | 先解耦 Task 分类再移除 Activity；Schema/Backup 由单一 Owner 收口；旧 Activity 备份已冻结为非空整包拒绝、空组兼容剥离；**真实目标库迁移是否进入 `passes` 门槛**仍须明确，不得静默丢失其他数据。 |
| BD-ARCHIVE | 与职位/对话列表、统计口径、引用与用户数据隔离相关；应明确归档状态的持久化、恢复冲突和备份行为，不自动变成 30 天清理/回收站。 |
| AI 三路径 | 可共用业务 AI 执行接口与 Settings 的 Model Assignment，但认证、凭据、用量、能力验证及每条路径的验收独立；Managed AI 的服务端部署/网关/预算须另设 Gate。 |
| RESUME-BUILDER | 先核查当前 Resume/Career Material/Variant 契约，明确结构化 JSON Schema、文件格式和导出/分页合同；不以旧匹配功能存在代替简历编辑器验收。 |
| AGENT `match_job` | freshNativeFull 已接通 canonical 实现并复用独立 Match 服务；Legacy 路径未改。未完成真实 AI / 桌面验收，不得把 `passes` 置 true。 |

共享设置宿主、工具注册/提示、Schema/备份、双语词典与简历格式各由实际任务指定唯一协调责任方；派工时重新核实仓库 HEAD、Dirty、工作树、测试环境和已有证据。原审计及历史里程碑是参考，不是最新代码事实。

## D. 完成口径与执行边界

- 2026-10-29 本轮收尾集成：导入条目级排除使用独立可空选择签名列（新迁移 `20261029010000_resume_import_selection_signature`），与首次版本确认同事务写入，原始 AI 缓存不改；补齐导入双语、选择后数量摘要与任务分类术语。九个定向测试文件共 136 项、完整类型检查及改动文件 ESLint 通过，隔离 SQLite 旧行升级与失败原子性已覆盖；未运行真实 AI、生产构建、真实库迁移或修复后的桌面复验。
- 2026-10-30 活动退役与归档最终补丁在 Main `39a5a1d3`、构建 `Jtz89Wr0azHP7RnkA_zTH` 的 Windows Electron fresh-native/full 中联合复验：ACTIVITY-RETIRE 38/38、BD-ARCHIVE 55/55 均 PASS。证据位于 `.tmp/worktree-closure/retained/p1-activity-archive-recheck/.tmp/p1-activity-archive-recheck/`；宿主进程均经 quit IPC 正常退出，无残留进程。该定向复验未覆盖真实外部 AI、真实用户库、安装包/系统自启或完整桌面 E2E，不将其外推到其他 Feature。
- [归档合同修订提案](./ARCHIVE_CONTRACT_PROPOSAL.md) 随本轮交付，2026-10-29 Owner 已冻结八项规则：七项采用推荐，D6 改为 AI 完全不可读归档内容，含历史引用、消息、摘要与快照。本轮只冻结合同，不启动归档开发。

- 2026-10-29 Main 组合验证：14 个定向测试文件、212 项通过，覆盖任务/分类、Dashboard、备份拒绝与往返、BYOK 截止/取消及 AI 运行时断言。重新生成 Prisma client 并刷新遗留活动页的 Next 路由类型后，完整非增量 TypeScript 检查通过；未运行生产构建或桌面/E2E。
- `passes` **按七个 Feature 分别**认定：ACTIVITY-RETIRE 需要拆除与保留功能回归、备份/隔离迁移及桌面证据；BD-ARCHIVE 需要职位和对话归档/恢复与长期保留的验证；三条 AI 各自需要真实业务调用及隔离桌面体验；RESUME-BUILDER 需要解析、拖拽、版本、分页、导出的完整用户闭环；AGENT 保持原工具验收和待裁定扩展边界。
- 真实业务数据、凭据、数据库迁移、生产系统与发布不能由台账范围自动授权。原则上先使用合成数据和隔离环境完成最小充分验证，不盲目重复既有有效版本认证；必要的真实连接验收另取明确授权。
- 2026-10-29 本轮已获提交/合并授权并完成三条工作线 Main 集成；未推送、发布、部署，未进行真实库迁移、真实模型调用或 Windows Electron/E2E 验收。功能完成情况仍按实际证据认定，全部 `passes` 保持 `false`。

- 2026-10-29 本聊天安排：活动退役补丁复验统一留到 P1 结束后人工检验，passes 保持 false，不新增本轮桌面构建；简历工作台剩余六组规则已批准，AI 改写仍延期，开始隔离实施，尚未完成或验收。

### 2026-10-29 简历工作台本地开发交付（未集成）

2026-10-29 本聊天本地开发交付：codex/resume-builder（.worktrees/resume-builder），基线 Main 051eeaf1 + 未提交修改。本期 T1–T4 已实现：左侧素材库/右侧编辑与实时预览、素材及单条证据拖入、键盘/指针排序、三级隐藏与溯源克隆、目标职位及版本差异/新草稿、篇幅软目标/CSS 分片预览、服务端 DOCX artifact/下载；T5 沿用已集成条目排除。新增 additive 迁移 20261029020000_resume_builder_visibility，备份 V7 兼容读取 V1–V6。15 个定向测试文件 161 项通过；随后最终编辑/导出 UI 34 项复测通过，类型检查与改动文件 ESLint 通过。独立 Chromium 分页 5 个固定样例（真实 Inter 字体、密集要点/超长条目/标题边界/隐藏内容/中英文）逐标记与块片段页号和 PDF 页数一致；7 项浏览器组件检查使用合成 graph/Action mock，仅证明 UI 交互，不作为真实持久化或桌面验收。持久化、拒绝写入、DOCX 重建与备份往返由隔离 SQLite 定向测试覆盖；独立空库 61 条迁移 deploy 与 REQUIRED_RAW_MIGRATION_INVARIANTS 通过。初次迁移检查因未指定 DATABASE_URL、首次 deploy 因隔离库文件尚未创建失败；创建空隔离库并指定其 URL 后通过，未访问真实库。代码尚未提交/合并 Main，未执行生产构建、Windows Electron/E2E、真实 AI 或真实数据库迁移；Main implementationStatus 与 passes 不因本地开发改为完成。

### 2026-10-29 工作台首次 Main 集成记录（历史）

用户已明确授权提交与合并。合同记录提交 `ce7c17b7`，工作台来源提交 `559a2bce`；共享文档无冲突，合并源码与已验证来源一致，复用上文定向证据，未重复构建。RESUME-BUILDER 实现状态随本次合并更新为 IMPLEMENTED，所有 P1 passes 仍 false。归档功能仍 MISSING，仅合同冻结；活动退役剩余复验仍由用户安排 P1 结束后人工检验。保留 `codex/resume-builder` 分支与 Worktree，未推送、发布、操作真实数据库或清理其他任务。

### 2026-10-29 三窗口收口与 Main 集成

- 已获提交及集成授权。归档来源 `5df3ce9a`，托管 AI 本地补齐来源 `e63d51df`，DOCX 运行时修复来源 `7ec2415a`，均已合入 Main。BD-ARCHIVE 更新为 IMPLEMENTED，AI-MANAGED 更新为 PARTIAL；七项 `passes` 均保持 false。
- 三项收口：备份版本陈旧断言由 V6 对齐 V7；补齐 `NOT_ENTITLED` / `MODEL_NOT_ALLOWED` 的分配错误中英文提示及组件回归；按锁文件补齐 Main 缺失依赖、重新生成 Prisma Client，纠正原先“39 个基线代码错误”的环境判断。组合检查另移除 DOCX 测试中不再必要的类型抑制注释。
- 归档合并前复审补强：历史工具结果、上下文及摘要含归档职位引用时禁止送入 AI；提醒领取事务内复核父对象归档状态，防止陈旧 reconcile 复活送达；原有对话永久删除入口与归档并存。补修后原窗口 111 项定向测试及类型/lint 检查通过。
- Main 组合回归 10 文件、150 项通过，覆盖归档、AI 路由、托管 HTTP 闭环、权益提示、DOCX、提醒、历史投递统计、备份往返和隔离迁移。完整非增量 TypeScript 检查零错误；改动 TypeScript 文件 ESLint 无错误，仅 `jobsAbReadPath.spec.ts` 两处原有无用抑制警告。
- 原简历验收窗口 Windows Electron fresh-native 开发态记录 49/50 PASS、0 FAIL、1 BLOCKED，已核对日志及 PDF/DOCX 产物；真实 AI 导入预览/条目排除仍阻塞。证据位于 `.tmp/worktree-closure/retained/resume-builder-acceptance/.tmp/resume-builder-acceptance/`。该证据不代表本次组合 Main 已重跑桌面验收。
- 本次未运行新增生产构建、桌面/E2E、真实网关调用、部署或真实数据库迁移。归档桌面验收、托管真实环境/产品入口与简历真实 AI 导入仍待完成。保留三个分支、Worktree 与既有证据，不推送或清理。

### 2026-10-29 三线修复与会话入口集成

- Main 集成账号长输入/导入往返测试 `c9079a0f`、BYOK 凭据状态修复 `2e8dca6c`、托管会话入口 `83b12201` 及失败/并发修复 `3bd3e1d8`。六个账号适配器改用 stdin 或隔离 prompt 文件，避免 Windows argv 长度限制；保留已有版本与权限门控。
- 合并前复核修复托管总览中临时错误掩盖后续 401、旧请求误降级新会话两处缺陷；生命周期锁与内存修订号按桌面单 Next 服务进程保护状态，不向 SQLite 写入凭据或会话代次。
- 最终组合 Main 产品源码 `fb2d9b20`：运行时及 hosted-session 共 32 文件/537 项通过；托管总览/卡片/HTTP loopback、业务分配、简历导入往返及 BYOK 连接共 6 文件/101 项通过；完整非增量 TypeScript 检查、相关 ESLint 与差异检查通过。先前 A/B 组合另有 5 文件/105 项通过，计数含重叠，不累加。
- HTTP loopback 使用合成上游及 safeStorage 桩，长输入使用合成子进程；未执行真实 AI、生产构建、Windows Electron/E2E、部署或真实库迁移。账号/简历真实导入、BYOK 真实 Key、托管真实网关与订阅发放仍待对应验证，相关 passes 保持 false。未推送或清理 Worktree。

### 2026-10-31 match_job 决策同步

Owner 已批准 D1–D6：仅 freshNativeFull、仅会话职位（不接收 jobId）、needsApproval 恒真、缺省 career-profile、VERSION_NOT_SUBMITTABLE、每次显式请求新行；同一执行崩溃恢复仍须幂等。

### 2026-10-31 canonical match_job 与 P2 合同提案 Main 集成

用户授权提交并合并。来源：`codex/p1-match-job-implementation` @ `67a3adf6`（merge `393155fc`）、`codex/p2-job-interview-contract` @ `22465ae3`（merge `72f69163`）、`codex/p2-overview-contract` @ `680b3879`（merge `8fb2fd32`）。AGENT-CAPABILITIES 保持 OWNER_DECISION / PARTIAL / `passes: false`。P2 两份合同仍为提案，未冻结、未编码。未推送、未部署、未操作真实库。
