# Vocatrya Harness 优化实施台账

记录日期：2026-11-16（Asia/Shanghai）。核对基线：`main@992feb9e`。
配套机器可读文件：[HARNESS_OPTIMIZATION_ROADMAP.json](HARNESS_OPTIMIZATION_ROADMAP.json)。

本文记录已批准的增量路线、实际实现与剩余工作，不是新的执行授权。实现、集成、验收分开记账；本轮同步实现、集成与验收边界；最终决策合同仍保留如下。

## 当前结论

- H01/H02 已集成；验收报告已回收，真实模型仍 BLOCKED，passes=false。
- H03 执行已结束：Electron fresh-native + 合成上游；面试练习部分在 Web 完成，不能称桌面完整闭环通过。
- H05 已实施并集成，提交 d1e4bf85；本轮收尾修复提交 6c551703。
- 专用本地准备路由保留同一 InterviewSession；通用面试入口仍保留迁移提示。新路由尚待 Electron 定向复验。
- H04 的 D1–D8/C01–C08 合同不变，H06 仍后置；原 AGENT_LONG_TASK_HARNESS_PROPOSAL.md 不纳入提交。

## 架构与约束

- **模型接入**：账号运行时/API 提供模型能力，Vocatrya 负责本产品工具编排、权限和业务结果；不等同于直接使用完整供应商原生 Agent。
- **运行时执行**：HarnessTask / HarnessTaskEvent：具体执行的恢复账本，不随备份恢复。
- **业务状态**：InterviewPrepGoal / InterviewSession / MatchAnalysis：长期目标与业务产物；按各自契约备份。
- **结构化交接**：从已绑定业务记录确定性重算，handoffJson 是辅助快照，不取代业务事实。
- **执行追溯**：目前仅深度匹配路径的轻量轨迹；哈希/引用不等于完整输入重建。

- 增量演化，不替换已有 Harness 或引入完整 DeepSeek/Cordis 框架
- 代码事实、模型建议、用户授权分开；不能用模型散文决定权限或完成
- 历史兼容 agentRole=NULL 不作为新功能扩权手段
- 前后端同一用户成果同步交付，持久化/并发以隔离数据验证
- 实现、Main 集成、真实模型验证、Windows Electron 验收分别记账
- 关键业务提交可靠持久化，观察性日志可以降级；不宣称可丢日志能重建全部执行
- 守护真实数据，不改已执行 Migration，不恢复旧租约或自动重放授权

## 阶段总览

| 阶段 | 内容 | 当前状态 | 后续 |
| --- | --- | --- | --- |
| H01 | 可恢复深度匹配与轻量追溯 | MERGED_PENDING_ACCEPTANCE / DESKTOP_FIXTURE_PASS_REAL_MODEL_BLOCKED | 配置可用授权连接后补真实模型冒烟，不重复已有效的夹具验收 |
| H02 | 面试准备目标、确定性交接与用户主动续做 | MERGED_PENDING_ACCEPTANCE / PARTIAL_PASS_DESKTOP_ROUTE_RETEST_PENDING | 定向复验新的桌面准备路由与同一会话续做；有授权连接后补真实模型冒烟 |
| H03 | 两项已集成功能的集中 Windows Electron 定向验收 | COMPLETED_WITH_BLOCKERS / PARTIAL_BLOCKED | 只复验修复涉及的构建入口和桌面准备导航，不重跑完整历史链路；真实模型等待可用连接 |
| H04 | 持久审批的只读调研与最小实施契约 | DESIGN_DECISIONS_APPROVED / NOT_APPLICABLE | 已批准 D1–D8/C01–C08 作为 H05 合同；实施与集成见 H05 |
| H05 | 持久审批首个消费者的前后端实施 | MERGED_PENDING_ACCEPTANCE / PENDING | 按授权安排真实服务与 Windows Electron 定向验收，不自动执行下一阶段 |
| H06 | 用户显式开启的自动唤醒与有界推进 | DEFERRED / NOT_STARTED | 持久审批和相关恢复/预算契约稳定后再评估，不自动开工 |

