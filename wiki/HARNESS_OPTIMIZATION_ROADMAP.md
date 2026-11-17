# Vocatrya Harness 优化实施台账

记录日期：2026-11-17（Asia/Shanghai）。本次只读核对基线：`main@da519f93`；历史验收基线仍为 `992feb9e`，不将旧证据追认为当前版本验收。
配套机器可读文件：[HARNESS_OPTIMIZATION_ROADMAP.json](HARNESS_OPTIMIZATION_ROADMAP.json)。

本文记录已批准的增量路线、实际实现与剩余工作，不是新的执行授权。实现、集成、验收分开记账；本轮同步实现、集成与验收边界；最终决策合同仍保留如下。

## 框架定位与术语（2026-11-17 补充）

本文使用「Vocatrya Agent 运行与任务续做框架」（Vocatrya Agent Harness）作为说明名称，文件名和 H01–H06 ID 保持不变。框架覆盖 Agent 运行接入、可靠任务执行、上下文与续做、验证与评测。确定性状态机是应用任务的一种执行机制；现有事件记录、租约和周期发现不等于完整事件驱动或事件溯源架构，也不代表已建成通用长期记忆系统。

| 术语 | 本文含义 | 当前状态与目标的区别 |
| --- | --- | --- |
| **原生 Agent** | 目标为账号登录后，由官方运行时负责 Agent 循环、原生工具、上下文及原生会话 | 当前账号运行时主要仍作为受限文本生成器使用；账号已登录不代表已完成原生 Agent 适配 |
| **托管 Agent** | 用户自接 API 或 Vocatrya 托管 API，由 Vocatrya 管理循环、工具、上下文和恢复 | UI 归入「Vocatrya 托管 AI」；托管的是执行流程，不改变 API 的凭据、供应商或费用归属 |
| **共享业务机制** | Vocatrya 管理用户与角色权限、业务目标、材料引用、必要审批、结果及回执 | 两类 Agent 都应通过业务契约接入；现有能力只在已经实现和验证的消费者范围内成立 |

本文新增内容是文档层的职责划分和升级方向，未实施、未验收。以下标注「后续建议」的细化设计尚待实施前确认，不能解释为整套方案已批准编码；H04 的 D1–D8/C01–C08 继续保持原合同范围。

## 当前结论

- 常规设置的聊天记录与 Agent 偏好已实现并保存到 Main，桌面验收由指定窗口执行；详见下文“常规设置与对话偏好实施”。AI 服务双 Tab 已以 `62ff16e1` 集成，任务卡与原生 Agent 改造仍未完成。
- H01/H02 已集成；验收报告已回收，真实模型仍 BLOCKED，passes=false。
- H03 执行已结束：Electron fresh-native + 合成上游；面试练习部分在 Web 完成，不能称桌面完整闭环通过。
- H05 已实施并集成，提交 d1e4bf85；本轮收尾修复提交 6c551703。2026-11-17 验收：Electron 机制 14/14（合成凭据 fail-closed）+ Web 宿主真实 DeepSeek/真实 Notion（create/append 远端写入核验通过）；update_record 缺前置库 BLOCKED，passes=false。
- 专用本地准备路由保留同一 InterviewSession；通用面试入口仍保留迁移提示。新路由尚待 Electron 定向复验。
- H04 的 D1–D8/C01–C08 合同不变，H06 仍后置；原 AGENT_LONG_TASK_HARNESS_PROPOSAL.md 随 Wiki 文档提交，仅作参考，不授权完整实施。
- 双路径目标已确认：原生 Agent 由官方运行时执行，托管 Agent 由 Vocatrya 执行，共享业务机制；原生适配尚未完成，具体升级项见“架构与约束”，不改变既有通过状态。

<a id="ai-service-execution"></a>

## AI 服务双路径与设置 UI（2026-11-17 用户确认）

本节是 AI 服务分类与执行分工的统一决策来源，由扩展文档原 §7 迁入；其 CraftStation 源码参考及当前差异保留如下。设置双 Tab 已实现并集成；原生执行路径尚未完成，不计入 H01–H06 的既有完成状态。

### 已确认的两档分类

| 设置 UI 分组 | Agent 类型 | 包含服务 | 前台 Agent 执行方式 |
| --- | --- | --- | --- |
| Agent 账号登录 | 原生 Agent（目标形态） | 通过官方 Agent 账号／订阅登录的服务 | 优先由对应官方运行时执行 Agent 循环，保留经验证支持的原生搜索、工具、上下文与会话能力 |
| Vocatrya 托管 AI | 托管 Agent | 用户自行连接的各种模型 API，以及 Vocatrya 提供的托管 API | 由 Vocatrya 管理 Agent 循环、工具调用、上下文和联网能力 |

“Vocatrya 托管 AI”中的托管指执行流程由应用管理；用户自接 API 的服务提供方、凭据及费用归属不因此变为 Vocatrya。账号订阅也不等于厂商网页聊天产品的全部功能可用。

### UI 要求与边界

- AI 服务页面顶部使用双切换 Tab：「Agent 账号登录｜Vocatrya 托管 AI」，不采用上下两组布局。自带 API 与 Vocatrya 托管 API 作为第二个 Tab 中的不同连接来源，不再与账号登录混成平级列表。
- 服务列表、添加连接和连接详情统一使用该分类，明确账号／API 来源、连接状态、模型和实际可用能力；不支持或未验证的搜索／工具明确显示。
- 复用现有连接记录与业务用途分配，不要求用户因 UI 重组重新配置；实际需要重新授权或迁移时须明确说明。
- 扩展工具继续管理 MCP／连接与 Skills；按所选执行路径加载并展示会话实际可用能力，统一遵循本节规则。第三方 Skill 导入仍为「敬请期待」。

