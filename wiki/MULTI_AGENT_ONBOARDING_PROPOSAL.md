# MULTI-AGENT 冷启动与拒答指路设计提案（入口具名 / 默认角色 / 拒答指路 / 空状态）

- 记录日期：2026-11-16。
- 基线：`main @ 901b9b2b`（本轮定向静态查看；工作区另有与本方案无关的未提交修改，未纳入核对）。
- 状态：**已冻结（2026-11-16 Owner 裁定 §8 D1–D6 及补充项，见 §13）**；【建议】条款按裁定生效。本文件不授权代码修改、Schema/Migration、提交、合并、部署或真实数据操作——实施仍须各自任务授权。
- 配套台账：[MULTI_AGENT_ONBOARDING_FEATURES.json](MULTI_AGENT_ONBOARDING_FEATURES.json)。本方案独立记录，不改写 MVP/P1/P2/EXTENSIONS 台账状态。
- 上游依据：`P2_MULTI_AGENT_CONTRACT_PROPOSAL.md`（D1–D10 已冻结）、`P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md` §6（首页 Agent 槽位=单入口 `open({role})`）、`EXTENSIONS_IMPLEMENTATION.md` §3（有效能力=连接∩tools/list∩角色白名单∩运行时）。**本方案不改写已冻结合同**；与冻结项冲突处以冻结合同为准，仅作 UX 增量提案。
- 标注约定：**【源码事实】**＝当前代码实际行为（附文件:行，仅定向静态查看，不代表实测）；**【建议】**＝本方案推荐，未经裁定不冻结；**【待裁定】**＝需 Owner 拍板的具体选项。
- 起因（真实回放）：用户在 Voca Insight 会话中要求写入 Notion——连接正常、`availableTools` 覆盖远端写工具、扩展页五项能力全亮，但 Insight 白名单只含 `notion_search`/`notion_read`，写工具在注册阶段即被裁掉；模型如实回答"没有可用的写入工具"，却未解释原因、未指路。同期首页三个 Agent 入口共用「咨询 Vocatrya」文案，看不出各自进的是哪个角色。

## 1. 需求复述（用户 2026-11-16 指令）

1. 首页三个「咨询 Vocatrya」入口分别具名为 Voca Insight / Voca Pilot / Voca Reflect，各带一句**口头化**职责简介；**扩展能力（如 Notion）不写入首页说明**——Notion 属扩展功能，简介写职责域，不写工具。
2. 右侧 Agent 栏默认进入能力最全的 Voca Pilot。
3. 角色拒绝用户请求时必须说明原因并指路：例如 Insight 被叫去写入时应如实告知"我只有只读权限"，并建议用户切换到 Voca Pilot，而不是只答"不能"。
4. 设计三个 Agent 的用户冷启动方案。
5. 参考业界 multi-agent 系统的通行设计（本轮已检索：ChatGPT GPTs、Microsoft 365 Copilot agents、Pimcore、OctoPress、GitLab Duo、LangGraph supervisor）。
6. 方案记录为 wiki 下 md + json 设计文档（即本文件与配套台账）。

## 2. 业界参考与对本项目的取舍

| 参考 | 做法 | 对本项目的取舍 |
| --- | --- | --- |
| ChatGPT GPTs / M365 Copilot agents | 每个 agent 对用户只呈现"名字 + 一句 description + conversation starters"；description 写任务与对象，**不枚举工具** | 直接采用：静态文案只写职责域；能力清单交给 prompt 动态生成（§5 P1） |
| Pimcore Agents & Switching | 每个 agent 的 system prompt 在构建时追加 **awareness block**：列出其余 agent 的名字、职责、何时交给它；模型据此主动建议 `switch_agent` widget，用户一键切换 | 采用其 awareness block（一期纯文案指路）；widget 列为远期备档（§6.5） |
| OctoPress handoffs | agent 只能**建议**切换，弹确认窗写明谁建议、建议找谁、原因；切换永不自动发生 | 采用其"切换是用户的决定"原则（§5 P4） |
| 各家默认落地 | 默认落最通用/门面 agent | 现状已符合：`GENERAL_AGENT_SLOT="pilot"`，不改动（§6.2） |
| Claude Code 父子编排 / LangGraph supervisor | 子 agent 不直接对用户；supervisor 自动路由 | 不采用：本项目是同级角色槽（近 GPTs/Pimcore），非父子编排；不引入自动路由 |
| GitLab Duo | 会话开场选 agent、不可切换 | 不采用：我们的顶部切换器更灵活，需解决的是"指路"而非锁定 |