## H01 · 可恢复深度匹配与轻量追溯

状态：MERGED_PENDING_ACCEPTANCE；实现 IMPLEMENTED；集成 MERGED；验收 DESKTOP_FIXTURE_PASS_REAL_MODEL_BLOCKED。

Feature：HARNESS-DEEP-MATCH。提交：1e2181a9、04a093cc。

范围：

- HarnessTask / HarnessTaskEvent 运行时账本
- PIN_INPUTS → RUN_ANALYSIS → COMMIT_RESULT；固定 JD、简历材料及首次解析的连接/模型
- CAS claim、claimEpoch 栅栏、心跳、过期失权、周期发现、取消、恢复与重试
- 任务结果与 MatchAnalysis 在同一事务中绑定；一个任务不重复落库
- 职位页版本选择、真实任务状态、结果与来源、stale 提示
- 仅深度匹配路径的轻量调用追溯，不承诺所有聊天轨迹或精确模型输入重放

修复：

- 首次加载失败 Retry 可达
- 租约过期后即失权，不以被接管为前提
- 完整检查点结构与步骤一致性校验
- 运行期间 JD 更新后，新落库的旧材料结果标记 stale
- runner 真实心跳与取消 AbortSignal 联动

证据：

- INTEGRATION_OWNER_REPORT：集成时及同步 main 后，harnessDeepMatchTask 17/17、deepMatchSection 8/8；git diff --check 通过。
- CODING_OWNER_REPORT_REUSED：tsc、ESLint、隔离 SQLite Migration 与不变量、matchAnalysis/fastScreening/saveMatchResult 36/36；集成 Owner 未复核原始输出。
- ACCEPTANCE_OWNER_REPORT：Windows Electron fresh-native 深度匹配 8/8；上游为合成夹具。证据 F:/vocatrya-acceptance-runs/167afc0d-7e50-4b73-875c-fb7178fdaeae。构建曾补入 extensions/ 并规范化非法 UTF-8 注释，不能称为未经修改的 992feb9e 原样构建。

边界：

- 真实模型连接缺失，真实模型冒烟 BLOCKED，passes=false
- HarnessTask/HarnessTaskEvent 不随备份恢复；业务结果继续备份

下一步：

- 配置可用授权连接后补真实模型冒烟，不重复已有效的夹具验收

## H02 · 面试准备目标、确定性交接与用户主动续做

状态：MERGED_PENDING_ACCEPTANCE；实现 IMPLEMENTED；集成 MERGED；验收 PARTIAL_PASS_DESKTOP_ROUTE_RETEST_PENDING。

Feature：INTERVIEW-PREP-CONTINUITY。提交：992feb9e、6c551703。

范围：

- InterviewPrepGoal 是可备份的长期业务状态，与运行时 HarnessTask 分离
- 绑定明确职位/JD；最多关联一个既有 InterviewSession；支持暂停、恢复、结束和新轮次
- 每次读取从实际问题、回答、反馈和总结记录确定性核验；handoffJson 只是辅助快照
- 职位详情面试准备入口、固定上下文创建流程、继续同一练习、真实进度与总结来源
- full AB 能力门对齐前后端；Legacy/受限模式不开放该入口，不使用 agentRole=NULL 扩权
- 备份格式 v9；目标与会话关系、JSON 内嵌引用重映射；兼容旧备份，不恢复自动执行

修复：

- 导航使用接口返回的完整目标 DTO，避免闭包旧 goal
- 新轮次请求成功后更新幂等键，同次失败重传保留原键
- 目标接口与 goal-bound 面试创建共享模式门
- 创建练习的事务中按 ACTIVE、revision、材料与 liveSlot CAS 复核后绑定
- 非法 UTF-8 注释规范化；准备目标使用 /dashboard/interview-prep 专用本地路由，复用既有练习组件，通用入口仍保留迁移提示；服务端复核所属用户、目标绑定与能力门

证据：

