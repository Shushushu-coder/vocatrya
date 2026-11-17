# 原生会话适配最小合同（提案）

状态：**提案。尚未批准，尚未实施。** 本文不修改产品源码、Schema、Migration、共享台账或已冻结合同。批准前不能把它当成编码授权，也不能把其中的目标能力写成已经可用。

记录日期：2026-11-17。提案分支 `codex/native-session-contract`，基线 `main@071f48e0`。只读上下文还包括 Main 工作区当时的扩展与Harness文档（其中 `wiki/EXTENSIONS_IMPLEMENTATION.md`、`wiki/EXTENSIONS_FEATURES.json` 尚未提交）；那些修改不属于本分支。

配套内容见 [简历证据深挖提案](./RESUME_EVIDENCE_SKILL_CONTRACT_PROPOSAL.md)，由另一个窗口负责追问流程、结果结构和示例。本文只定义运行时接收技能的最小接口。两边出现差异时列在文末，由协调窗口统一，不互改文件。

## 0. 已核实的边界

账号登录成功只说明对应连接完成了 `ACCOUNT_LOGIN` 认证。它不代表原生 Agent 循环、搜索、工具、会话恢复或业务写入已经接通。H01–H05 的实现和证据属于应用编排路径，不能挪作原生适配证据。

本轮没有登录真实账号，没有调用付费模型，没有执行远端写入，也没有运行生产构建、Electron 或完整 E2E。能力标记只有三种：

| 标记 | 含义 |
| --- | --- |
| 已核实 | 当前基线源码已经这样做，或官方资料明确记载且本文注明了适用边界 |
| 未支持 | 当前产品路径没有该能力；官方资料是否另有接口分开记录 |
| 待核实 | 官方资料或源码注释提到，但未在本仓库已集成版本上证实 |

### Codex

产品基线（`desktop/main/runtime/`）：

- 已核实：账号路径使用隔离 `CODEX_HOME`。流式前台调用是 `codex app-server --listen stdio://`。`streaming.js` 每回合发送 `thread/start`，参数固定为 `ephemeral: true`、`approvalPolicy: "never"`、`sandbox: "read-only"`，然后 `turn/start` 只提交一段文本。
- 已核实：`codex-persistent-runtime.js` 复用的是 app-server **进程**。隔离键包含 user、connection、model、runtimeVersion 与配置指纹。`threadReuseHit` 恒为 `false`，注释写明每个 Vocatrya turn 新建 Codex thread。进程表在重启后清空。
- 已核实：解析器只把 `item/agentMessage/delta` 与 `agentMessage` 完成文本当作回答。服务端反向请求直接回 JSON-RPC `-32601`。`initialize` 设置 `experimentalApi: false`。没有搜索、工具、权限或用量事件接线。
- 已核实：`execute-server.js` 拒绝 `permissionScope !== "TEXT_ONLY"`。`codex exec --ephemeral -s read-only` 仍承担 smoke、结构化输出和后台文本。
- 已核实：流式行为的仓库记录停在 codex-cli **0.165.0**；命令帮助记录停在 **0.154.0**。本机 npm 包 0.169.0 只是路线图里的设计参考，不是桌面宿主已经采用的版本。