## 3. 现状源码事实

### 3.1 入口与默认角色【源码事实】

- `JourneySection.tsx:101-105` 三卡已分别 `open({role})` → prepare→insight、act→pilot、review→reflect；但按钮共用 `dashboard.journeyAskAgent`＝「咨询 Vocatrya」（`JourneySection.tsx:287-295`、`zh-CN.json:384`）。**路由已对，只是用户认不出角色**。
- 默认角色已是 Pilot：`GENERAL_AGENT_SLOT="pilot"`（`agentRoles.ts:16`）；挂载顺序＝载入会话角色 → `readActiveAgentRole()` 上次激活 → Pilot（`AgentChatProvider.tsx:203-205`）；`suggestionsForRole` 对空角色同样归 Pilot（`roleSuggestions.ts:89`）。**需求 2 已由现状满足**，仅待验收口径确认。

### 3.2 拒答链路缺口【源码事实】

- 角色有效工具集＝白名单 ∩ 运行时注册集（`tools/index.ts:125-131`）；白名单在 `agentRoles.ts:49-73`：insight/reflect 只含 `notion_search`/`notion_read`，三个写工具仅 pilot 持有——这是起因案例的直接原因，属冻结合同 §2.2 的设计而非缺陷。
- `*_LIMITATIONS`（`prompt.ts:61-68`）有零散分工提示（如 Insight 的 "Voca Pilot handles adding jobs"），但：①未覆盖扩展写（Notion 写入不在内）；②未给切换指引（怎么找到 Pilot 没说）；③无全量 roster——模型不知道另外两个角色是谁、各自管什么。
- `buildNotionPromptSection`（`prompt.ts:212-235`）只在注册了写工具时才描述写入；**只读会话里模型连"Notion 写入存在但归别人"都无从得知**，只能答"没有工具"——正是回放中的回答。

### 3.3 空状态与切换器可发现性【源码事实】

- `AgentChatEmptyState.tsx:30-84`：品牌态 + "开始一次 Career AI 对话" + 每角色 4 条建议（点击只填入，已冻结 D8 语义）+ 上下文按钮。头部虽有角色名+副标题，但没有"我是谁/我不做什么、找谁"的自我介绍。
- `AgentRoleSwitcher.tsx`：三图标（Telescope/Compass/MessagesSquare）仅 hover/focus 显示名称——新用户无从知晓图标含义，也不知另外两个角色存在。

## 4. 设计原则

- **P1 职责域与工具层分离**：所有静态文案（首页入口、空状态介绍、副标题）只写职责——帮你看 / 帮你干 / 陪你聊。工具与扩展能力由 prompt 按"运行时注册集"动态生成；扩展增减、连接断开都不会让静态文案撒谎。
- **P2 roster 单一来源**：三角色的"名字+副标题+一句分工"定义在一处，同时喂给 prompt 感知块、空状态、首页入口，避免三处漂移。
- **P3 拒答三件套**：①我做不到什么 ②为什么（角色分工/权限边界，不是故障也不是"没连上"）③谁能做＋怎么切换（点名角色＋顶部图标位置）。
- **P4 切换是用户的决定**：模型只能建议，不自动切换、不把用户请求私下转交（远期 widget 同样保留用户确认门）。
- **P5 继承已冻结边界**：工具白名单矩阵、会话槽隔离、`fillComposer` 填入语义、`open({role})` 不发送——本方案一律不改。

## 5. roster：唯一文案来源【建议】

新增 `AGENT_ROSTER`（建议放 `roleCopy.ts`，与 `AGENT_ROLE_FALLBACKS` 同址；`agentRoles.ts` 保持 dependency-free 不放文案）。每角色三项：`name`（复用现有）、`subtitle`（复用现有）、`dutyLine`（新增，口头化一句分工）与 `siblings`（由代码按当前角色推导，不需存）。供三处消费：prompt 感知块、空状态、首页入口。

草案文案（口头化；实现期 i18n 双语定稿）：

| 角色 | subtitle（现有） | dutyLine 草案 |
| --- | --- | --- |
| Voca Insight | 求职分析师 | 帮你分析：职位要什么人、简历怎么改、和你有多匹配。只看，不动手。 |
| Voca Pilot | 工作台助手 | 帮你干活：查职位、记职位、盯投递，动你数据前都先给确认卡。 |
| Voca Reflect | 对话教练 | 陪你捋：面试复盘、几个机会怎么选、下一步怎么走。只看，不动手。 |