- ASSISTANT_EXECUTED_ON_SOURCE_WORKTREE：收尾修复版 4 个定向测试文件共 79/79；完整 tsc --noEmit --incremental false、相关文件 ESLint、git diff --check 通过。该证据来自提交前来源 Worktree，不是 Main 桌面证据。
- CODING_OWNER_REPORT：初始实现：隔离 SQLite 19/19、组件 6/6；备份 round-trip/v8 兼容及受影响面试回归通过。收尾后测试数已有增加，不与 79 重复累加。
- INTEGRATION_OWNER_REPORT：992feb9e 快进集成 Main；Main prisma generate 与 tsc --noEmit 通过。
- ACCEPTANCE_OWNER_REPORT：目标管理与练习链路 7/7，练习部分通过 Web 驱动；F:/vocatrya-acceptance-runs/167afc0d-7e50-4b73-875c-fb7178fdaeae。真实模型 BLOCKED。

边界：

- 原验收为 Electron 目标管理与恢复导航 + Web 练习，不是完整桌面练习闭环
- 专用本地准备路由已修复，Windows Electron 修复后路径尚未复验；真实模型 BLOCKED，passes=false
- 不自动唤醒，不修改真实 dev.db

下一步：

- 定向复验新的桌面准备路由与同一会话续做；有授权连接后补真实模型冒烟

## H03 · 两项已集成功能的集中 Windows Electron 定向验收

状态：COMPLETED_WITH_BLOCKERS；实现 NOT_APPLICABLE；集成 NOT_APPLICABLE；验收 PARTIAL_BLOCKED。

Feature：集中验收。提交：见相关阶段。

范围：

- 唯一桌面重型执行者；隔离源码快照、必要生产构建、装配、fresh-native 桌面验证
- 同一有效产物覆盖两项功能，场景数据分别隔离；不默认全仓完整 E2E
- 深度匹配真实模型成功、取消/重试、离开/刷新/退出重开、不重复落库与来源/stale
- 面试目标创建、部分练习后退出重开、继续同一会话、真实反馈总结、新轮次准确导航
- 用户已授权连接下的最少真实模型冒烟；故障路径优先受控夹具
- 核对并更新相关 Feature；补登记面试准备条目，条件未全部满足保持 passes=false

修复：



证据：

- ACCEPTANCE_OWNER_REPORT：992feb9e 隔离快照，Windows Electron fresh-native，19/19 步骤 PASS；构建包含 extensions/ 输入补齐与注释编码规范化。F:/vocatrya-acceptance-runs/167afc0d-7e50-4b73-875c-fb7178fdaeae；验收 Owner 报告进程均已退出。

边界：

- 模型调用均为受控夹具，真实模型未通过
- 原构建有快照修正，专用准备路由修复后未重新运行 Electron
- 无真实数据库操作

下一步：

- 只复验修复涉及的构建入口和桌面准备导航，不重跑完整历史链路；真实模型等待可用连接

## H04 · 持久审批的只读调研与最小实施契约

**状态**：设计已完成且合同已批准；H05 后续实施与集成见对应阶段。**责任角色**：Owner 决策已确认；待指定实施 Coding Owner。
**依赖**：H01、H02。**Feature 映射**：未登记独立对应项，不能视为已有 MVP Feature。

本阶段范围：

- 只读核对 conversationRequest、toolExecution、工具权限、Harness 与业务目标的现有契约
- 只选一个已有 approval-gated 写操作作为首个消费者，不新增外部业务能力
- 设计不可变提案、输入/材料版本、用户决定、执行与结果的独立身份
- 解决跨页面/重启恢复、权限重校验、重复决定、撤回/取消竞态、外部结果不确定
- 设计备份后历史保留与旧授权失效；不恢复自动执行
- 包含最小前端审批/执行/回执流程、测试矩阵与明确非目标

证据与来源：

- `SESSION_INSTRUCTION`（历史）：最初已给出 Agent B 设计指令；后续设计已交付并按下述裁定完成 H05。
- `USER_COMPLETION_REPORT_AND_LOCAL_ARTIFACT_CHECK`：用户回报设计完成；本次核实 .tmp/persistent-approval-design/design.md 存在并被 git check-ignore 命中，读取设计及决策清单。未专项复核其全部源码结论，未实施或批准设计推荐。
- `USER_EXPLICIT_DECISION`：用户明确同意采用助手最终推荐并写入 wiki；D6/D7 覆盖原稿相反推荐，补充 queued receipt、dispatch 前过期、恢复快照歧义、硬删/重新生成/归档/孤儿 part 不变量。未授权 H05 编码。