### 设置双 Tab 实施与集成（2026-11-17）

`62ff16e1` 已集成 Main：顶部为「Agent 账号登录｜Vocatrya 托管 AI」。第二个 Tab 分为「自行接入的模型 API」与「Vocatrya 托管 API」，明确自接 API 费用由服务商收取。两面板保持挂载，以 `hidden` 切换可见性，连接控制器保持单实例；组件检查覆盖切换及状态保留、键盘方向键/Home/End、槽位路由和中英文案。

主协调复核：6 个相关组件测试文件 56/56 通过，定向 TypeScript 与 ESLint、`git diff --check` 通过。证据：`.worktrees/ai-services-tabs/.tmp/integration-verify/`。未进行 Windows Electron、真实桌面 OAuth、窄窗口视觉及真实浏览器键盘顺序验收；不将设置分组视为原生 Agent、原生搜索或会话恢复已适配。

### CraftStation 源码参考

本轮只读核对上游提交 `05e25f09fff38c5cf3b2a227ec44168ad4fce598`。以下是代码结构观察，未运行 CraftStation，不代表已验证所有厂商的真实能力：

| 参考实现 | 观察 | 对 Vocatrya 的启示 |
| --- | --- | --- |
| [Codex 原生适配器](https://github.com/HernanJiang/CraftStation/blob/05e25f09fff38c5cf3b2a227ec44168ad4fce598/src/supervisor/runtime/nativeCodex/nativeCodexRuntimeAdapter.ts) | 通过 app-server 管理会话／回合，将所选 MCP 转为运行时配置，支持以原生 skill 输入携带技能 | 由官方运行时执行循环，应用接入自身业务工具 |
| [Codex 事件映射](https://github.com/HernanJiang/CraftStation/blob/05e25f09fff38c5cf3b2a227ec44168ad4fce598/src/supervisor/runtime/nativeCodex/eventMapping.ts) | 区分 webSearch、MCP、动态工具和其他事件 | 搜索调用应成为可观察事件，不能只取最终文本 |
| [Claude SDK 会话](https://github.com/HernanJiang/CraftStation/blob/05e25f09fff38c5cf3b2a227ec44168ad4fce598/src/supervisor/agents/claude/sdkSession.ts) | 使用 claude_code preset、会话恢复、MCP 配置及 canUseTool 回调，保留原生工具运行路径 | 接收实际工具调用与批准请求，避免将 Claude 仅作为空工具文本生成器 |
| [原生事件归一化](https://github.com/HernanJiang/CraftStation/blob/05e25f09fff38c5cf3b2a227ec44168ad4fce598/src/supervisor/runtime/nativeHarness/nativeEventCanonicalizer.ts) | 把不同运行时的工具调用、结果、权限及用户输入事件转为统一事件 | UI 和持久化消费统一事件，厂商差异留在适配器 |

CraftStation 某些路径允许加载 user／project／local 配置或选择 Full access；这不是 Vocatrya 自动导入本机配置或开放全部权限的依据。首版第三方 Skill 导入仍为「敬请期待」。

### Vocatrya 当前差异（静态核查）

- `src/lib/agent/accountTurn.ts` 通过提示词要求运行时只输出路由 JSON、不要自行调用工具，业务工具由 Vocatrya 循环执行。
- `desktop/main/runtime/execute-server.js` 只接受 `TEXT_ONLY` 权限范围。Claude 使用空工具列表，Grok 显式禁用搜索，OpenCode 使用 deny-all 工具权限。
- Codex 已使用 app-server，但 `codex-persistent-runtime.js` 复用的是进程，每个应用回合创建新的原生 thread；`streaming.js` 主要提取 assistant 文本，尚无完整搜索／工具事件及来源接线。没有显式搜索模式，不应将 read-only 沙箱等同于禁用搜索，也不能宣称原生搜索已实测通过。
- 应用 Agent 注册表没有通用搜索／网页读取工具；现有 ATS 采集是专用招聘源检索，不能替代通用搜索。

### 建议落地方式

**原生 Agent** 的前台对话采用原生会话适配路径，由官方运行时负责其支持的执行循环、搜索、上下文及工具；**托管 Agent** 继续使用应用现有循环，并按需提供搜索工具。简历解析、结构化输出、摘要等后台用途继续保留受限文本调用，不能全局取消 `TEXT_ONLY` 边界。

1. **原生会话与能力**：首批按 CraftStation 适配方式跑通 Codex 和 Devin，分别核对实际运行时版本、账号可用能力、搜索模式、会话恢复和取消。公共适配可复用，不据两者通过推定其他运行时通过。再按官方 SDK／协议逐个接入其他运行时，不按品牌承诺统一能力。不支持或未验证时明确显示。
2. **原生事件与来源**：统一接收搜索、工具调用、执行结果、批准、用户输入、错误和用量事件，持久化必要调用证据与来源；仅输出文字“已搜索”不能判定成功。
3. **Vocatrya 工具桥接**：通过运行时支持的动态工具或应用 MCP 桥暴露岗位、简历、计划和 Notion 等精选业务能力；继续走当前用户归属、角色白名单、敏感字段保护、批准、提案及回执链路，不直接开放 SQLite 或真实数据目录。
4. **Skills 与 MCP 投射**：把应用已启用且兼容的 MCP／内置 Skills 转为各运行时支持的配置或输入，显示本次会话实际加载状态；不因账号登录自动继承用户在其他软件配置的扩展。
5. **应用与原生会话关联**：维护应用会话和原生会话的对应关系，定义重开、失效、模型／账号切换时的恢复规则；与现有对话历史、摘要和预算机制协调，避免双重摘要和重复重放工具。具体合同实施前确认，不在本轮改写现有会话契约。

联网优先复用经验证可用的原生搜索，不能笼统承诺所有订阅都包含搜索或完全免费；普通 API 或原生不支持搜索的路径再评估补充搜索后端。页面操作、表单识别仍需浏览器工具，原生搜索不能替代浏览器，也不自动授权投递或外部写入。

本节的服务分类、执行分工与 UI 两档结构为已确认需求；适配细节仍需在实施时核对。当前未实施、未验收，不改变 H01–H06 状态，不自动授权编码、真实账号操作、提交或发布。原长任务完整提案仍为参考，不因本节获批。

### 实施与验收检查点

- 两档设置、添加连接、详情及业务用途分配的实际 UI 一致，用户自接 API 和托管 API 均在第二档；既有连接及分配仍可使用。
- 账号登录路径核验原生搜索／工具调用记录、来源、权限请求、取消、断线及会话重开恢复；未支持的能力不得冒充执行。
- 普通 API／托管 API 路径核验应用工具循环与搜索能力；后台文本任务继续保持受限调用，不因前台调整全局放开权限。
- 两条路径均核验用户／角色隔离、提案批准、回执及未知外部写入不自动重放；恢复历史不得重复执行已经完成的工具。
- Windows Electron 的实际用户路径及持久化用隔离环境按授权验证；静态代码或模拟事件通过不等于功能验收。具体实施与验收任务待调度，不新建重复阶段或降低既有条件。


<a id="interaction-decisions"></a>

## 续做、授权与异常交互的讨论结果（2026-11-17）

本节汇总新增用户决定和尚待确认的交互细节，仅登记文档。与旧的“重开后点击继续”建议不一致时，采用本节的用户消息触发规则；已确认 UI 位置与可见性见下文，整体实施批次仍待讨论。

### 中断后由用户消息触发续做（已确认）

重开应用或恢复会话时只加载历史、任务状态及必要恢复信息，不自动向模型发请求或生成回复；用户发送消息后才依据本次意图继续执行和回复，无需另点“继续”。状态恢复不是执行恢复；用户新消息可能改目标、提问或取消任务，不能机械重放原步骤。已派发的外部操作可能继续完成或结果未知，需先核验回执，不能因新消息重复派发。H06 自动唤醒仍后置，原有已批准任务的后台执行合同不因这条对话恢复规则被改写。

### 首版长任务状态与外部持久化（已确认方向）

目标是长对话中明确“目前做到哪里、每步目标是什么、凭什么完成”，中断后从最近持久化且核验有效的位置继续。岗位、简历版本和技能差距等成果落入实际业务记录；任务目标、步骤、依赖、状态和验收证据独立记录，不以模型聊天记忆或不断增长的单份 JSON 文档作为唯一依据。

建议复用 SQLite 及既有业务表／任务账本，大文件单独保存并记录引用；小型结构化 JSON 可用于受校验快照，不禁止其合理使用。关键步骤完成后即保存结果和检查点，不依赖结束前才生成交接便签。交接只携带必要引用、状态及下一步，恢复时核验归属、存在性、材料版本、内容完整性和步骤验收条件；不能保证只查数据库即可还原官方内部推理或未落地的生成过程。

### 三档授权（方向已确认，应用业务工具接线已实现）

| 模式 | 目标规则 |
| --- | --- |
| 请求审批 | 按工具策略将需要批准的动作交用户，不将所有读取都变为审批 |
| 帮我审批 | 按预设规则批准，不另设 AI 审批者。常规读取、分析、新增、生成草稿、保留版本的更新及可恢复归档自动执行；永久删除、清库、不可恢复覆盖及备份恢复覆盖请求用户同意。对外动作按已有明确预授权执行，超范围时请求同意 |
| 完全访问 | 对齐 Codex 的授权体验，不额外套用“帮我审批”的逐项确认；目标为在已授予资源范围内执行时不再逐项请求批准。不能绕过账号权限、用户归属、业务接口约束或自动解锁未交付工具 |

Codex 的 Full access 通常对应 `sandbox_mode = "danger-full-access"` 与 `approval_policy = "never"`；不能对 Vocatrya 所有运行时直接复制相同参数。业务操作通过受控工具完成，不把任意 SQL／删除数据库文件开放给模型。本次新会话“完全访问”作为应用业务写工具的明确预授权来源：Notion 新提案在冻结输入后，经原决定入口原子批准并创建执行任务，记录 `FULL_ACCESS_PREAUTHORIZED`；旧提案不因设置变化获自动批准。H04/H05 的回执、结果未知、去重和执行核验继续有效。该增量仅适用于应用业务工具，不解除原生运行时的 `TEXT_ONLY` 限制或声称原生 Full access 已接通。

### 执行期间关键材料变化（已确认方向）

用户修改任务关键数据时，应检测材料版本变化并弹窗请求处理；Agent 后续读取应获得最新状态，不继续把旧数据当作当前事实。受影响步骤不能在弹窗待处理时继续提交旧结果；不相关步骤可按依赖关系推进。无法推进的步骤记录为跳过或受阻，说明原因；依赖其结果的步骤同样不得冒充完成。原生 Agent 通过应用可观察事件及业务工具边界校验，不能假设一定能立即打断官方内部生成。

弹窗候选动作为“按最新材料继续／跳过受影响步骤／暂停任务”，具体按钮与关闭后行为待 UI 讨论。已产生的有效旧结果保留来源并标记过时，不擅自删除；已派发的外部请求不承诺可撤销，先查验真实结果。新材料下必要的批准应匹配新输入，不能沿用旧内容的批准。

### 上下文刷新：本机 Codex 核查与产品策略

2026-11-17 只读核对本机 `C:/Users/HP/.codex/config.toml` 及其引用的 `cc-switch-model-catalog.json`：模型为 `gpt-6.1-sol`，自定义目录声明上下文窗口 500000 tokens；未显式设置 `model_auto_compact_token_limit`、其 scope 或 `model_post_turn_compact_threshold_percent`，模型目录中的自动压缩阈值为空。npm 包版本为 0.169.0，不证明当前桌面宿主实际使用此版本或最终有效窗口／阈值。未读取或输出凭据，未修改配置。

官方配置说明指出，自动压缩阈值未配置时使用模型默认值；还可设置回合结束后的百分比触发。该机制是会话历史压缩，不等于固定 60%–70% 时强制销毁会话。产品建议：原生 Agent 优先采用官方压缩，应用持续保存业务状态；托管 Agent 按模型容量、实际输入估算与输出／交接预留量设置预算。压缩、交接和创建新会话分开处理，具体阈值仍待实现验证，不冻结统一比例。

参考：[Codex 配置](https://developers.openai.com/codex/config-reference/)、[Codex 沙箱与 Full access](https://learn.chatgpt.com/docs/sandboxing)。本机配置仅是本次设计参考，不自动复制到 Vocatrya 用户的运行时配置。

### 错误、通知与任务进度 UI（2026-11-17 已确认）

本节取代之前“右上角错误提示”和全局悬浮任务卡的建议。

| 内容 | 确认形式 | 行为边界 |
| --- | --- | --- |
| AI 服务 | 设置页面顶部双 Tab：Agent 账号登录／Vocatrya 托管 AI | 设置管理账号、API、模型与连接；扩展能力仍在扩展工具管理，不合并为一个管理页面 |
| 任务进度卡 | **仅在 Agent 执行窗口内部的右上角**，可展开／折叠 | 执行窗口关闭或收起后任务卡同时隐藏；其他业务页面无全局悬浮卡。再次打开加载该任务最新状态，显示状态不触发继续执行，仍由用户发消息后续做 |
| 错误提示 | 主内容区左上角，持续显示至用户关闭，提供详情／重试入口 | 不遮挡导航；关闭不清除会话／任务失败记录，不代表问题已解决，不静默切换服务 |
| 普通通知 | 窗口右下角，短暂显示 | 保存、连接成功等反馈；需要用户决定的审批和材料变更不使用会自动消失的通知代替 |

任务卡参考用户提供的进度清单：折叠态建议显示任务名、状态及完成数；展开态显示步骤、当前项、受阻／待审批原因、结果和验收证据。完成、执行中、待处理、受阻、跳过分别标识，跳过不计入完成。默认用用户可理解的目标与结果，脚本名、内部表名及调试信息置于详情；具体文案与视觉样式在实施时细化。关闭执行窗口是显示层行为，不应直接推断取消已派发任务或外部操作，任务执行生命周期按原合同处理。

字段校验错误仍贴近字段；任务错误在对应步骤保留状态。建议同类错误合并更新，恢复后原提示显示已恢复，避免重复叠加；数量上限、折叠方式及恢复后保留细节尚待细化。错误显示去除凭据等敏感信息，重试外部写入前先判断是否已派发或结果未知，不把重试直接等同于重新发送。

### 首轮交付范围与剩余 UI 细节（待讨论）

顶部双 Tab、窗口内任务卡、左上角错误和右下角通知已确认，不再列为未定。其中顶部双 Tab 已集成、待桌面验收，其余不因本次集成视为完成。授权模式选择入口、材料变更弹窗按钮及关闭后的行为、多任务选择、错误合并细节和首轮最终交付组合仍待细化。扩展工具的 MCP／Skills 分类形式尚未冻结，具体见扩展文档；不默认新增独立任务中心。

<a id="general-agent-preferences"></a>

## 常规设置与对话偏好实施（2026-11-17，已实现／待验收）

用户先授权在 Main 实施并更新 Wiki，随后要求本窗口收尾、提交确定内容。本次保存已完成实现和现有验收记录；常规设置尚待指定 Agent 定向验收，未追认为通过。实现基线为 `ef2850c8`，本次完整源码以包含本节的 Git 提交为准，不以基线代表实现版本。本次收尾未 Push、未生产构建、未启动 Electron、未调用真实模型／Notion，也未操作真实用户数据库。

| 设置项 | 实际实现 | 默认与生效范围 |
| --- | --- | --- |
| 自定义提示词 | 常规设置中的多行输入与实时字符计数，前后端最多 2000 个 Unicode 字符，超出拒绝保存，不静默截断 | 留空关闭；每次 Agent 对话请求读取当前配置，下一条消息生效；同时覆盖应用编排的账号、托管 API 和历史普通 API 路径，不注入后台摘要／解析。显示为个人偏好，不覆盖业务权限和角色规则 |
| 默认权限 | 常规设置三档选择，问号可悬停／聚焦／点击查看区别；输入区可在创建会话前改选 | 新会话默认“帮我审批”；创建时写入服务端会话上下文并固定，旧会话无模式字段仍“请求审批”。修改全局设置不改变既有会话和提案，备份恢复清除会话模式，恢复后回到请求审批 |
| 自动归档不活跃聊天 | 永不／30／90／180 天；独立维护器在应用后端启动后及每 5 分钟按用户配置处理 | 默认永不。跳过活跃请求、未完成审批、未决／结果未知外写，以及当前／历史／恢复来源职位关联的未完成任务和准备目标。遵守归档内容 AI 完全不可读合同，不自动恢复或删除聊天 |
| 压缩本地历史 | 对超过 7 天且无保护状态的历史按需 gzip，仅实际变小时编码；读取时解码，备份导出原始 JSON，归档搜索分页解码 | 默认关闭，开启后由维护器处理；关闭仅停止后续压缩。完整保留消息与工具内容，不是上下文摘要。保持活动时间，纯压缩不改变语义 revision；编码损坏不覆盖原记录 |

设置保存在 `UserSettings.settings.settings.general.agent`，通过现有原子 CAS patch 保存，不新增 Schema 或 Migration。常规偏好面板显式保存并显示成功／失败；加载失败不可保存默认值覆盖已有设置。后台维护按用户、材料关联、版本、锁及记录内容核对，分页游标跨轮保留，防止前 1000 条受保护记录长期阻塞后面的记录；不运行数据库 VACUUM，不承诺文件立即缩小或具体压缩比例。

**权限实际范围**：现有受支持业务工具中，“请求审批”沿用工具原批准规则；“帮我审批”自动放行 `add_job`、`match_job` 的本地结果写入，外部 Notion 写入仍请求批准；“完全访问”对该本地工具和本次新建的 Notion 提案不逐项打断，仍走真实提案、任务与回执。自动批准后的流只显示真实排队结果 `saved:false`，不显示要求用户确认的卡片，也不冒充远端成功。用户／角色／连接授权及未知结果禁止重发继续生效；未注册的删除、投递、发邮件工具不会因权限模式出现。Codex／Devin 的完整原生循环与权限适配仍未实施，本节只接入当前应用循环。

**实现入口**：`AgentPreferencesSettings.tsx`、`agentPreferences.actions.ts`、`preferences.ts`／`preferences.server.ts`；对话创建／输入权限选择、chat route／工具注册／请求提交接线；`historyCodec.ts`／`historyMaintenance.ts` 及 instrumentation；聊天读取、归档可见性／搜索、摘要读取和备份导出／恢复兼容。

**实际开发验证**：23 个相关定向测试文件共 393 项通过（相同套件后续修正复跑不重复累计），包括新增偏好／编码／隔离 SQLite 用例、常规设置、对话 UI／路由／循环、摘要、并发、持久审批、归档与备份。隔离 SQLite 覆盖压缩后重开、发送、搜索、导出原文；真实 export→import 覆盖压缩内容无损与恢复后 Full access 失效；模式对比验证仅持久化 full 才原子批准外部提案，且未派发远端请求；维护覆盖保护状态、历史关联及超 1000 条跨轮推进。限定源码／测试目录的类型检查、改动 TS/TSX ESLint 与 Git 差异检查均通过，日志位于 `.tmp/agent-general-settings/`（不随 Git 同步）。只读审查发现的维护遗漏已修复并复核，无剩余重要项；审查不替代验收。

**待指定验收者执行**：Windows Electron / fresh-native 的实际设置、提示词与权限行为，真实账号／模型和专用 Notion 目标下的受控路径；定向核对退出重开、偏好保存、自动归档与历史可读、悬停帮助、窄窗口和错误状态。当前未运行桌面或真实模型验收，`passes` 保持 false，不更新既有 H01–H06 通过状态。定向验收指令已在本聊天交付，但尚未收到执行结果；本次只提交实现与已知证据，不新增完整 E2E 或验收报告。

## 架构与约束

- **模型接入**：当前实现仍主要由 Vocatrya 编排；已确认目标为账号登录优先原生 Agent 执行，普通 API／Vocatrya 托管 API 由应用编排。业务权限和结果合同始终由 Vocatrya 管理，具体见“AI 服务双路径与设置 UI”。
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

### 原生 Agent、托管 Agent 与共享机制的职责

下表描述目标分工，不代表所有能力当前可用。原生 Agent 的适配尚待实施；H01–H06 的历史证据不能直接沿用为原生路径证据。

| 能力 | 原生 Agent | 托管 Agent | Vocatrya 共享业务机制 |
| --- | --- | --- | --- |
| Agent 循环与模型调用 | 官方运行时负责 | Vocatrya 应用循环负责 | 固定业务用途、连接归属和必要执行身份 |
| 搜索与工具 | 优先原生工具；经动态工具／MCP 桥调用应用业务工具 | 应用注册和执行工具，按需接入搜索后端 | 中立的业务输入／输出契约、权限、提案及结果 |
| 上下文与压缩 | 优先原生会话管理，注入必要业务上下文 | 应用管理历史、摘要、预算和工具结果 | 经过归属与有效性核验的业务引用、材料版本和进度 |
| 恢复与续做 | 在官方接口支持范围内恢复原生会话；失效时重新装配已核验业务状态 | 从应用历史、任务检查点和业务结果恢复 | 核验业务已完成什么、材料是否变更、授权是否仍有效 |
| 批准与回执 | 原生权限请求适配到应用；调用业务写工具仍经过业务批准 | 在应用工具执行路径执行对应批准策略 | 持久提案、执行状态与结果未知处理；不是所有操作均须批准 |
| 事件与观察 | 映射实际原生搜索、工具、权限、错误及用量事件 | 应用循环产生相同语义的事件 | UI 与审批层消费统一契约；事件展示不取代业务结果事实 |

不在原生 Agent 外再套一层负责重复选工具的应用循环。Vocatrya 的检查点只能描述应用任务及业务结果，不能恢复原生 Agent 内部的任意推理步骤；原生会话引用也不等于应用具备完整的运行时历史重建能力。

同一业务工具应维护一份中立契约和业务执行入口，分别提供原生 Agent 的 MCP／动态工具适配及托管 Agent 的本地工具适配。两条路径共享业务执行和权限检查，不要求原生内部工具与应用工具一一对应，也不引入全量事件存储平台。原生的批准回调与业务批准须核对同一目标和冻结输入，避免不必要的重复批准；任何一侧的允许都不能绕过另一侧的有效限制。

### H01–H06 的适用范围

现有实现由 Vocatrya 管理任务／业务流程，账号运行时在其中提供模型生成能力；这不等同于已经运行完整原生 Agent。H01–H06 也不是一套所有托管 Agent 自动具备的通用功能，只覆盖所列消费者。

| 阶段 | 现有覆盖 | 原生 Agent 接入时的边界 |
| --- | --- | --- |
| H01 · 可恢复深度匹配 | 应用编排的专项任务、固定材料、检查点及结果绑定 | 可通过业务工具调用现有匹配任务；不能把 RUN_ANALYSIS 检查点当作原生内部步骤 |
| H02 · 业务进度记忆与续做 | 面试准备目标及问答／反馈／总结的确定性交接 | 复用目标与实际结果，另行维护原生会话关联；尚无通用跨会话记忆 |
| H03 · 恢复与续做验收 | 已有消费者的历史 Electron／Web 与夹具证据 | 原生搜索、权限、会话恢复需新增对应证据；不沿用旧报告判通过 |
| H04 · 持久审批合同 | 三个 Notion 写工具的 D1–D8/C01–C08 | 作为该业务范围的共同约束，适配原生请求；不自动扩大工具范围 |
| H05 · 持久审批执行 | 现有 Notion 提案、批准、后台执行和回执 | 补原生工具桥与事件关联后才能声明接通；代码已集成不等于两路径验收完成 |
| H06 · 自动唤醒与有界推进 | 后置、未实施 | 两类 Agent 分别核对宿主、恢复、预算与取消能力；不承诺关闭应用后继续运行 |

### 上下文、业务进度与恢复核验（升级方向）

将以下信息分开管理，不依赖模型摘要维护实体身份或授权：

- **业务引用**：岗位、简历版本、目标等结构化指针，由程序核验用户归属、权限、归档／删除状态和材料版本；`HandoffContext` 可作为后续设计名称，不代表已存在的接口。
- **执行进度**：已完成步骤、有效产物、待办、批准及回执，以实际任务与业务记录为准；历史叙述不能自行产生完成或批准状态。
- **对话摘要**：目标、偏好、约束和讨论背景的压缩辅助材料，允许过时、失效和重新生成；保持来源／覆盖边界，不把摘要视为业务事实库。

**托管 Agent**：当前 `contextBudget.ts` 默认装配预算 16k，预算不足优先移除摘要。后续按内容有效性、近期用户更正和任务相关性优化装配顺序，不机械地永久保留摘要。结构化业务引用应独立保存，不要求删除摘要中禁止数据库 ID 的现有约束。

**原生 Agent**：优先原生上下文压缩与会话恢复，Vocatrya 补充核验后的业务引用和任务进度，不重复强加托管 Agent 的 16k 裁剪或双重摘要。原生会话失效时，从已核验业务状态重新开始并说明边界，不凭文本重放外部操作。

**共享恢复核验**：装配被引用的历史材料前，按实际引用只读核验并刷新名称／版本或标记失效。缺失、归档或无权限时按既有合同排除、说明或要求重新选择，不能悄悄绑定同名对象。恢复前查询不取代执行前再次校验，也不默认对每轮对话做全库扫描。

### 后续升级建议与证据边界

以下吸收讨论中的建议，作为后续设计清单，不新增 H05.1 等阶段，不修改既有验收条件。建议顺序为：双路径业务契约 → 结构化上下文与恢复核验 → 按消费者扩展持久执行；评测随相应能力补充。H06 继续后置。

| 建议 | 原生 Agent | 托管 Agent | 共享要求／采用条件 |
| --- | --- | --- | --- |
| 统一工具契约与事件 | 官方协议／SDK 的工具桥和事件映射 | 本地工具与应用循环事件 | 同一业务执行与批准合同；优先推进 |
| 提案依据快照 | 在原生协议实际可提供范围内记录模型／运行时和来源 | 记录应用可知的提示词版本／哈希与材料来源 | 用户可见的简短建议依据与来源引用；不收集内部推理，不将解释或哈希当作因果证明或可重放证据 |
| 结构化交接与恢复核验 | 原生会话关联，加业务状态核验 | 优化上下文装配与结构化指针 | 区分业务引用、进度与摘要；按实际引用查询 |
| 核心操作的持久执行／审批 | 调用同一业务任务与适用提案 | 按实际消费者迁移易失执行 | 持久执行、人工批准、结果核验分别设计。review_resume 当前不需批准，add_job 为条件批准；不全面强制审批，也不改本期 Notion 合同 |
| 细粒度子检查点 | 不尝试截取官方内部推理；仅对应用拥有的独立步骤记录 | 在多次独立调用、重算代价较高时拆分 | 中间产物绑定材料、模型／提示词和契约版本；来源变化则失效。单次生成流不是可恢复子步骤 |
| 模型样本离线回放 | 对绑定运行时／协议版本的脱敏工具与事件样本回归 | 对脱敏响应、解析和状态转换回归 | 新样本须合法获得并去除凭据、个人信息；合成与真实录制明确区分，不默认录制全部聊天 |
| 事实保真评测 | 对原生输出做相同业务事实核验 | 对应用生成结果核验 | 公司、日期、数字与个人贡献须有来源；允许别名与合理改写。建议、问题、假设与声称已发生的个人事实分开，不对所有词语机械套闭集 |

评测分四类分别记录：协议／状态机回放、任务输出质量、当前账号／服务在线验证、Windows Electron 用户路径验证。离线回放通过不能证明当前网络、授权、额度或真实模型行为可用，不能因此解除真实模型 BLOCKED 或设置 passes=true；模型质量评测也不等于事实可由简单字符串断言完整证明。

## 阶段总览

| 阶段 | 内容 | 当前状态 | 后续 |
| --- | --- | --- | --- |
| H01 | 可恢复深度匹配与轻量追溯 | MERGED_PENDING_ACCEPTANCE / DESKTOP_FIXTURE_PASS_REAL_MODEL_BLOCKED | 配置可用授权连接后补真实模型冒烟，不重复已有效的夹具验收 |
| H02 | 面试准备目标、确定性交接与用户主动续做 | MERGED_PENDING_ACCEPTANCE / PARTIAL_PASS_DESKTOP_ROUTE_RETEST_PENDING | 定向复验新的桌面准备路由与同一会话续做；有授权连接后补真实模型冒烟 |
| H03 | 两项已集成功能的集中 Windows Electron 定向验收 | COMPLETED_WITH_BLOCKERS / PARTIAL_BLOCKED | 只复验修复涉及的构建入口和桌面准备导航，不重跑完整历史链路；真实模型等待可用连接 |
| H04 | 持久审批的只读调研与最小实施契约 | DESIGN_DECISIONS_APPROVED / NOT_APPLICABLE | 已批准 D1–D8/C01–C08 作为 H05 合同；实施与集成见 H05 |
| H05 | 持久审批首个消费者的前后端实施 | MERGED_PENDING_ACCEPTANCE / PARTIAL_PASS_UPDATE_RECORD_BLOCKED | 授权父页下建「投递记录」库后补验 update_record；由验收 Owner 判断是否补 Electron+真实写入合并验证 |
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

**状态**：设计已完成且合同已批准；H05 后续实施与集成见对应阶段。**责任角色**：设计已完成；实施及收尾已由 Main 集成 Owner 完成，见 H05。
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
- `USER_EXPLICIT_DECISION`：用户明确同意采用助手最终推荐并写入 wiki；D6/D7 覆盖原稿相反推荐，补充 queued receipt、dispatch 前过期、恢复快照歧义、硬删/重新生成/归档/孤儿 part 不变量。设计确认当时未授权 H05 编码；后续已另获授权并实施，见 H05。

未覆盖与限制：

- 仅设计，不改源码/Schema/Migration/wiki，不调用真实模型或外部写接口
- 不启动 Electron、Next 服务、Build 或 E2E
- 不得修改原始未跟踪方案文档

设计原稿：`.tmp/persistent-approval-design/design.md`（已核实存在且被 git-ignore，不随 Git 同步）。
原稿基线：`992feb9e`；交付时核对 SHA-256：`9c80dd4af5661cc4c473b04b52e8d6a778d20742ddea1b9bad790adbcdfbeafc`。

**决议优先级**：用户已确认下列最终裁定。原稿保留初稿，遇到 D6、D7 等冲突以本台账为准；设计确认当时未修改原稿、未授权产品编码；后续 H05 已另获授权并完成集成。

已确认设计范围（实现及集成已完成，见 H05；以下保留设计合同）：

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

状态：MERGED_PENDING_ACCEPTANCE；实现 IMPLEMENTED，Main 集成 MERGED；验收 PARTIAL_PASS_UPDATE_RECORD_BLOCKED。

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
- ACCEPTANCE_OWNER_REPORT（2026-11-17）：Windows Electron fresh-native，da519f93 产品等价基线、复用经核验 A 轮产物；持久审批 14/14 步骤 PASS（提案卡、唯一任务、queued≠成功、退出重开恢复、UNCERTAIN 零重发+人工核对+重提案、撤回/过期、归档恢复后批准、孤儿 reconcile、硬删 SetNull、备份带证据不带运行时）。合成凭据在 loadTokenBundle fail-closed→REAUTH_REQUIRED，无远端字节。证据 `F:\vocatrya-acceptance-runs\b2077725-d76f-413e-8961-a8633d0bf4ed`。
- TASK_B_OWNER_REPORT（2026-11-17）：Web/Next dev（`.worktrees/h05-notion-verify` @ ef2850c8，隔离库+独立密钥）；真实 DeepSeek deepseek-chat（用户自填 key，pilot）+ 真实 Notion OAuth（vocatrya workspace，授权父页 `4181f78077f08090be9fd95feb2b9589` 子树）。create_page 全生命周期、append_content 远程读回、拒绝/撤回、刷新与重启恢复、过期、killwatch 崩溃×4→UNCERTAIN 零重发+人工核对+supersedesId 链、会话硬删 SetNull、备份 v10 恢复 38 提案零重放、断开/撤销均 PASS；重复批准幂等零新任务。update_record BLOCKED（无前置库）；Electron 宿主 NOT_RUN。证据 worktree 内 `.tmp/h05-notion-verify/`。

边界：

- notion_update_record 真实目标未覆盖（授权父页下无数据库行）；passes=false
- 真实远端写入证据来自 Web dev 宿主；Electron 侧机制以合成凭据验证，桌面+真实写入未在同一 run 覆盖
- 不承诺外部副作用恰好一次；不确定结果禁止自动重发
- 真实数据库未应用本次 Migration；Worktree 保留，未 Push

下一步：

- 授权父页下补建「投递记录」库后复验 update_record（需重新 OAuth consent）
- 由验收 Owner 判断是否需补 Electron+真实 Notion 合并定向验证；不自动执行下一阶段

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

- 历史 H05 修复与集成轮次曾获用户明确授权修复、提交及集成；没有授权 Push、真实数据迁移或删除 Worktree。该历史授权不延伸至本次双路径升级，本次仅更新文档。
- H03 验收窗口已报告完成并释放进程；本轮不启动重型构建或 Electron。
- Main Prisma client 曾于 2026-11-16 20:17:20 被 H05 generate 写入；本轮未再次 generate，已确认其 schema 与 H05 源码忽略空白和注释后相同。原验收产物按验收 Owner 报告记录，不追认其未证实的生成物来源。
- 本轮首个普通 tsc 被 4GB 堆限制终止；随后通过隔离配置排除忽略的临时目录，检查全部 src、__tests__ 和根 TS 配置文件通过，不将失败尝试算作通过。
- 定向回归与静态检查不替代真实模型、Notion 或 Windows Electron 验收。
- 旧任务 Worktree 保留；原始长任务提案本次随 Wiki 提交，仅作参考。H04 原稿仍为被忽略的设计参考，合同冲突以 D1–D8/C01–C08 为准。

## 2026-11-17 核对与可并行任务

- 本次只读核对 main@da519f93：H01/H02/H05 的五个实现及修复提交均为当前 HEAD 的祖先；相关实现、Schema 和 Migration 存在。三个 Feature 均为 IMPLEMENTED、passes=false。本次未重跑测试、Build、Electron 或真实服务验收。
- 原验收目录仍存在；既有测试数字及验收结论继续标记为历史报告，不宣称本次已复核全部原始证据。
- H04 是已完成的设计阶段，其 NOT_STARTED 实现字段为旧阶段口径，现改为 NOT_APPLICABLE；产品实施由 H05 记账，不重复列为待编码。
- 建议任务 A：H01/H02 集中定向补验。唯一桌面重型执行者在隔离快照和 fresh-native 数据中补验修复后的构建入口、面试准备本地路由、退出重开后同一会话续做；可用授权连接下补真实模型冒烟。复用已有有效夹具证据，不重跑完整历史链路。
- 可并行任务 B：H05 持久审批验收。另一 Owner 在独立 Worktree/隔离数据库中验证真实服务侧的提案、批准、后台执行与远程回执，不确定结果不自动重发；需要有效授权连接及明确的测试 Notion 目标/外写授权。其 Electron 部分排在 A 释放资源后，由唯一指定桌面执行者执行。
- A/B 可并行的是不同业务链路的验证；不得同时生产构建、装配或执行 Windows Electron E2E。各自只修本功能缺陷，共享 Harness/认证/启动入口问题交单一 Owner；共享 wiki 状态由 Main 集成 Owner 汇总。开始前核对 Worktree 当前 Diff 与进程归属，不复用旧分支作为最新集成版本。
- 上述是调度建议，未派发或启动；本次文档更新不增加真实外写、重型验证、提交或清理授权。H06 继续后置，不作为当前并行开发项。

## 2026-11-17 A/B 执行结果汇总

本次收尾保留 A/B Owner 的分宿主报告及既有证据位置；已核对对应证据目录存在，未重演或逐项复核其全部原始证据。H05 的这些报告不覆盖常规设置新增的 Full access 预授权路径，该路径仍需单独验收。

- 任务 A（h01h02-retest，桌面重型执行者）报告完成：除 H01/H02 补验外，复用经核验产物对 H05 做了 Electron 机制验收 14/14 PASS（合成凭据 fail-closed 边界，真实远端写入未覆盖）；进程已清理。H01/H02 补验结果尚未汇入台账，待该窗口报告后更新对应阶段。
- 任务 B（h05-notion-verify，devin/swe-2-max 独立窗口）报告完成：Web dev 宿主 + 真实 DeepSeek + 真实 Notion OAuth（vocatrya workspace 授权父页子树）；用户授权的外写范围内 create_page/append_content 经远程读回核验通过，提案-批准-后台执行-恢复-备份-断开全链路 PASS；update_record 因授权父页下无数据库 BLOCKED，Electron 宿主按约定未执行。worktree 保留全部证据。
- H05 合并结论：机制（Electron，合成凭据）与真实远端写入（Web，2/3 工具）已分别验证；严格合并路径（Electron+真实写入同一 run）与 update_record 未覆盖，passes=false 保持。

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


### 2026-11-17 update_record 补验核验

2026-11-17 update_record补验核验：Web dev隔离库、真实DeepSeek deepseek-chat、真实Notion MCP，在原授权父页子树专用投递记录库完成记录更新。主协调核对原始提案/任务事件及远端前后读回：6dc95f86→6aa88fcf为APPROVED/SUCCEEDED且saved:true，职位/状态/备注改变、公司不变；eb5888a0为REJECTED且无任务/dispatch、远端未改；不存在目标f6d42365→2e447618为FAILED/saved:false并保留远端404 object_not_found（此负向经应用提案/批准函数驱动，不是模型UI成功路径）。56/56定向测试独立复跑通过。产品源码零修改；原始证据 .worktrees/notion-update-record/.tmp/notion-update-record/。OAuth listener旧timer、错误定码粒度及审批队列409为执行窗口观察，未独立复现根因、不在本次修复。Windows Electron+真实写入合并路径未覆盖，passes:false保持。

以上增量解除历史 update_record 无测试库的前置阻塞；历史轮次的记录保留，不追认 Electron 与真实写入已在同一 run 覆盖。