## 6. 方案细目

### 6.1 MAO-ENTRY 首页三入口具名 + 口头职责【建议】

- `JourneySection` 三卡 Agent 按钮不再共用 `journeyAskAgent`，改为每 stage 一条文案：**「咨询 Voca Insight —— 帮你看看职位要什么人、简历怎么改」**（准备）、**「咨询 Voca Pilot —— 帮你记职位、盯投递，动手前先给你确认」**（行动）、**「咨询 Voca Reflect —— 陪你聊聊面试、捋捋下一步」**（复盘）。
- 职责句来源即 roster `dutyLine`，单行长文本截断；不提 Notion 或任何扩展/工具名（P1）。
- 行为不变：仍 `open({role})`，不发送、不建会话（冻结语义保留）。

### 6.2 MAO-DEFAULT 默认角色【源码事实，仅记录】

默认落 Pilot 已实现（§3.1）。**建议保留"重开恢复上次激活角色"**——用户主动切去 Insight 是有意图的，不应每次拽回；仅当 Owner 要求"每次打开强制 Pilot"才改 `mountRole`。无代码改动，验收时核对"全新用户冷启动落 Pilot"即可。

### 6.3 MAO-REFUSAL 拒答指路【建议，本方案核心】

三块增量，全部在 prompt 层，一期零新 UI：

1. **阵容感知块（awareness block）**：在 `buildAgentChatSystemPrompt` 为每个角色追加一节，列出另外两个角色——名字、一句分工、何时交给它、怎么切换（顶部第几个图标）。英文草案：

   > `You share this workspace with two sibling assistants. The user can reach either from the role icons at the top of this panel at any time: Voca Pilot (the compass icon) looks jobs up, records new ones and performs every write — including connected extension writes like Notion; Voca Reflect (the chat icon) coaches interview debriefs and trade-off thinking. When the user asks for something outside your role — writing or changing their data, an analysis you don't run, or an extension capability you weren't given — say plainly that you can't do it, name the sibling who can, and point to its icon. Never describe the request as impossible, broken, or unavailable in this app.`

   按当前角色动态生成 siblings 两行，文案取 roster。

2. **LIMITATIONS 定点补一句分工归因**：`INSIGHT_LIMITATIONS` 现有 "Voca Pilot handles adding jobs" 扩为"任何写入/修改类操作（含扩展写）都归 Voca Pilot"；`PILOT_LIMITATIONS` 补"简历评审与匹配分析归 Voca Insight"；`REFLECT_LIMITATIONS` 已点名两者，补切换指引。不改现有枚举主体——它仍是最诚实的能力声明。

3. **`buildNotionPromptSection` 只读分支**：`hasReads && !hasWrites` 时追加一句"你的 Notion 是只读；建页/追加/改记录归 Voca Pilot，请建议用户从顶部角色图标切换"——按**实际注册工具**生成，Insight、Reflect 及未来任何角色自动覆盖，无需逐角色手写。

### 6.4 MAO-EMPTYSTATE 空状态冷启动【建议】

GPT 三件套变体（现有 chips 与上下文按钮不动）：

- **角色自述两行**（取 roster，第一人称口吻）插在现有"开始一次 Career AI 对话"与建议之间：
  - Pilot："我帮你打理职位：查、记、跟进，动数据前都先给你确认。想分析简历？找 Insight。"
  - Insight："我帮你看清楚：职位要什么人、简历怎么改、和你有多匹配。我只看不动手——记职位、写入类的活儿找 Pilot。"
  - Reflect："我陪你捋：面试聊得咋样、机会怎么选、下周干啥。我不动你的数据——干活找 Pilot，分析找 Insight。"
- **阵容图例一行**（底部，兼作切换器可发现性）："Insight 帮你看 · Pilot 帮你干 · Reflect 陪你聊——顶部图标随时换。"
- chips 仍为每角色 4 条、点击只填入（冻结 D8 语义）；不新增依赖连接态的动态 chip（远期再议）。

### 6.5 MAO-SWITCHWIDGET 远期切换建议卡【备档，本期不做】

参考 Pimcore `switch_agent` widget 与 OctoPress handoff 门：模型输出结构化"建议切换"信号 → UI 渲染卡片`[切到 Voca Pilot] [留下]`→ 点击调 `switchRole(role)` 并把用户原话填入目标槽位草稿（不搬运会话——本架构角色=独立会话槽，只携带当次请求）。需新增 UI part 类型与流转接线，列入台账 DEFERRED，待一期指路文案实测后再评估收益。