未覆盖与限制：

- 仅设计，不改源码/Schema/Migration/wiki，不调用真实模型或外部写接口
- 不启动 Electron、Next 服务、Build 或 E2E
- 不得修改原始未跟踪方案文档

设计原稿：`.tmp/persistent-approval-design/design.md`（已核实存在且被 git-ignore，不随 Git 同步）。
原稿基线：`992feb9e`；交付时核对 SHA-256：`9c80dd4af5661cc4c473b04b52e8d6a778d20742ddea1b9bad790adbcdfbeafc`。

**决议优先级**：用户已确认下列最终裁定。原稿保留初稿，遇到 D6、D7 等冲突以本台账为准；本次未修改原稿、未授权产品编码。

已确认设计范围（尚未实施）：

- **首个消费者**：EXT-NOTION 三个共享 buildNotionWriteTool 的写工具：notion_create_page / notion_append_content / notion_update_record。
- **设计所述缺口**：现有审批卡片已持久化，但决定、执行、回执与叙述仍耦合 HTTP 回合；设计聚焦批准后的可恢复执行与跨表面决定。此处为设计结论摘要。
- 新增可备份 AgentOperationProposal，冻结工具输入/材料/turnKey，CAS 决定；决定与创建任务同事务，proposalId 为任务去重身份
- 本期 Notion 写工具统一 AGENT_TOOL_WRITE，由既有 HarnessTask runner/lease/epoch 执行 VERIFY → DISPATCH → SETTLE
- 可备份 dispatch 意图标记与稳定操作身份先于远程调用持久化；dispatch 后崩溃不盲目重拨，不确定结果人工/远程核对
- 恢复备份绝不自动重放；无标记不能证明未执行，重新执行创建关联原记录的新提案
- 会话删除 SetNull 保留执行证据；未发出动作撤销，已发出动作继续真实结算
- 前端真实 queued/终态回执与轻量待决入口；归档批准前先恢复，旧 Notion 孤儿 part 不授予执行权限
- **非目标**：match_job、add_job、自动投递、全局审批中心、第二套 runner/租约。

Owner 最终裁定：

| 编号 | 决策 | 最终裁定 | 状态 |
| --- | --- | --- | --- |
| D1 | 是否一律 detached 执行 | 统一后台执行 | 已确认 |
| D2 | legacy streamText 工具 execute 返回契约 | 返回已落库的真实排队身份 | 已确认 |
| D3 | 未决定提案是否继续阻塞 send/regenerate | 保持原会话待决阻塞 | 已确认 |
| D4 | 决策窗口有效期 | 7 天有效期，决定与发出前双重校验 | 已确认 |
| D5 | 非职位写任务的 Harness 业务锚点 | 复用任务表，职位锚点可空 | 已确认 |
| D6 | 备份恢复后已批准未执行的处理 | 恢复后不重放；先核对，必要时新提案 | 已确认 |
| D7 | 提案与来源会话的删除关系 | 来源可空，不无条件级联删除执行证据 | 已确认 |
| D8 | match_job/add_job 是否同批接入 | 本期仅三个 Notion 写工具 | 已确认 |

**D1 · 统一后台执行**

本期三个 Notion 写工具批准后一律走 HarnessTask，单一执行权威；其他工具不改。批准 HTTP 回合仍须正常结束，后续 send 不再因该已决提案被 pending 阻塞。

**D2 · 返回已落库的真实排队身份**

queued-stub 必须读取持久化且相互绑定的 APPROVED proposal/task，返回真实 ID 与状态；查不到或状态不符不得假报 queued。禁止 saved:true / created:true，不得被 hasWriteReceipt 或模型叙述当成写入成功。

**D3 · 保持原会话待决阻塞**