官方协议（2026-11-17 读取 [Codex app-server](https://developers.openai.com/codex/app-server/)；当前官方入口重定向至 [ChatGPT Learn app-server](https://learn.chatgpt.com/docs/app-server)。实现仓库为 [openai/codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server)。文档未给每个方法标注 CLI semver）：

- 已核实于文档、待核实于 0.165.0：`thread/resume` 按 thread id 续接；`thread/read` 只读不加载；`turn/interrupt` 成功后回合以 `interrupted` 结束；`item/started`、`item/completed` 覆盖工具与命令；审批通过服务端请求到达客户端。
- 已核实于文档、待核实于当前客户端：`dynamicTools` 属于 experimental，要求 `experimentalApi: true`，并在未重新提供时随 `thread/resume` 恢复。技能通过 `turn/start.input` 的 `type: "skill"` 携带 `name` 与 `path`。MCP 可由配置加载；把服务器标为 required 后，初始化失败会使 `thread/start` / `thread/resume` 失败。
- 已核实于 [Codex app features](https://developers.openai.com/codex/app/features)（原窗口于2026-11-17记录；该产品页面不作为Vocatrya协议能力证明）：Codex app 有第一方网页搜索，并会沿用 CLI/IDE 的 MCP 配置。该页描述的是 Codex 产品，不是 Vocatrya 托管配置。当前只读沙箱不能解释成“已经关闭搜索”，也不能解释成“搜索已在 Vocatrya 实测可用”。

### Devin

产品基线：

- 已核实：`DEVIN_RUNTIME` 只接受 “Logged in (via Devin)” 的账号会话。PAT、API key、service account 不能完成 `ACCOUNT_LOGIN`。
- 已核实：前台与后台都走 `devin -p`，提示词在 `--prompt-file`，模式为 `--permission-mode auto`。stdout 由纯文本解析器接收。仓库对流式的记录停在 **3000.10.31**。`--prompt-file` 的帮助还对照过 3000.11.228，这不代表宿主已切换到该版本。
- 已核实：Windows 上 `--sandbox` 需要 WSL，原生 Windows 拒绝启动。托管 `config.json` 关闭 auto-update、subagents，并拒绝 `agents_standard` 及其他应用配置导入。deny 列表包含 `exec`、`edit`、`mcp__*`、`Write(**)`、`Read(/**)`。
- 已核实：注册表把 `acp: true` 标成能力，源码注释写明 `devin acp` 的 `session/update` 仍是未验证后备。产品没有会话 id、resume 或事件映射。
- 待核实：源码注释称 print + auto 下 fetch 不会提示并被直接拒绝，但托管 deny 列表没有单独的 fetch 规则。因此不能把“Devin 已核实禁用联网”写成配置事实。

官方资料（2026-11-17 读取）：

- [Commands & Flags](https://docs.devin.ai/cli/reference/commands)（2026-11-17协调复核；不推定页面发布日期）：`--resume <SESSION_ID>`、`--continue`、`--print`、`devin acp`、`devin mcp`、`devin list --format json`。文档没有证明 `--print` 与 `--resume` 可以组合成带事件的跨回合协议。`--continue` 恢复的是当前目录最近会话。
- [Permissions](https://docs.devin.ai/cli/reference/permissions)（2026-11-17协调复核）：normal/auto、accept-edits、smart、dangerous/yolo/bypass、autonomous。autonomous 依赖 `--sandbox`。Windows 原生沙箱在 Vocatrya 源码中不可用。
- [Creating Skills](https://docs.devin.ai/cli/extensibility/skills/creating-skills)（2026-11-17协调复核）：技能有自己的权限块，且不能放宽更高层已经 deny 的规则。
- 原窗口引用 [Local sessions SDK](https://docs.devin.ai/sdk/guides/local-sessions) 中 ACP/MCP 与 CLI 3000.11.1 的说明。本次协调复核该页面访问失败，未独立确认；该条仅保留为待核实线索，不作为版本支持或首切片实施依据。

Devin 的结论：官方当前文档有会话 id、ACP 和 MCP，产品适配器没有接通。首个编码切片不实现 Devin 原生会话，避免用 Codex 的结果代替 Devin。

## 1. 路径选择

三条路径同时保留。连接分类不能代替路径选择。

| 路径 | 何时使用 | 执行者 | 本提案要求 |
| --- | --- | --- | --- |
| 前台原生会话 | 创建时明确选择 NATIVE_CODEX_V1 的新 Codex 账号职业对话；允许尚未创建原生 thread | Codex app-server | 官方运行时负责该 thread 的多轮上下文。Vocatrya 保存应用消息、绑定和必要回执 |
| 托管应用循环 | 自接 API、Vocatrya 托管 API，以及 executionPath 缺省或为 APP_ORCHESTRATED 的账号对话 | 现有 `accountTurn` / 应用工具循环 | 继续由 Vocatrya 选择工具、校验参数和执行业务入口 |
| 后台受限文本 | 摘要、解析、结构化输出、smoke、持久运行时池以外的 `codex exec` | 现有 TEXT_ONLY 调用 | `permissionScope` 保持 `TEXT_ONLY`。禁止为了前台改造放宽 `execute-server.js` |

路径由应用创建会话时持久固定的 executionPath 判定：缺省/APP_ORCHESTRATED 为旧路径，NATIVE_CODEX_V1 才允许创建或恢复原生绑定；不能以绑定行存在与否区分新旧。另持久化nativeInitializationState（NEVER_ATTEMPTED/ATTEMPTED）：只有明确NEVER_ATTEMPTED才能首次创建；发出thread/start前先置ATTEMPTED，成功后保存当前绑定，失败或结果未知不自动重发。该最小路径/初始化标记是本提案新增元数据，需在实施时通过新 Migration 和旧行默认语义接入，不塞进会丢弃未知字段的 context JSON。旧应用会话继续走现有应用循环。打开旧会话、恢复备份或切换默认模型，都不会自动领取一条原生 thread。

前台原生会话在首个切片的能力表：

| 能力 | Codex 首个切片 | Devin |
| --- | --- | --- |
| 进程复用 | 已核实，可继续使用 | 未支持跨回合进程会话 |
| 原生 thread 跨应用回合 | 协议已记载；产品未支持。切片要把它做成用户可见结果 | 未支持 |
| 退出后按 id 恢复 | 协议有 `thread/resume`；0.165.0 待核实 | 官方有 `--resume`；与 `-p`/ACP 的组合待核实。产品未支持 |
| 搜索 | 未启用。文本里的“已搜索”不是调用证据 | 未启用，且禁用状态待核实 |
| 业务工具 | 未加载 | 未加载 |
| 原生权限桥 | 未启用。意外审批请求一律拒绝 | 未启用 |
| MCP / Skills | 接口先定义，切片不加载 | 同左 |
| 取消 | 优先 `turn/interrupt`；当前版本不支持时退化为终止进程 | 现有行为是终止子进程 |

## 2. 应用会话与原生会话

### 归属

一条应用 `ChatConversation` 在同一时刻最多有一条有效原生绑定。绑定必须同时等于：

- `userId`
- `conversationId`
- `backendKind`
- `resolvedConnectionId`
- `runtimeProfileRef`
- `resolvedModel`
- `runtimeVersion`
- 非秘密配置指纹

任一字段与当前会话锁不一致，绑定视为不可用。禁止拿另一用户、另一连接、另一 profile 或另一模型的 thread id 继续。

`ChatConversation.resolvedConnectionId` 与 `resolvedModel` 在现有契约里创建后不变。新增executionPath也在创建时固定；首版只能由获准的原生会话入口选择，能力边界未核实时不改变现有默认路径。账号、连接或模型要切换时，用户使用新的应用会话。创建另一应用会话不使旧会话的有效绑定失效；不在旧 thread 上改模型。官方文档记载 provider 不一致时 `thread/resume` 返回 `modelProviderMismatch`；一旦证实，按绑定失效处理。

### 创建与复用

- 创建时机：该会话的第一条前台用户消息，且路径判定为 Codex 原生会话。打开面板、加载历史、生成标题和后台摘要都不创建 thread。
- 连续多轮：进程可以复用，thread id 必须复用。每条用户消息调用一次 `turn/start`。切片不使用 `turn/steer`。
- 退出重开：进程池可以为空。下一条用户消息按保存的 thread id 调用 `thread/resume`，成功后才 `turn/start`。打开面板只读应用消息和绑定状态。
- 运行时失效：确认不兼容的版本、指纹或profile变化使绑定进入INVALID；认证暂时失效只阻塞请求，先重新登录，不自动丢弃thread。当前请求停止，不自动创建新 thread 或重发。应用里的旧消息仍保留。界面说明原生上下文没有恢复；用户明确选择新建/重试且认证与边界核验有效后，才可在下一请求创建新 thread，只发送明确选择的失败消息一次。切片不把旧 transcript 重放进新 thread，避免以后有工具时重复执行。
- 认证失效：连接进入需重新登录时，不 resume。同一 `connectionId` 与同一 `runtimeProfileRef` 恢复认证后才允许续接。profile 被重建则旧 id 作废。

`thread/start` 在切片中使用 `ephemeral: false`。现有后台与结构化调用继续 `ephemeral: true`，并且不写入这条绑定。

非ephemeral会使官方运行时在托管profile内保存会话材料，可能含提示词和用户原文；不能把“不保存推理/完整事件”误表述为官方不落盘。该profile必须稳定跨重开、按用户/连接隔离并采用现有设备访问保护，不放到随测试清理的临时cwd；不进入产品导出/备份。会话硬删时清除对应绑定，thread文件的保留/清理由产品数据生命周期另行明确，不承诺仅删除绑定即擦除运行时文件。

### 持久化建议

不在本轮改 Schema。编码切片若获批准，在应用会话中增加固定 executionPath 元数据及初始化标记（旧行及缺省保持APP_ORCHESTRATED，备份恢复强制回旧路径并清除原生初始化标记，不恢复原生执行）；另新增一张运行时表，并把它加入 `src/lib/backup/coverage.ts` 的排除名单，与 `HarnessTask` 一样不进产品备份。`ChatConversation.context` 的解析器会丢弃未知字段，不能把 thread id 塞进现有 context JSON。

Main 工作区的 `src/lib/backup/export.ts` 当时已有其他修改。编码时先核对归属，不覆盖该脏文件；备份排除应落在 coverage/import 的既有运行时排除点。

最小字段：

| 字段 | 用途 |
| --- | --- |
| `id` | 绑定 id |
| `userId`, `conversationId` | 归属；`conversationId` 唯一 |
| `backendKind` | 切片只允许 `CODEX_RUNTIME` |
| `connectionId`, `runtimeProfileRef` | 连接与隔离 profile |
| `runtimeVersion`, `configFingerprint` | 失效判断；指纹不含秘密明文 |
| `resolvedModel` | 与会话锁一致 |
| `nativeSessionKind` | 切片固定 `CODEX_THREAD` |
| `nativeSessionId` | Codex thread id |
| `status` | `ACTIVE`、`INVALID`；当前绑定可覆盖替换，不存 SUPERSEDED 历史行 |
| `invalidReason` | 短枚举，不写提示词或凭证 |
| `promptHash` | 创建 thread 时的自定义提示词哈希 |
| `createdAt`, `updatedAt` | 审计 |

该表每个conversationId只有当前一行；新thread替换原生元数据，不承诺原生绑定历史。保留的历史指应用消息与既有业务回执。兼容：executionPath缺省或APP_ORCHESTRATED才是旧路径；NATIVE_CODEX_V1且没有绑定行时，只有nativeInitializationState明确NEVER_ATTEMPTED才是首次创建；曾尝试或标记缺失均视为可能丢失原生状态，进入REPLACEMENT_REQUIRED，不静默新建或改走应用循环。恢复备份时强制executionPath为APP_ORCHESTRATED且无绑定，不恢复原生执行。丢失 thread id 只失去原生上下文，不失去应用消息、提案或业务结果。

自定义提示词仍是既有输入，最多2000个Unicode字符。创建thread时必须实际装配提示词正文，promptHash仅用于比较，不能代替注入。哈希变化时，首选目标版本已核实的指令更新能力；若无此能力，提示将失去原生上文，须用户明确选择新thread后才在下一请求替换当前绑定，并装配最新正文。等待旧回合终态后才可替换，不自动丢弃上下文。该新增交互仍为待批准方案，不冒充现有偏好即时生效行为。只替换原生元数据，保持应用会话既有connection/model锁和context.permissionMode，不重新读取defaultPermission。权限模式仍在会话创建时固定；切片不把它映射为 Codex `danger-full-access` 或 `approvalPolicy: "never"` 以外的放宽。业务工具接通前，权限模式不改变原生沙箱。

## 3. 续做、取消与并发

用户消息是唯一的模型请求触发器。打开或展开执行面板只读取会话、绑定状态和已落库结果。

状态：

| 状态 | 进入条件 | 允许的下一步 |
| --- | --- | --- |
| `UNBOUND` | executionPath=NATIVE_CODEX_V1、nativeInitializationState=NEVER_ATTEMPTED，尚无当前绑定 | 第一条用户消息核验后创建绑定；打开面板保持未绑定；旧路径不进入本状态机 |
| `READY` | 已有 `ACTIVE` 绑定且没有在途回合 | 用户消息 resume 后 start turn |
| `TURN_ACTIVE` | `turn/start` 已发出且未终结 | 取消；拒绝第二条并发 turn |
| `READY`（取消后） | 收到 `interrupted`，或进程终止已被记为取消 | 下一条用户消息继续同一 thread；不自动补跑 |
| `INVALID` | 确认thread失效、版本或指纹不兼容 | 当前请求失败；后续显式选择新thread且认证/隔离有效后才创建 |
| `REPLACEMENT_REQUIRED`（派生UI状态） | 提示词变化且无已核实更新接口，绑定缺失且不能证明从未派发，或需放弃失效thread | 先展示影响并等待明确选择；不保存SUPERSEDED历史行 |

转换规则：

- 重复发送：沿用会话已有的单一活跃请求。原生侧同一 thread 同时只允许一个 Vocatrya turn。进程忙时不为同一会话再开第二条 thread。
- 会话切换：离开页面不取消已派发的外部操作。切片没有外部工具。切回时只加载状态。
- 取消：先发送 `turn/interrupt`。interrupt返回成功后仍等待终态。当前CLI不支持该方法时，仅在确认进程属于当前请求且无其他在途工作时允许终止并记为CANCELLED；保持每进程单活跃回合。若未来进程并发，禁止用杀进程代替单回合取消。取消不删除应用历史，也不表示外部写入已回滚。
- 网络/服务暂时失败不自动判定thread失效，不清空绑定；认证失败先恢复认证，不能新建绕过。只有明确的thread不存在/不可恢复或配置不兼容才置INVALID。
- 断线：进程退出使当前回合失败。thread 若已以非 ephemeral 保存，绑定仍是 `ACTIVE`，但本回合没有完成。下一条用户消息再 resume。resume失败按暂时故障、认证阻塞或确定失效分类，不一律INVALID。
- 迟到事件：本地回合已终结后到达的 delta 不写入该请求的助手消息。若取消后又收到 `completed`，记 `LATE_AFTER_CANCEL`，不补执行工具。
- 进程重启：空进程池不是空会话。有 `ACTIVE` 绑定就在下一条用户消息 resume。没有官方恢复成功时，界面保持“未恢复”，禁止显示成断点已续上。

切片不实现 H06 自动唤醒，也不改已派发外部操作的原合同。

## 4. 事件与结果

公共事件保持中立，厂商字段留在适配器。切片只产生文本、错误、用量和完成四类；其余类型先占位，收到时按失败关闭，不把未识别工具调用当成成功。

```ts
type NativeSessionEventV1 = {
  version: 1;
  kind:
    | "text_delta"
    | "search"
    | "tool_call"
    | "tool_result"
    | "permission_request"
    | "user_input_request"
    | "error"
    | "usage"
    | "turn_completed";
  conversationId: string;
  bindingId: string;
  nativeSessionId: string;
  nativeTurnId: string | null;
  itemId: string | null;
  proposalId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
};
```

关联：

- 应用会话：`conversationId`
- 原生回合：`nativeTurnId`
- 工具调用：`itemId`；接通业务工具后，同一调用在执行前写入现有 `toolCallId`
- 持久提案：`proposalId` 等于现有 `AgentOperationProposal.id`。没有提案的读取不制造空提案

完成只来自 `turn/completed` 且状态为完成，并与现有逐 item 文本对账一致。模型写出“已搜索”“已保存”或“已批准”只是文本。搜索必须有 `search` 事件和来源；业务结果必须来自现有执行入口的真实回执。

用量仅在协议实际提供时保存数字字段。不保存推理摘要、chain-of-thought、原始响应体或完整事件流。助手可见文本继续进现有 `messages`。切片不为观察事件新建平台表；工具接通后，每个真实工具调用保留一条现有执行或提案记录即可。

内部推理通知维持今天的忽略行为。忽略不等于删除用户已经看到的助手回答。

## 5. 业务工具与权限

切片不加载业务工具。接通时必须复用 `src/lib/agent/tools` 的现有入口、角色白名单、用户归属和批准规则。原生适配器只做参数转换和事件关联。

原生权限与应用批准的衔接：

- Codex 命令、补丁和文件系统审批不是 Vocatrya 业务批准。切片保留read-only与approvalPolicy:never，但这只约束写入/审批，不证明工具、搜索或敏感文件读取已被禁用。实施前必须在固定目标版本证明搜索、内置命令/读取能力及目录边界受限；不能仅在收到事件后失败关闭来防止已发生的读取。若无法建立文本会话所需边界，保持原路径，不开启新的默认原生分支。若仍收到审批请求，适配器拒绝该请求并记录 `permission_request` 被拒绝。
- 应用侧 `请求审批`、`帮我审批`、`完全访问` 继续只作用于已注册业务工具。`完全访问` 不改成 Codex `danger-full-access`，也不改成 Devin `dangerous` / `yolo`。
- 同一业务写操作使用同一冻结 `inputHash`。应用规则允许仅代表通过应用层；仍须逐项核对该原生请求的类型、目标、冻结输入及原生限制。只有两层均明确允许才可免重复展示同一业务确认，不能因此批准命令/文件权限；提案、任务和回执仍按H04/H05写入。
- 任一侧拒绝，整个调用不执行。原生允许不能跳过角色、归属、归档或连接授权。
- `outcomeStatus = UNCERTAIN` 或已有 `dispatchedAt` 时，禁止因为模型重试、用户重试或会话恢复而再次发起外部调用。

不向运行时提供 SQLite 路径、真实用户数据目录、备份目录或应用配置目录。工作目录维持 Vocatrya 拥有的临时目录。托管 profile 不得读取用户本机 `~/.codex` 或 Devin 用户配置。

`thread/start` 若返回 `instructionSources`，路径必须落在本次托管 profile 内。出现用户目录或仓库外的指令文件时，绑定记为 `INVALID`，本回合失败。该返回字段在 0.165.0 上待核实；字段缺失时记录“未证实”，不把它当成隔离失败。

## 6. MCP 与内置 Skills 的加载接口

四个状态分开保存，不能互相替代：

| 状态 | 含义 |
| --- | --- |
| 已安装 | 应用包内带有该定义 |
| 已启用 | 用户在扩展设置中打开 |
| 兼容 | 当前运行时版本支持它声明的加载方式和能力需求 |
| 本次已加载 | 本次原生会话实际交给运行时且初始化成功 |

实际可用集合 = 已启用 ∩ 兼容 ∩ 本次加载成功 ∩ 角色白名单 ∩ 连接授权。

加载计划最小结构：

```ts
type NativeExtensionLoadPlanV1 = {
  version: 1;
  conversationId: string;
  backendKind: "CODEX_RUNTIME" | "DEVIN_RUNTIME";
  runtimeVersion: string;
  installed: Array<{ id: string; version: string; kind: "mcp" | "skill" }>;
  enabledIds: string[];
  compatible: Array<{ id: string; ok: boolean; reason?: string }>;
  loaded: Array<{ id: string; version: string; contentHash: string }>;
};
```

技能内容的最小输入，供技能窗口产出、运行时以后消费：

```ts
type NativeSkillContentV1 = {
  id: string;
  version: string;
  title: string;
  description: string;
  instructions: string;
  requiredCapabilities: Array<
    "multi_turn_user_input" |
    "business_read" |
    "business_write" |
    "web_search" |
    "web_fetch"
  >;
};
```

运行时限制：

- 只接受应用自己写入托管目录的内容。Codex 需要文件路径时，路径指向该副本，并计算 `contentHash`。
- `requiredCapabilities` 有一项不在本会话已核实能力中，则本会话不加载，并在兼容列表给出原因。
- 不调用用户本机 `skills/list` 作为安装来源，不读取其他应用的 MCP 配置，不继承 CLI 已登录的扩展。
- 第三方 Skill 导入保持不可执行的「敬请期待」。接口不接收任意文件、URL 或脚本。
- 技能正文不能新增工具名或放宽 deny。需要业务动作时，只能点名已经存在的业务工具。
- Devin 技能权限块在托管 deny 仍有效时不能恢复 `exec`、任意写或 `mcp__*`。

切片的加载计划对技能和 MCP 都是空的 `loaded`。这是成功状态，不是失败。

## 7. 首个编码切片

### 用户可见成果

**新的 Codex 账号职业对话可以在同一应用会话里连续提问；退出应用后再次打开，用户再发送一条消息时，继续同一个 Codex thread。打开窗口不会自己请求模型。恢复失败时明确告诉用户原生上下文未恢复，本请求失败且不自动转发；用户明确选择新thread/重试后，才在下一请求提交所选消息一次。搜索、业务工具和技能都显示为未加载。旧会话和所有后台文本调用保持现状。**

推荐它作为第一片的原因：

1. 它覆盖创建、复用、重开、失效和取消，是一条能独立验收的用户路径。
2. Codex 产品已经有 app-server 进程和 thread id，缺口集中在 `ephemeral` 与“进程复用被当成会话恢复”。
3. Devin 的 ACP、`--resume` 与 `-p` 组合还没有在已集成版本上核实，放进第一片会把两个协议绑在一起。
4. 业务工具桥、搜索和技能加载都依赖这条关联先成立；倒过来做会在没有归属的情况下执行动作。

次序：

| 顺序 | 范围 | 原因 |
| --- | --- | --- |
| 1 | 本切片：Codex 前台 thread 关联与诚实降级 | 用户能看到跨回合和重开差异 |
| 2 | 只读业务工具桥与中立事件 | 依赖切片 1 的 binding、turn、item 关联 |
| 3 | 写工具与 H04/H05 提案对齐 | 依赖只读桥和未知结果规则 |
| 4 | Devin，仅在目标 CLI 版本上核实 ACP 或明确的 resume 协议之后 | 不从 Codex 推断 |
| 5 | 内置技能加载 | 依赖会话能力表；技能正文可提前编写 |

### 文件归属与依赖

本切片的编码 Owner 同时负责下列文件中的会话分支，避免两个窗口改同一分支点：

- `desktop/main/runtime/streaming.js`
- `desktop/main/runtime/codex-persistent-runtime.js`
- `desktop/main/runtime/codex.js` 及其直接测试
- `src/lib/agent/accountTurn.ts` 的路径分叉
- 新的绑定存储、对应 Migration，以及 backup coverage 的排除项

依赖现有会话锁、`activeRequest` 单飞、`AgentConversationContextV1` 和 TEXT_ONLY execute-server。不依赖技能窗口、扩展 UI 三标签、任务卡视觉或 Devin 适配。

`src/lib/backup/export.ts`、`src/components/settings/AgentPreferencesSettings.tsx` 在提案时点已由其他窗口修改。本切片不把它们列为第一批编辑对象。

可并行：

- 简历证据深挖的追问、阶段结果、示例和文案。
- 只读的 Devin 版本/帮助核对，不登录、不调用模型。
- 托管 API 路径上与原生绑定无关的缺陷。

必须等待本契约批准后才能做：

- Schema 与备份排除的实现。
- `accountTurn.ts` 的原生分支。
- 把业务工具暴露给 Codex `dynamicTools` 或 MCP。
- 打开 `experimentalApi`。

### 失败与恢复

- `thread/resume` 失败：区分暂时失败/认证问题与确定失效；保留应用消息，当前请求失败，不自动新建或重发；只有显式选择与必要认证核验通过后才新建。
- 回合中进程崩溃：该回合失败，绑定保持 `ACTIVE`，不自动重发。
- 协议对账失败：沿用 `STREAM_COMPLETION_INCONSISTENT`，不把半截文本标成完成。
- 取消与完成竞态：以本地已取消为准，迟到完成不改写助手消息。
- 提示词变化：优先已核实的更新能力；否则提示上下文影响并等待明确选择，不能自动切换。
- 版本未实现 `thread/resume`：切片不能上线为默认路径。目标版本或隔离条件未证实通过时保持既有路径，不伪造恢复。

### 验证与完成标准

开发验证使用假 JSON-RPC 与隔离数据，不使用真实账号或付费模型：

- 两条用户消息使用同一个 thread id，且第二条不再调用 `thread/start`。
- 进程对象销毁后，下一次调用先 `thread/resume` 再 `turn/start`。
- 打开加载函数不产生runtime请求。
- 有原生派发尝试或无法证明首次创建时，缺失绑定不得静默新建；thread/start前持久化尝试标记，未知结果不能自动重复派发。
- user、connection、profile、model 或版本不匹配时不 resume。
- 无绑定的旧会话仍走现有决策循环，execute-server 仍拒绝非 `TEXT_ONLY`。
- 取消后迟到 delta 不进入该助手消息。
- resume失败时无turn/start、无自动新建/重发；显式选择新thread后仅提交选定消息一次，认证失败不能绕过。
- 自定义提示词正文实际生效；哈希变化不自动丢失上下文，在途不换绑定，替换时保持原应用权限。
- 固定目标版本的搜索/内置工具/目录边界无法证明受限时，新原生路径不能启用。

完成标准是以上定向测试通过，并且用户可见文案能区分“同一原生会话已继续”和“原生上下文未恢复”。上述仅是代码实现阶段的定向完成标准。目标CLI版本的协议核验、隔离Windows Electron与真实账号路径仍是上线/功能验收的独立必要证据；Mock通过不能将新原生路径设为默认或标记功能验收通过。

### 技术选择

以下由本提案直接确定：

- 第一运行时只做 Codex；Devin 保持 TEXT_ONLY。
- 新会话才进入原生路径；旧会话不迁移。
- 绑定表不进备份。
- 沙箱保持 read-only，审批保持 never，意外审批一律拒绝。
- 不启用搜索、MCP、动态工具和技能。
- 不重放 transcript，不保存推理，不建事件平台。
- 自定义提示词变化不自动丢弃原生上文；优先已核实更新，否则明确选择新thread后生效。

### 待用户裁定

没有必须先回答才能编写本提案的问题。只有一项会改变第一片范围：

| 问题 | 推荐 |
| --- | --- |
| 首个用户成果是否必须包含一次真实业务写入或原生搜索？ | 不包含。先交付可重开的 Codex 原生 thread。写入与搜索分别放到后续切片，并各自取得调用证据 |

本节是协调核验后的推荐，不是用户已经批准。文档提交不授权编码；尤其目标版本的安全/协议能力不得用推荐代替实证。

## 8. 与技能窗口的接口差异

技能窗口现在可以编写追问流程、阶段总结、结果字段和示例。它不需要等待本提案批准。

本窗口不规定：

- 每轮问什么、何时跳过、阶段总结长什么样
- 证据结果的业务 Schema、示例答案或评分
- 结果最终写入哪张已有业务表

技能窗口不应假定：

- 运行时已经加载该技能，或 Codex `$skill` / Devin frontmatter 已经生效
- 存在原生 thread id、搜索事件或业务工具调用
- 可以新增 SQLite、文件目录或未注册工具
- 第三方 Skill 包可以被导入

若技能结果需要运行时保存，先使用产品结果合同中的字段名。运行时以后只通过已有业务入口保存。在那之前，技能文档中的保存步骤应标明“依赖尚未接通的业务写入”。

已知可能的差异，留给协调窗口：

| 主题 | 本提案 | 技能窗口可能需要 |
| --- | --- | --- |
| 多轮状态 | 由 Codex thread 或应用消息保存 | 自己的阶段枚举与暂停/跳过 |
| 用户确认的素材 | 切片不提供写工具 | 结果结构里的确认记录 |
| 能力需求 | `requiredCapabilities` 不满足则不加载 | 正文仍可按技能最终形态书写 |

这些差异不阻塞任何一边继续自己的文档。

## 9. 明确不做

- 不重建全部原生框架，不把 Claude、Cursor、OpenCode、Grok 算作本切片已覆盖。
- 不取消后台 `TEXT_ONLY`，不开放数据库和真实数据目录。
- 不把 H01–H05 的通过记录改成原生适配通过。
- 不实现加载器、技能市场、第三方导入、任务中心或 H06。
- 不把 Codex app 的默认搜索、Full access 或用户本机 MCP 复制进 Vocatrya。
- 不使用 Devin Cloud 会话或 `--continue` 的“当前目录最近会话”。临时 cwd 上的最近会话可能指向错误记录。


## 10. 协调核验记录（2026-11-17）

核对基线源码、职业素材配套合同及当前官方app-server/Devin命令、权限与技能资料；SDK local-sessions页面本次不可达，相关版本说法降为待核实。修正executionPath与未绑定状态歧义、唯一当前绑定与历史语义、恢复失败自动重发矛盾、取消进程归属、提示词实际装配及上下文丢失、read-only被误当工具/文件隔离、业务允许被扩大成原生允许等问题。仅提交提案，不批准设计、不修改产品代码、不运行真实模型或桌面。