## 7. 文案草案汇总（口头化；实现期 i18n 双语定稿）

| 位置 | 中文草案 | 英文草案 |
| --- | --- | --- |
| 首页·准备卡 | 咨询 Voca Insight —— 帮你看看职位要什么人、简历怎么改 | Ask Voca Insight — what the job wants, how to fix your resume |
| 首页·行动卡 | 咨询 Voca Pilot —— 帮你记职位、盯投递，动手前先给你确认 | Ask Voca Pilot — log jobs, track applications, always confirms first |
| 首页·复盘卡 | 咨询 Voca Reflect —— 陪你聊聊面试、捋捋下一步 | Ask Voca Reflect — talk through interviews and next steps |
| 空状态·Pilot | 我帮你打理职位：查、记、跟进，动数据前都先给你确认。想分析简历？找 Insight。 | I keep your job list in shape — look jobs up, log new ones, and always confirm before touching your data. For resume analysis, ask Insight. |
| 空状态·Insight | 我帮你看清楚：职位要什么人、简历怎么改、和你有多匹配。我只看不动手——记职位、写入类的活儿找 Pilot。 | I read jobs and resumes and tell you how well they fit — match checks, resume reviews. I look but never touch; logging and writes are Pilot's job. |
| 空状态·Reflect | 我陪你捋：面试聊得咋样、机会怎么选、下周干啥。我不动你的数据——干活找 Pilot，分析找 Insight。 | I help you think it through — how the interview went, which offer to pick, what next. I never change your data; doing is Pilot's, analysis is Insight's. |
| 阵容图例 | Insight 帮你看 · Pilot 帮你干 · Reflect 陪你聊——顶部图标随时换 | Insight analyzes · Pilot does · Reflect talks — switch anytime from the icons up top |

## 8. Owner 决策表（编号；每项互斥选项）

| # | 待决项 | 选项 | 本方案推荐 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 首页入口文案形态 | (a) 单行「咨询 Voca X ——口头职责」；(b) 两行（名称+简介）；(c) 复用现有副标题、不加职责句 | **(a)** | (a) 改动最小、一行够传达；(b) 信息全但按钮变高；(c) 副标题偏抽象，不解"它能帮我干嘛" |
| D2 | 空状态角色介绍 | (a) 自述两行（我做什么+找谁）；(b) 只加阵容图例、不加自述；(c) 结构化能力卡片 | **(a)** | (a) 与 GPT description 同构、成本最低；(b) 信息量不足；(c) 重设计，超出冷启动所需 |
| D3 | 拒答指路深度 | (a) 一期纯 prompt 指路（感知块+LIMITATIONS 补句+Notion 只读分支）；(b) 一期+二期 widget 同做；(c) 只做 widget | **(a)** | (a) 零新 UI、直接修回放中的问题；(b) 一次过大；(c) 等 widget 期间缺陷仍在 |
| D4 | roster 文案单一来源 | (a) `roleCopy.ts` 扩 `AGENT_ROSTER`；(b) 独立新模块；(c) 三处各写 | **(a)** | (a) 与 AGENT_ROLE_FALLBACKS 同址、i18n 机制现成；(b) 过度拆分；(c) 违背 P2 |
| D5 | Notion 只读提示位置 | (a) `buildNotionPromptSection` 按注册工具动态生成分支；(b) 写进各角色 LIMITATIONS | **(a)** | (a) 随注册集自动准确、覆盖未来角色；(b) 静态写死，扩展变化即漂移 |
| D6 | 空状态阵容图例 | (a) 底部加一行图例；(b) 不加 | **(a)** | (a) 顺带解决切换图标可发现性；(b) 图标含义仍靠 hover 发现 |

## 9. 实现触点与文件 Owner 建议

| 文件/区域 | 改动 | 建议 Owner |
| --- | --- | --- |
| `src/lib/agent/roleCopy.ts` | `AGENT_ROSTER` 单一来源（name/subtitle 复用 + dutyLine/siblings 文案 key） | 本包 Owner |
| `src/lib/agent/prompt.ts` | 感知块节、`*_LIMITATIONS` 补句、`buildNotionPromptSection` 只读分支 | 本包 Owner |
| `src/components/dashboard/JourneySection.tsx` | 三入口具名文案（仍 `open({role})`） | 本包 Owner |
| `src/components/agent/AgentChatEmptyState.tsx` | 角色自述两行 + 底部图例行 | 本包 Owner |
| `src/i18n/messages/zh-CN.json` + `en.json` | 入口/自述/图例词条（共享词典，按协调顺序并入） | 共享词典单一 Owner |
| `__tests__/`（agentPrompt、extensionsEntry、roleSuggestions 等） | 断言同步：感知块存在、只读分支、入口文案、空状态构成 | 本包 Owner |
| `wiki/MULTI_AGENT_ONBOARDING_FEATURES.json` | 本台账，Main 集成 Owner 维护 | Main 集成 Owner |