PROPOSED 继续阻塞来源会话 send/regenerate，不阻塞其他会话；外部已决由 admission 前的服务端 reconcile 对齐镜像。批准不等于执行完成，回合结束后可继续聊天。

**D4 · 7 天有效期，决定与发出前双重校验**

expiresAt 自提案创建起计算，不因批准/重启/重试自动延期。读/决定时惰性检查，dispatch 前再次检查。已批准但尚未发出就过期：任务 CANCELLED、outcomeStatus=CANCELLED、原因 AUTHORIZATION_EXPIRED，保留 APPROVED/decidedAt 历史。已发出后到期仍结算真实结果，不伪装取消。

**D5 · 复用任务表，职位锚点可空**

HarnessTask.jobOpportunityId 可为 null；按 kind 强校验：DEEP_MATCH 仍必须有职位，AGENT_TOOL_WRITE 必须绑定有效提案。不得新建第二套执行表、runner 或租约。

**D6 · 恢复后不重放；先核对，必要时新提案**

在远程调用前同事务保存可备份的 dispatch 意图/认领标记及稳定操作身份；标记不是远端成功证明。恢复后 APPROVED 无确定结果不自动执行；已知或可能发出的进入结果待核对。旧备份无标记不能证明未执行（可能备份后已发出）。需远端查询/可靠幂等能力或用户人工核对；确认可重新执行后创建新提案、新批准，关联原提案保留历史。一提案至多一个任务不因恢复而改写。NotionConnection 不随备份恢复，必要时先重新授权并核对目标与权限。

**D7 · 来源可空，不无条件级联删除执行证据**

conversationId nullable + SetNull。硬删会话时在与 dispatch 竞争的事务边界撤销 PROPOSED 和已批准未 dispatch 操作、取消对应任务；已 dispatch、UNCERTAIN 及终态记录保留结算/核对依据。来源为空时 DTO、回执入口和备份 idmap 可用，不能再强制跳回已删会话；历史证据不能变成新的执行授权。

**D8 · 本期仅三个 Notion 写工具**

notion_create_page / notion_append_content / notion_update_record 共用消费者；match_job、add_job 保持原路径，不纳入本期，不新增自动投递、全局审批中心或自动唤醒。

实施契约补充不变量（本次一并确认）：

### C01 · 排队回执不能冒充业务成功

queued-stub 必须读取持久化且相互绑定的 APPROVED proposal/task，返回真实 ID 与状态；查不到或状态不符不得假报 queued。禁止 saved:true / created:true，不得被 hasWriteReceipt 或模型叙述当成写入成功。

验证要求：真实绑定存在才返回 queued；缺行/状态不符返回真实失败或终态；hasWriteReceipt 与 regenerate 守卫不将 stub 当写入成功。

### C02 · 审批有效期与执行租约独立

expiresAt 自提案创建起计算，不因批准/重启/重试自动延期。读/决定时惰性检查，dispatch 前再次检查。已批准但尚未发出就过期：任务 CANCELLED、outcomeStatus=CANCELLED、原因 AUTHORIZATION_EXPIRED，保留 APPROVED/decidedAt 历史。已发出后到期仍结算真实结果，不伪装取消。

验证要求：批准后关机超过有效期再开机，未发出的任务零远程调用；已 dispatch 任务过期仍按真实结果结算；审批历史不改写。

### C03 · 持久 dispatch 意图与外部结果分离

dispatch claim、proposal 可备份标记/操作身份及必要账本更新同事务先于远程调用。claim 后崩溃属于可能已发出，不盲目重拨；最终结果可靠镜像到 proposal。

验证要求：claim 前/后、远程成功后但本地回执前分别中断；可能发出的只核对，不自动重复写。

### C04 · 旧备份缺失标记不是未执行证据

在远程调用前同事务保存可备份的 dispatch 意图/认领标记及稳定操作身份；标记不是远端成功证明。恢复后 APPROVED 无确定结果不自动执行；已知或可能发出的进入结果待核对。旧备份无标记不能证明未执行（可能备份后已发出）。需远端查询/可靠幂等能力或用户人工核对；确认可重新执行后创建新提案、新批准，关联原提案保留历史。一提案至多一个任务不因恢复而改写。NotionConnection 不随备份恢复，必要时先重新授权并核对目标与权限。

验证要求：覆盖“备份时尚未发出→备份后外部成功→恢复旧备份”的反例；无标记仍不得直接重发。重新执行是关联原提案的新提案，不能重置旧批准。

### C05 · 会话硬删与 dispatch 原子竞争

conversationId nullable + SetNull。硬删会话时在与 dispatch 竞争的事务边界撤销 PROPOSED 和已批准未 dispatch 操作、取消对应任务；已 dispatch、UNCERTAIN 及终态记录保留结算/核对依据。来源为空时 DTO、回执入口和备份 idmap 可用，不能再强制跳回已删会话；历史证据不能变成新的执行授权。

验证要求：硬删与认领并发：删除先赢则不能发出；dispatch 先赢则保留证据并结算。来源删除后回执可展示，空 FK 备份 round-trip 正确。

### C06 · 重新生成不能抹去在途写入语义

regenerate 守卫查询权威 proposal/task，而非只依赖 transcript 的 saved:true。尾部包含已批准排队、执行中、可能已发出或真实写入结果的 detached 操作时，不能当作无副作用回答重新生成；恢复或会话删除导致 task 缺失时仍核对持久提案。

验证要求：queued-stub 无 saved:true 也能阻止 regenerate 抹去已批准/在途写入；任务终态与撤销的允许行为须显式定义并验证，不绕过现有真实回执守卫。

### C07 · 归档会话可处理提案，批准前先恢复

归档来源的提案允许查看、拒绝、撤回；批准前要求恢复来源会话，再重查有效期、输入、权限与提案版本。提供准确恢复入口，不保留只能等过期的死条目，不直接放宽现有归档批准语义。

验证要求：归档下拒绝/撤回可达，直接批准被拒且零任务/零外写；恢复后过期或失权仍不能批准。

### C08 · 旧 Notion 孤儿 part 只作不可继续的历史记录

仅处理本期 Notion 写工具的有 part 无 proposal 情形。服务端 reconcile 标明“历史授权不可继续”并解除错误 pending 阻塞；不得从旧 approval-responded 自动补建 APPROVED 提案或触发写入。需要执行时新提案、新批准；不顺带改 match_job/add_job 兼容路径。

验证要求：旧数据与旧备份中的 approval-requested / approval-responded 孤儿均不死锁 send、不自动外写；其他工具行为不变。


相关入口：

- `src/lib/agent/conversationRequest.ts`
- `src/lib/agent/toolExecution.ts`
- `src/lib/agent/toolPermissions.ts`
- `src/lib/harness/`
- `src/lib/interviewPrep/`

下一步：

- 以本台账已确认 D1–D8 与 C01–C08 为实施契约；原 .tmp 设计如有冲突以本台账为准
- 等待 H03 相关缺陷回报，确认实际 Main 基线及共享文件 Owner 后，准备 H05 单消费者实施指令
- H05 编码、真实外写、数据库迁移、提交与集成须按独立授权执行，不因本次记录决策自动开始

## H05 · 持久审批首个消费者的前后端实施

状态：MERGED_PENDING_ACCEPTANCE；实现 IMPLEMENTED，Main 集成 MERGED，真实 Notion 与 Electron 验收 PENDING。

Feature：HARNESS-PERSISTENT-APPROVAL；提交：d1e4bf85。

范围：

- 仅 notion_create_page / notion_append_content / notion_update_record；提案业务授权、transcript 显示与 HarnessTask 执行分离
- 决定 CAS 与任务创建同事务，VERIFY→DISPATCH→SETTLE，后台恢复、过期、撤回、人工核对与诚实回执
- 备份 v10 保留提案证据，清空运行时任务链接，不自动重放；来源硬删 SetNull

修复：