Non-goals：不改工具白名单矩阵、不改会话槽/锁/批准机械、不新增 Agent 工具、不改 `open()`/`fillComposer` 已冻结语义、不做自动路由或跨角色调用、不做 widget（备档）。

## 10. 与已冻结合同的关系

- `P2_MULTI_AGENT_CONTRACT_PROPOSAL.md`：本方案全部位于其外沿——提示词在 §2.3"分节拼装"框架内新增一节、§2.4 诚实降级矩阵增补"越界请求指路"；不改 D1–D10 任一裁定。若实施中发现需改白名单矩阵本身（如 Insight 也发写工具），须回该合同走变更流程，不在本方案内。
- `P2_OVERVIEW_ACTIONS_CONTRACT_PROPOSAL.md` §6/§9 D7：Agent 槽位单入口语义不变，仅改按钮文案。
- `EXTENSIONS_IMPLEMENTATION.md` §3：角色白名单交集语义不变；Notion 只读分支正是该交集在提示词层的如实表达。

## 11. 验证矩阵（仅定义，不执行）

| # | 场景 | 验证点 |
| --- | --- | --- |
| V1 | 首页入口 | 三卡按钮分别显示具名角色+职责句；点击仍 `open({role})`，0 次 `/api/ai/chat`、0 次会话创建；文案不含任何扩展/工具名 |
| V2 | 默认角色 | 全新用户首次打开面板落 Pilot；重开恢复上次激活角色（除非 D-补充裁定强制 Pilot） |
| V3 | Insight 拒答指路 | Insight 会话中被要求写 Notion/加职位：回答说明只读/分工边界、点名 Voca Pilot、给出切换方式；不宣称"没有工具/未连接/功能不可用" |
| V4 | Pilot/Reflect 拒答指路 | Pilot 被要求跑匹配/评审简历→指路 Insight；Reflect 被要求写入/分析→分别指路 Pilot/Insight |
| V5 | 感知块与注册集一致 | 服务端断言各角色感知块只列真实存在的兄弟角色；只读 Notion 会话的提示词含只读指路句；含写工具会话不含该句 |
| V6 | 空状态冷启动 | 每角色空状态含自述两行+4 条建议+图例行；建议点击仍只填入不发送；preflight 失败态按冻结 D8 |
| V7 | roster 单一来源 | 首页入口、空状态、感知块三处角色分工文案同源（断言同一 key/同一生成函数） |
| V8 | 双语 | zh-CN/en 全部新词条存在且非回退文本；口头化口吻在两种语言下等义 |

## 12. 授权声明

§8 D1–D6 及补充项已于 2026-11-16 经 Owner 逐项裁定生效（见 §13）。本文件不构成代码修改、Schema/Migration、提交、合并、推送、发布、真实数据操作或真实 AI/凭据调用授权——实施仍须各自任务授权。

## 13. Owner 裁定冻结记录（2026-11-16）

Owner 于 2026-11-16 逐项裁定 §8 D1–D6，全部按推荐项（a）生效；切换 widget 按 D3(a) 留 MAO-SWITCHWIDGET 备档。

| # | 裁定结果 |
| --- | --- |
| D1 | (a)：首页入口单行「咨询 Voca X —— 口头职责」 |
| D2 | (a)：空状态角色自述两行（我做什么 + 我不做什么/找谁） |
| D3 | (a)：一期纯 prompt 指路（阵容感知块 + LIMITATIONS 补句 + Notion 只读分支）；切换 widget 留档备查 |
| D4 | (a)：roster 文案单一来源放 `roleCopy.ts`（`AGENT_ROSTER`） |
| D5 | (a)：Notion 只读提示由 `buildNotionPromptSection` 按注册工具动态生成 |
| D6 | (a)：空状态底部加阵容图例行 |
| 补充项 | 全新用户首次打开默认落 Voca Pilot；重开面板恢复用户上次退出时的激活角色（现状语义，不强制回 Pilot） |