- 逐提案/逐操作去重；核对不能绕过存活任务
- 备份恢复后的 unverified 人工核对与新提案闭环
- 真实 regenerate admission 守卫与拒绝提案可重生成对照
- 卡片换提案、失败提示及终态后重提案恢复轮询
- 尚未发布的 migration 重建父表时保留历史事件

证据：

- INTEGRATION_OWNER_EXECUTED：14 个定向 Vitest 文件 170/170（隔离 SQLite/受控 MCP/jsdom），包括升级前已有任务事件保留、备份 round-trip、regenerate admission、H01/H02 回归；launcher node:test 14/14。全部改动 TS/TSX ESLint 和排除临时目录的全部源码/测试类型检查通过。提交 d1e4bf85 / 6c551703。

边界：

- 未运行真实 Notion、真实模型、Windows Electron、生产 Build 或完整 E2E；passes=false
- 不承诺外部副作用恰好一次；不确定结果禁止自动重发
- 真实数据库未应用本次 Migration；Worktree 保留，未 Push

下一步：

- 按授权安排真实服务与 Windows Electron 定向验收，不自动执行下一阶段

## H06 · 用户显式开启的自动唤醒与有界推进

**状态**：明确后置，不自动开工。**责任角色**：待指定。
**依赖**：H03、H05。**Feature 映射**：未登记独立对应项，不能视为已有 MVP Feature。

本阶段范围：

- 后续按明确目标及用户设置进行到期唤醒
- 具备持久审批、费用/步数预算、失败退避、唤醒去重、暂停与可观察执行历史

未覆盖与限制：

- 当前后置，未授权设计实施
- 每 tick 一个任务不是费用预算，也不等于可靠调度
- 应用关闭期间不承诺本机 Agent 继续运行；若扩展宿主需另行设计授权

下一步：

- 持久审批和相关恢复/预算契约稳定后再评估，不自动开工

## 并行、授权与待确认事项

- 用户已明确授权本轮修复、提交及集成；没有授权 Push、真实数据迁移或删除 Worktree。
- H03 验收窗口已报告完成并释放进程；本轮不启动重型构建或 Electron。
- Main Prisma client 曾于 2026-11-16 20:17:20 被 H05 generate 写入；本轮未再次 generate，已确认其 schema 与 H05 源码忽略空白和注释后相同。原验收产物按验收 Owner 报告记录，不追认其未证实的生成物来源。
- 本轮首个普通 tsc 被 4GB 堆限制终止；随后通过隔离配置排除忽略的临时目录，检查全部 src、__tests__ 和根 TS 配置文件通过，不将失败尝试算作通过。
- 定向回归与静态检查不替代真实模型、Notion 或 Windows Electron 验收。
- 旧任务 Worktree 和原始未跟踪提案文档保留；H04 原稿仍为被忽略的设计参考，合同冲突以 D1–D8/C01–C08 为准。

## 明确不做

- 直接实施原 AGENT_LONG_TASK_HARNESS_PROPOSAL.md 的完整架构
- 一切皆插件、全量会话事件溯源、强制每次新建聊天上下文
- 全局工作流/任务/审批中心、多 Agent 或独立模型 evaluator 全家桶
- 自动投递、邮件/Notion 等新增自主外部写入
- 将本台账的阶段 ID 当成已登记的 MVP Feature 或设置 passes:true

## 维护方式

- MD 与 JSON 同次更新；阶段 ID 保持稳定，状态变化附证据来源和适用版本
- 执行指令已准备不等于 Agent 已启动；收到可核实状态后再更新
- 复用报告标明 REPORT；亲自执行标明执行宿主与范围，不能累加重复测试数
- 本台账不替代 MVP_FEATURES.json；只有既定条件全部满足才能更新对应 passes
- 设计不自动授权实施；不因完成某阶段自动启动下一阶段

## 参考

- [原长任务方案（参考，未授权完整实施）](AGENT_LONG_TASK_HARNESS_PROPOSAL.md)
- [Feature 验收状态](MVP_FEATURES.json)
- [任务调度规则](../AGENTS_PROMPTS.md)
- [Windows Electron 验证边界](../desktop/E2E.md)
- [DeepSeek Harness 架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Anthropic 长任务实践](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)
