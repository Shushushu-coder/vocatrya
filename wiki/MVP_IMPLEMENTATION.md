# Vocatrya MVP 增量实施计划

> 生成日期：2026-10-26；独立定向复审修订：2026-10-26。基线：main @ `8ff63dfb`。
> 依据：当前 Main 源码实证 + 《MAIN CONTEXT & MVP Implementation Plan》+ 《Vocatrya 职业资料 V1 回归定义与结构基线》(docs/resources)。
> 状态口径：IMPLEMENTED=业务路径已接通；PARTIAL=有基础但缺关键功能或集成；MISSING=无对应实现；UNVERIFIED=证据不足。

## 试用新增需求与能力核查（2026-10-28，三线代码已集成 Main）

用户要求记录并核查以下需求，并授权同步 `MVP_FEATURES.json`。自动检测更新与聊天交互分别记录为 `SET-AI-RUNTIME-UPDATE`、`AGENT-CHAT-UX`（IN_SCOPE）；Agent 能力现状与待裁定扩展记录为 `AGENT-CAPABILITIES`（OWNER_DECISION）。输入偏好追加记录为 `SET-INPUT-PREFERENCES`（P0、IN_SCOPE）。本节保留需求基线，并以下方三线进度为当前状态；三条开发线已完成本批代码、合并前修复及 Main 集成，新增项 `passes` 均为 false，既有验收结果不变。

核查来源：Main `892422f2` 及本轮修复；当前隔离 Windows Electron 试用产物为 `G79eH1Wz4YriE8lYq4jPN`，包含网申资料直接显示、顶部栏入口和 AI 预检/模型显示修复。经授权以合成内容验证 Codex `0.165.0` 的流式 4 项及结构化 9/9，通过后更新精确认证版本；159 项相关测试、类型检查和 ESLint 通过。真实 Electron 已核对模型显示和发送按钮可用，未以此声称完整 AI 业务验收通过。本轮修复随本次提交纳入 Main；未执行 Push 或发布。

### 三线开发与 Main 集成进度（2026-10-28）

用户随后明确授权合并 Main。本次集成提交纳入三个基于 `411fbca8` 的开发 Worktree 未提交实现、主窗口已有输入偏好需求记录和以下合并前修复。Main 的共享双语词典按 `inputPrefs`、`agentAnswer`、`runtimeUpdate` 三个命名空间合并，并检查无重复 JSON 键；原 Worktree 与 Dirty 内容保留，未清理、未推送。

| 任务 | Main 实施状态与范围 | 剩余事项 |
| --- | --- | --- |
| SET-INPUT-PREFERENCES | IMPLEMENTED；四偏好、本机存储、设置入口、职业/网申资料编辑、显式连续填写、焦点/提示/IME 保护 | 真实中文 IME、Windows Electron fresh-native、重开持久化与窄窗口验收 |
| AGENT-CHAT-UX | PARTIAL；逐条正文复制及顶层围栏代码块独立复制，流式取点击时可见快照，成功/失败及无障碍反馈 | 真实桌面剪贴板与历史重开；嵌套围栏/缩进代码块暂不支持独立复制，普通回答重新生成尚未开发 |
| SET-AI-RUNTIME-UPDATE | IMPLEMENTED；七类运行时查询、自动/手动共用检查、缓存/超时/重试、版本与兼容状态分离、恢复指引；不执行更新 | Settings UI 与 Windows Electron fresh-native 验收 |

合并前修复：

- 更新检测：规范化原生 AbortError，避免数字错误码造成设置页渲染崩溃，并恢复超时重试；手动重查 IPC 失败时清除旧成功状态并显示失败；同日不同 Cursor SHA（包括空白及 v/V 前缀）返回不可比较，不推断构建先后。
- 输入偏好：IME composition ref 在导航前拦截；跳过仍有布局位置的 visibility:hidden 字段；键盘重新进入时覆盖上一次保留的选区；本机保存失败明确反馈并保留原设置；复用同步职业资料校验和必填约束阻止无效 Enter 跳转，Tab 保持原生顺序并保留草稿。既有校验抽到客户端安全模块，服务保留原导出和规则。

Main 实际验证：前端及相关业务定向 **15 文件/177 项**、runtime 定向 **5 文件/58 项**，合计 **20 文件/235 项**通过；36 个改动代码文件 ESLint 零告警，JSON 解析/重复键检查与 git diff --check 通过。完整类型检查 `tsc --noEmit --incremental false` 通过。未运行生产构建、装配或 Electron/E2E，相关 passes 均保持 false。

原 Coding Owner 检查来源保留：输入偏好最初新增 8+6+23 项、Settings 22 项及相关回归 82 项，修复后 8 套件/82 项；回答复制 13 项、消息 27 项、i18n 18 项；运行时最初全量 55 文件/820 通过/2 跳过，修复后更新检测 28 项及连接卡片 7 项。以上 Owner 数字与 Main 组合验证存在重叠，不累加。

代码来源：`.worktrees/input-preferences` / `codex/input-preferences`、`.worktrees/agent-answer-copy` / `codex/agent-answer-copy`、`.worktrees/runtime-update-check` / `codex/runtime-update-check`。七类上游为 Codex/Claude/OpenCode/Copilot 的 npm latest、Grok stable channel、Devin manifest、Cursor 官方安装脚本 CLI 钉值；Cursor 不使用编辑器版本端点。查询来源可达性沿用 Owner 报告，本轮未重新联网探测。精确版本认证及 `executionEnabled: false` 保留，无本机 CLI 安装更新或真实账号/数据库操作。

以下各项原始缺口说明为开发前基线，当前状态以上述 Main 集成进度为准。

### 输入偏好收口与代码块复制增量（2026-10-28）

- 输入偏好：补稳定的 SSR/客户端水合快照，避免已保存非默认值造成水合不一致；补 Legacy/只读素材卡片证据字段区域，恢复 Enter 下一项及准确提示，增加水合回归覆盖。
- 聊天：新增顶层围栏代码块独立复制，保留缩进/换行，支持流式快照、失败重试和键盘操作；整条回答复制复用剪贴板 hook，中英文词条已接入。复核修复 Unicode 分隔符误转换并补回归覆盖。列表/引用内围栏及缩进代码块暂不提供独立复制；普通已完成回答重新生成仍未实现。
- Main 组合定向检查 10 文件/158 项通过；完整类型检查（不生成增量缓存）、9 个改动代码文件 ESLint、JSON 解析/重复键及差异空白检查通过。两条任务分支分别提交后集成。
- 仅进行开发检查，不启动 Electron、浏览器、生产构建、装配或 E2E；真实中文 IME、桌面剪贴板、重开持久化与窄窗口由用户手动验收。两项 passes 均保持 false，聊天整体仍为 PARTIAL。

### 1. 账号区域自动检测 CLI 更新

- **用户需求**：Codex 等账号/运行时区域增加自动检测更新，参考 [CraftStation](https://github.com/HernanJiang/CraftStation)。
- **已核实缺口**：`AiConnectionsCard.tsx` 挂载时调用 `runtime.detect`，能读取本机版本；`desktop/main/runtime/detector.js` 明确说明 `UPDATE_AVAILABLE` 尚待更新检测实现。`service.js` 的 `getUpdateInfo` 只返回注册表元数据，`executionEnabled: false`。已有状态名、提示和更新命令元数据，不能算已实现在线版本检查或更新执行。
- **参考实现核查**：以 CraftStation `aa336ebf151bb4508cc1f6b339b636f829a9226e` 为参考快照。[更新服务](https://github.com/HernanJiang/CraftStation/blob/aa336ebf151bb4508cc1f6b339b636f829a9226e/src/supervisor/agents/updateAgent.ts)按适配器查询 npm、版本 URL 等上游来源，使用 30 分钟缓存和有界网络超时；[命令解析器](https://github.com/HernanJiang/CraftStation/blob/aa336ebf151bb4508cc1f6b339b636f829a9226e/src/shared/agents/updateResolver.ts)依据自更新能力与安装位置选择更新方式；[设置开关](https://github.com/HernanJiang/CraftStation/blob/aa336ebf151bb4508cc1f6b339b636f829a9226e/src/renderer/views/SettingsOverlay/parts/AgentCliAutoUpdateSection.tsx)还支持默认开启的自动安装更新，手动更新保留。参考项目的自动安装默认值不直接视为本项目已批准需求。
- **待实施验收目标**：自动检查与手动重查共用服务；显示当前版本、可用版本、检查状态/时间；支持缓存、超时、失败重试，网络失败不能显示“已是最新”；各运行时使用真实可用的上游来源，不支持时如实提示。安装更新与自动检查分别表达，实际更新须尊重安装归属、进行中的生成任务，并在完成后重新探测版本及连接状态。
- **必须解决的依赖**：本期流式和结构化能力仍按精确运行时版本认证。`0.164.0 → 0.165.0` 已实际造成“已登录且已配置模型，但不能对话”。更新设计必须同时表达“有新版”和“应用已验证兼容”两个事实，明确更新后的兼容验证/恢复路径；不能一边自动升级，一边仅把用户留在不可用状态，也不能直接取消现有能力检查。

### 2. Agent 实际支持范围

当前 fresh-native/full 下，用户贴出的 AI 自述与生产工具注册和系统提示一致。`src/lib/agent/tools/index.ts` 注册后显式移除 `match_job` 与 `generate_cover_letter`；`src/lib/agent/prompt.ts` 的 `AGENT_CHAT_FRESH_FULL_SECTIONS` 明确声明五项能力，账号运行时的 `accountTurn.ts` 同样通过该注册器构造工具。

| 对话能力 | 当前 fresh-native 状态 | 边界 |
| --- | --- | --- |
| 查询职位列表、最近记录和数量 | 已接通 `list_jobs` | 仅读取授权范围内的数据；具体查询受工具参数限制。 |
| 读取职位详情 | 已接通 `get_job` | 标题、公司、地点、状态、来源、描述等已保存事实。 |
| 添加职位 | 已接通 `add_job` | 用户在确认卡批准后创建职位；不代表真实投递。 |
| 读取简历 | 已接通 `get_resume` | 支持已有简历/版本读取；无内容或歧义时返回真实限制。 |
| 简历评分与评审 | 已接通 `review_resume` | 可生成评分与评审；Resume Variant 没有评审存储列，本期不自动保存到版本，也不改写简历。 |
| 更新职位、管理 Attempt/申请流程、实际投递 | 未开放对应工具 | UI 中有相关业务功能，不代表 Agent 已能调用。 |
| 匹配分析、生成求职信 | 当前模式未开放 | Legacy 工具实现存在，但不作为 fresh-native 能力交付。 |
| 编辑简历/职业素材、读取任务/笔记/活动/设置 | 当前未开放 | 不应由模型自行声称已读取或执行。 |

- **额外确认**：职位详情的 `MatchAnalysisPanel.tsx` 已有独立的 canonical FAST_SCREENING 执行和历史链路，但尚未接入聊天 Agent 的 `match_job`。这是工具接线与业务合同缺口，不能仅改提示词就宣称支持，也不能直接解除旧工具门控而落到 Legacy 写路径。
- **后续目标**：按实际可调用工具维护能力说明；优先评估将现有 canonical 匹配服务接入 Agent，再分别评估职位更新、申请流程和简历编辑的写入合同、用户批准、失败恢复。上述新增能力尚未实施或验收。

### 3. AI 对话交互完善

- **用户需求**：对齐成熟 AI coding 产品的对话交互，至少支持复制 AI 回答。
- **现状**：已具备 Markdown 渲染、流式显示、停止生成、新建/历史对话、上下文选择、工具执行状态与写入确认卡。重新生成目前主要在中断恢复/错误场景提供。
- **明确缺口**：`AgentChatMessages.tsx` 对普通助手文本只渲染 `AgentMarkdown`，没有通用回答操作栏；没有逐条复制回答、代码块复制和普通已完成回答的重新生成入口。该结论来自界面源码核查，未声称本轮运行了交互验收。
- **首个独立交付建议**：普通助手回答增加“复制回答”，明确复制范围（仅该回答的可见文本，不包含隐藏推理、原始工具参数或敏感上下文），保留换行并提供成功/失败反馈与键盘/读屏标签；流式阶段的复制行为需明确。代码块复制和普通回答重新生成作为后续独立增量，重新生成须复用现有对话修订与写入幂等保护，不因重复生成而重复创建职位或其他业务记录。
- **待验收路径**：普通/多段/Markdown/中文回答复制内容正确；剪贴板失败可重试；纯工具结果与空回答不出现无意义操作；重开历史对话后的操作仍可用。此项不包含授予 Agent 编程、终端或文件系统能力。

### 4. 输入偏好（SET-INPUT-PREFERENCES）

- 记录日期：2026-10-28
- 状态：代码及合并前修复已集成 Main，开发检查通过，未完成桌面验收；详见三线开发与 Main 集成进度。
- 优先级：本需求首版 P0；不表示已调整既有 MVP 的整体发布优先级。
- 授权边界：最初仅授权需求记录；随后三窗口启动指令授权代码开发，本轮另获合并 Main 授权；未授权推送、发布或真实数据操作。

#### 一、需求目标

在「设置 → 设备与输入」下新增「输入偏好」模块，统一管理职业资料、网申资料等结构化信息编辑场景中的键盘输入习惯：

1. 允许用户选择 Enter 换行或跳转下一字段。
2. 允许用户控制编辑已有内容时的光标定位方式。
3. 减少连续填写时的鼠标操作。
4. 兼顾快捷提示的新手引导与界面简洁性。

所有设置均为可调整的偏好，不改变业务表单的数据结构与提交逻辑。

#### 二、模块位置

- 一级设置：设备与输入。
- 模块名称：输入偏好。
- 设置数量：4 项。
- 保存方式：本机持久化。
- 生效方式：修改后立即生效，无须重新启动应用。
- 默认配置：首次使用时采用下文定义的默认值。

#### 三、具体设置需求

##### 1. 回车行为

选项：换行（默认）、下一项。

选择「换行」：

- 支持多行输入的字段中，Enter 与 Shift+Enter 均插入换行。
- 单行字段不支持换行，遵循原有字段级行为，不应意外提交整张表单。

选择「下一项」：

- Enter 结束当前字段编辑并移动到下一个可编辑字段。
- Shift+Enter 在支持多行输入的字段中插入换行。
- 最后一个字段按 Enter 结束当前字段编辑，不自动提交整张表单。
- 自动跳过隐藏、禁用或只读字段。
- 字段校验失败时，保留当前输入与焦点，展示错误，不允许静默丢失修改。

中文及其他输入法处于候选词选择或文字组合状态时，Enter 不得触发字段跳转。

##### 2. 进入编辑

选项：按点击位置（默认）、光标放末尾、全选内容。

- 按点击位置：鼠标点击已有文本时，光标尽可能定位在实际点击位置；键盘进入编辑、没有具体点击位置时，默认定位文本末尾。
- 光标放末尾：首次进入编辑状态时，将光标移到文本末尾，便于追加信息。
- 全选内容：首次进入编辑状态时，选中字段已有内容，便于整体替换。

限制：

- 仅在从非编辑状态进入编辑状态时应用。
- 用户已经编辑时，不得重置光标或选区。
- 不得因组件重新渲染、字段保存或状态更新而重复全选。

##### 3. 快捷提示

选项：始终显示、聚焦时显示（默认）、关闭。

- 始终显示：在支持快捷操作的编辑字段旁持续显示简洁提示。
- 聚焦时显示：字段获得编辑焦点时显示，失去焦点后隐藏。
- 关闭：不显示字段级提示，不影响快捷键功能。

提示必须与当前设置同步，且只显示字段实际支持的操作：

- 回车行为为「下一项」：Enter 下一项；支持多行时显示 Shift+Enter 换行。
- 回车行为为「换行」：支持多行时显示 Enter 换行；显示 Tab 下一项。
- 最后一个字段应显示 Enter 结束编辑，不得仍提示“下一项”。

##### 4. 自动聚焦

选项：开启、关闭（默认）。

开启后：

- 用户主动进入支持连续编辑的资料区域时，聚焦首个可编辑字段。
- 首个字段不可编辑时，寻找下一个有效字段。
- 必要时将目标字段滚动至可见区域。

关闭后保持现有焦点行为，不主动移动键盘焦点。

限制：

- 不得仅因页面浏览、路由切换或普通弹窗打开而强制聚焦。
- 不得抢夺其他输入框的焦点。
- 移动端不自动弹出虚拟键盘。
- 仅在明确支持连续资料编辑的区域生效。

#### 四、统一键盘操作规则

以下行为固定提供，不增加独立开关：

| 操作 | 系统行为 |
| --- | --- |
| Tab | 跳转至下一个可聚焦字段 |
| Shift+Tab | 跳转至上一个可聚焦字段 |
| Esc | 退出当前编辑状态，遵循字段原有取消逻辑 |
| Enter | 根据「回车行为」设置执行 |
| Shift+Enter | 在支持多行输入的字段中换行 |
| 输入法候选确认 | 不触发字段跳转 |
| 焦点移动 | 目标字段不在可视区域时滚动至可见 |

额外要求：

- 保持正常键盘无障碍导航，不得出现焦点陷阱。
- 鼠标和键盘编辑方式兼容。
- 不因焦点切换丢失尚未保存的数据。
- 字段切换复用现有保存、校验与错误处理逻辑，不绕过业务校验。
- Tab 在最后一个编辑字段后继续按合理的页面焦点顺序移动，不强制循环回首项。

#### 五、生效范围

首版支持：

1. 职业资料（Career Profile）的直接编辑字段。
2. 网申资料（Application Information）的结构化输入字段，优先接入。
3. 后续其他明确支持连续填写的资料表单可复用相同行为。

首版排除：

- AI 聊天输入框。
- 全局搜索及普通搜索框。
- 下拉选择器。
- 富文本编辑器。
- Markdown 长篇编辑器。
- 其他具有独立键盘交互规则的组件。

设置统一保存，仅对明确接入的组件生效。不得全局拦截 Enter、Tab 等键盘事件。

#### 六、设置存储与状态管理

采用设备级本地偏好：

- 四个设置独立保存，修改后立即生效，关闭、重启后保留。
- 不依赖云端账号同步。
- 未设置、缺失或无效时安全回退默认值。
- 不改变已有职业资料、网申资料的数据内容。
- 优先复用现有本地设置持久化机制，不单独建立新的配置体系。

| 配置项 | 默认值 |
| --- | --- |
| 回车行为 | 换行 |
| 进入编辑 | 按点击位置 |
| 快捷提示 | 聚焦时显示 |
| 自动聚焦 | 关闭 |

#### 七、界面设计要求

在「设备与输入」新增独立的「输入偏好」区域，依次呈现：

1. 回车行为：下拉选择。
2. 进入编辑：下拉选择。
3. 快捷提示：下拉选择。
4. 自动聚焦：开关。

设计要求：

- 保持现有 Settings 组件风格及视觉体系。
- 每项设置包含简短名称和一行说明。
- 不增加不必要的多层菜单或确认弹窗。
- 设置变化即时反映在界面中。
- 遵循中英文国际化规范。
- 兼容桌面窄窗口与响应式布局。

模块底部固定说明：

> Tab 下一项 · Shift+Tab 上一项 · Esc 退出编辑
>
> 中文输入法选词不会触发字段跳转。

Enter / Shift+Enter 说明根据当前选项动态显示，避免与设置冲突。

#### 八、验收标准

| 编号 | 验收场景 | 预期结果 |
| --- | --- | --- |
| AC-01 | 默认进入设置页面 | 四项显示正确默认值 |
| AC-02 | 回车行为切为「下一项」 | Enter 正确跳至下一字段 |
| AC-03 | 多行字段按 Shift+Enter | 正常换行，不跳转 |
| AC-04 | 最后一个字段按 Enter | 结束字段编辑，不提交整张表单 |
| AC-05 | 中文输入法确认候选词 | 不发生焦点跳转 |
| AC-06 | 切换进入编辑方式 | 光标或选区符合所选策略 |
| AC-07 | 正在编辑时修改内容 | 不意外重置光标或选区 |
| AC-08 | 切换快捷提示模式 | 显隐正确，文案与操作匹配 |
| AC-09 | 开启自动聚焦并主动进入支持区域 | 首个有效字段获得焦点 |
| AC-10 | 关闭自动聚焦 | 不主动抢夺焦点 |
| AC-11 | 字段校验失败 | 保留输入并显示错误，不错误跳转 |
| AC-12 | 使用 Tab / Shift+Tab | 焦点顺序正确，跳过无效字段 |
| AC-13 | 重启应用 | 四项设置保持不变 |
| AC-14 | 在聊天、搜索、富文本编辑器中操作 | 原有键盘行为不受影响 |
| AC-15 | 窄窗口打开设置 | 无横向溢出，控件正常可用 |
| AC-16 | 切换中文与英文 | 名称、说明及提示正确国际化 |

#### 九、开发边界与优先级

本需求首版 P0：

- 四项偏好及默认值。
- 本地持久化与即时生效。
- 网申资料及支持的职业资料字段接入。
- 焦点、输入法、保存与校验安全性。
- 快捷提示与中英文支持。
- 必要的单元测试和键盘交互验证。

首版不做：

- 跨设备设置同步。
- 自定义键位映射。
- 自动保存策略配置。
- 全局快捷键重构。
- 富文本编辑器行为覆盖。
- 与具体业务表单无关的输入设置。

#### 十、最终交付目标

用户可选择 Enter 换行或连续填写字段，选择点击位置、末尾或全选的进入编辑策略，控制快捷提示，并决定主动进入编辑区域时是否自动聚焦。

模块应轻量、稳定，符合现有设计，并作为未来结构化表单统一输入偏好的基础。

#### 十一、实施前需明确的交互边界

以下补充用于避免需求间的歧义，不扩大首版范围：

1. 「主动进入编辑区域」应有明确的用户操作入口，例如开始连续填写；单纯打开职业资料页面或切 Tab 不视为该操作。具体入口在开发时结合现有页面确定。
2. Enter「下一项」可在校验失败时保留焦点，但不得据此全局拦截 Tab 或制造焦点陷阱。Tab 离开时依然执行校验、保留草稿并提供可定位的错误反馈。
3. 保存失败与校验失败应分别处理。复用现有自动保存机制，异步保存失败后保留输入、如实反馈并允许重试；不得因切字段或结束编辑卸载组件而丢失草稿。
4. 「立即生效」不表示重置当前编辑中的光标或选区；进入编辑策略应用于下一次进入编辑，自动聚焦应用于下一次主动进入支持区域。

本次仅同步实施台账与功能清单并完成源码/参考项目核查，未新增产品代码、未运行新的构建或 E2E，也未执行任何 CLI 安装/更新。本轮修改随本次提交保留，当前试用窗口和数据继续保留。

## 试用反馈修复与运行时认证（2026-10-28，较早记录）

- 已集成：题库回答默认折叠、完整富文本展开与键盘操作（`20836438`）；AI 预检失败提示可关闭，新预检完成会重新报告失败，关闭提示不解除发送限制；简历导入将运行时/连接不可用与解析失败分开提示（`f6144f29`，合并节点 `81a4ec35`）。
- Codex CLI 升级至 0.164.0 后与原 0.160.0 认证绑定不符，是本次聊天和简历导入被拒绝执行的共同原因。经用户授权，用 gpt-5.6-luna 和合成内容通过生产桌面执行边界验证流式 4 项、结构化 9/9 首次有效；更新精确认证版本，保留其他版本拒绝策略（`39a85ca3`）。随后合成简历通过正式导入 schema 和原文事实校验，未发送真实简历或聊天内容。
- 本次修复：用户消息气泡最大宽度为聊天区的 85%，保持右对齐并允许长链接折行；职位读取透出 JD 原文格式，仅在详情显示和编辑回填时将纯文本安全转义为 HTML 并保留换行。已有 JD 可直接受益，不迁移或改写原文，不改变 Agent 读取原文及已有 HTML 的契约。
- 本次定向验证：AgentChatMessages、agentCanonicalAddJob、jobsAbReadPath、AddJob、JobDetails 共 5 文件/140 项通过，完整类型检查与改动文件 ESLint 通过。未启动新的生产构建或 Electron E2E，不将这些证据视为新界面补丁的桌面验收。
- 隔离试用应用仍为 `39a85ca3` / Build ID `TYS3qOBs2e5Vgc3WX9_et`，复用原隔离数据目录；本次消息布局/JD 换行补丁尚未进入该运行产物。28 项 IN_SCOPE 中仍为 25 项通过，CP-EDIT、SET-DESKTOP、SET-AI-SERVICES 保留 false；无 Push、发布或真实系统自启操作。

## 兼容性收口复审与 Main 集成（2026-10-28，历史阶段）

- 用户已授权复审并提交执行窗口的兼容性收口；本窗口核对原代码差异和 .tmp/compat-closure 中的旧库迁移、五模式双语及托盘证据，未重新启动 Build/装配/E2E。
- CP-LEGACY、JOB-05 已通过并随本次代码纳入 Main，当前 28 项 IN_SCOPE 中 25 项 passes=true。剩余 CP-EDIT（真实 IME）、SET-DESKTOP（真实系统自启）和 SET-AI-SERVICES（真实 AI/BYOK 业务）保留 false，不能据此全项发布放行。
- 原窗口 Windows Electron 证据：旧 Schema 的 55 条迁移经新版真实启动升级至 57 条，明确 skipped-migrated / COMPLETED / AB_ENABLED / resume_v1，旧字段逐列保留、UI 编辑及退出重开通过；Legacy、fresh full/resume-only/disabled、迁移态 resume_v1 的中英文提示和真实服务端写请求通过。首次 Legacy 登录态脚本误判的失败及修正后重测均保留。
- 原窗口托盘 8 项通过：真实关闭/还原/退出、最小化、隔离偏好持久化、文件写失败反馈及重开；系统自启只读状态，未写入真实配置。原构建来源和证据详见 Feature 清单，不把已迁移库当 fresh-native。
- 模式 UI 统一从 dashboard 已解析快照计算职位写入许可；保留 Legacy 与迁移态 resume_v1 兼容写路径，fresh resume-only/disabled 隐藏新增深链/全局/空态入口，补双语说明，不修改或放宽服务端写门。
- 复审补齐只读详情顶部删除、状态徽章及其 Radix 触发器/菜单项、列表自动匹配深链、详情自动匹配/求职信与笔记写入入口。既有内容仍可阅读，provider 外保留 Legacy 默认行为。新增定向回归后，6 文件/181 项、完整 tsc、触及源码 ESLint 通过；这些补充修复只做定向检查，未声称已由原窗口生产构建覆盖。
- 本次不 Push、不发布，不操作真实库、安装版或系统自启，不清理其他 Worktree/证据。并行窗口的 AGENTS.md 与 wiki/index.md 修改保留，不纳入本次提交。

## 最终验收结果（2026-10-27，历史结果）

用户明确启动最终验收后，由主窗口单独串行执行。28 项 IN_SCOPE 中当前 23 项 passes=true（含此前已通过且未受影响的 RM-BIND），5 项保留 false；这不是全项发布放行。

- 构建来源：基线 Main 1dec57fc，已有生产快照的 1,100 个源码/构建输入逐项与 Main 相同，先复用该构建，独立隔离数据根验证各组。实际宿主为 Windows Electron，fresh-native 激活与日志 FRESH_READY/AB_ENABLED/full 均核对，系统代理保持原样，未使用 direct 诊断冒充通过。
- 流程/时间：多轮次与转投、步骤新增/改期/完成/取消、Job/Task/Upcoming/Dashboard 的上海/纽约账户时区联动、历史 unknown 保护及完整 quit IPC 退出重开通过。补测 Electron 960px 渲染视口的对话框与键盘、Task 历史 instant 无关编辑保留通过；不把原生窗口驱动失败记为成功。
- 职业资料：修正旧验收脚本选择器、异步等待与不完整 fixture 后，24/24 检查点通过，含七 Tab、多记录/教育派生、真实剪贴板、遮罩/迟到响应/失败草稿、证件/证明人/附件、技能 Tag 活引用及退出重开。真实中文 IME 未测；合成 composition 事件不替代人工证据。
- 简历：真实素材→编辑/预览→冻结→新草稿隔离→Electron PDF 导出通过；约 77KB/1页，存储字节/hash/认证下载一致，PDF 解析含姓名与 TypeScript。初次重开因测试抢导航失败，补启动请求等待后针对同一 root 复测 3/3 通过，不重新运行已通过的编辑流程，不抹去原失败记录。
- 设置/备份：任务日期创建编辑清空、字典维护、语言与主题保存/失败回滚、隔离桌面偏好、Backup V6 标准/敏感导出、损坏文件拒绝、预检取消、真实 UI 恢复及重开通过。确认标准恢复保留敏感、技能 Tag ID 重映射、敏感恢复还原附件字节；其他字典维护和被引用改名守卫补测通过。
- 实际产品缺陷：JOB-03 的表格/卡片遗漏薪资，现已在 Main e1879aca 补原文/缺失占位并统一渠道本地化；53 项相关 UI 测试、8 项 harness 单测和改动文件 ESLint 通过。该提交重新生产构建（含类型检查/27 页生成）并装配一次，源码摘要 c6e807d81e9e9512ac60235288f4ac24f4bbcd4f059a1aec9af03f3783a6cfa8；新产物的表格/卡片与真正退出重开定向回归通过，不重跑无关业务。构建有既有 unpdf import.meta warning，未阻塞；本轮真实 PDF 已解析验证。
- 未通过项：CP-EDIT（真实 IME）、CP-LEGACY（旧库原生升级）、JOB-05（受限/迁移模式多语言提示）、SET-DESKTOP（真实系统自启/系统重启及完整托盘路径）、SET-AI-SERVICES（真实连接/BYOK/模型业务）。不把未测项设 true；系统配置/真实凭据仍需对应授权或环境。
- Task 性能仍 avg 309.0ms/max 549.2ms，略超 300ms 参考预算的非阻塞观察保留；RM-MATCH/BD-ARCHIVE/REM-V1 延期不变。未发布、未 Push、未操作真实库/安装版/系统自启，未清理旧 Worktree 或证据。

本轮脚本、运行日志与隔离库保留于 .tmp/final-acceptance：流程 root 6aee0d1a-ae0c-49c5-b96e-907a2845523d；职业资料 root b4748ec0-4a82-4594-a64d-7f6f75ca26b3（汇总 electron-results.json 24/24）；简历 root eb59646f-f7f2-4d5e-8050-aa7ab1c9d4bc（checks.json 含原失败，reopen-retest.json 为针对性通过）；设置 root fa647f43-c689-4450-b903-2805d834d7ba；职位 root 1b2b6846-84fb-45b2-92c4-eaa876a0ce11；新构建 builds/1a1c67a5-5c4e-434c-8a9c-76efd9ee714e（初次卡片选择器歧义保留，list-retest.json 为修正后定向结果）。这些是临时证据，不作为待合并产品文件。

## 桌面入口与剩余修改集成收尾（2026-10-27，历史集成记录）

- 用户已授权将认证入口修复、桌面测试基础设施/规则和 W7 服务级测试整合 Main。认证修复提交 ff5f091f：dashboard 未登录跳转移至服务端 layout，保留相对 /signin 和既有 API 鉴权，不放宽 Electron origin 白名单。
- 桌面测试入口补齐隔离环境、动态 CDP、磁盘检查和所属进程清理；复审补上首次/重开导航加载等待，避免测试抢占应用初始 loadURL。失败截图/trace、taskkill 和 CDP 关闭增加超时边界。基础设施单测不能替代真实 Electron 验收，启动链路尚未最终验收。
- W7 服务级测试纳入仓库，使用隔离 fresh-native SQLite 和合成 PDF 字节验证素材、简历版本、冻结保护、artifact 存储及重新连接一致性；修正中途断言失败仍可能记录 allPassed 的问题。
- 执行策略调整：普通开发只做必要定向验证；E2E 仅在用户明确启动最终验收、发布前验证或批准提前定位时执行。W1/W4/W7 原 E2E 接续安排暂停，不自动恢复；同机桌面构建/装配/E2E 串行，由原负责人接续任务收尾。
- 本轮定向组合 37 项、桌面基础设施单测 29 项、主进程 runtime 单测 13 项通过；完整 tsc、改动源码 ESLint 和差异检查通过。未启动生产构建、装配或真实 E2E。所有 Feature passes 保持原值。旧 Worktree 的副本和临时证据保留，不重复集成，不清理或 Push。

## BD-LINKS / Backup V6 已集成 Main（2026-10-27）

用户已明确授权复审、必要修复、提交和 Main 合并。本轮源码提交 `3490cdaa`，合并点 `18c0d482`，追加并发删除与活标签复制回归 `c4c5f1af`；后文未提交/待集成描述均为历史阶段记录。

- BD-LINKS 改为 IMPLEMENTED：真实可空 Tag FK/SetNull/索引、同用户专用通道、活名 UI/复制/面试消费、归档引用禁删、Backup V6 和未来 legacy 真实 FK 保留均已在 Main。skillName/item.title/冻结与投递历史按合同保留，未按名称自动关联或 backfill。
- 复审修复：输入缺失/空 ID 在进入 Prisma 前拒绝；素材关联/解除和关联态文本补丁读查写放入事务；Tag 删除先校验归属再读引用计数，避免跨用户计数信息泄露；UI 捕获网络异常、失败保留选择可重试、阻止重复提交和保存期文本编辑。
- 迁移专项实际发现并修复了故障恢复缺陷：原表重建 SQL 在 DROP 后注入错误会使旧表不可读。新迁移加入显式 BEGIN IMMEDIATE/COMMIT；在隔离数据库用真实 Prisma migrate deploy 再测，正常升级保留原字段/记录/唯一约束/FK/索引，注入相同失败后旧表与数据回滚保留。数据库不变量检查通过；新增永久迁移回归2项通过。
- 组合验证：**37 文件/410 项通过**（备份、技能引用、迁移、素材读写、UI和相关消费者）；追加技能关联/删除并发、活名复制和冻结版本写边界 **2 文件/18 项通过**。Tag actions 连续两次独立运行各 **31 项通过**，当前 mock 模型与 transaction 回调完整，未复现 count 错误，无证据将旧失败归因于生成竞态。
- 完整 tsc、所有改动文件 ESLint（零告警）、现有中英文词条校验与 Git 差异检查通过。隔离验证使用 bd-links-closure 独立依赖/Prisma Client；Main 合并后仅重生成客户端，未对真实数据库执行迁移。
- Windows Electron fresh-native 仍未执行，不把隔离数据库或 UI spec 当作桌面验收；全部 passes 保持原值，仅 RM-BIND 为 true。共享桌面入口由原窗口继续处理，W7 等对应窗口随后同步本次 Main、使用隔离新数据根构建并接续真实导出和退出重开。
- 主目录其他窗口的认证/桌面/E2E Dirty 保留且未纳入提交；未 Push，未删除 Worktree 或验证证据。收尾核对源/集成分支独有提交、Dirty 和进程占用，不擅自清理。

当前下一步是桌面入口交付后的集中用户验收与 W7 完整简历闭环；已有实现不重复开发。原 Task 性能参考观察及 G-A/系统自启授权边界继续保留。

## BD-LINKS 工作区实现交付（2026-10-27，历史阶段）

- 已核对 `codex/bd-links-closure @ f4f0727d`：26 个已跟踪文件修改、3 项未跟踪（测试、迁移目录、SkillTagField）；业务实现尚未提交、未合并。Main 仍为 `f4f0727d`，Schema 尚无技能 Tag FK、备份仍为 V5。
- 已实现范围：可空真实 FK/SetNull/索引；专用关联/解除及同用户校验；关联态拒绝通用 skillName 修改；UI/复制/投影单一活名；含归档引用的 Tag 删除事务守卫；Backup V6 引用重映射与 V1–V5 兼容；未来 legacy 迁移仅保留同用户已有真实 tagId。
- `src/lib/interview/services/hostQueries.ts` 为同一关联显示的读取消费者，新增读取 tag.label 并优先于 skillName；列入本次集成复审范围，不扩大到面试 runtime 或其他业务改造。未改 i18n/wiki，无新增词条需求。
- 新 Migration 为 CareerSkillDetail 表重建，保留现有全部具名列和 materialItemId 唯一索引，新增 tagId 未出现在 INSERT...SELECT 中，存量为 NULL；不称为“物理上仅 ADD COLUMN”。执行窗口报告隔离全迁移链与不变量通过；集成检查须确认原记录/约束保留及失败安全，不操作真实数据库。
- 执行窗口报告：tsc、改动文件 ESLint、定向测试批次 127+93+7 项均通过。本轮仅核对 Git/关键差异，未独立复跑，不冒充组合集成验证。
- **待复核的一次失败**：tag.actions 曾 7 项报读取 count 未定义，重跑通过。当前测试 mock 已包含 careerSkillDetail.count 与 transaction 回调；不能仅凭时间相邻就认定为 Prisma generate 竞态。合并前检查 Mock/Client 隔离、生成目标、并行执行及删除 guard 的失败/并发路径，避免用“重跑过了”掩盖稳定性问题。
- 当前状态为“工作区已实现、Main 待集成、Electron 未验收”；BD-LINKS 在 Feature 清单保持 PARTIAL/false，Backup V6 不提前写成 Main 已交付。W7 仍是服务级/Web 通过、真实 PDF/Electron 退出重开待共享入口交付。
- 下一步为获授权后的合并前复审、必要修复、提交与集成，再接续对应桌面验收。本轮不自动提交或合并，不清理任何 Worktree/证据。

## BD-LINKS 已批准实施与 W7 阶段交付（2026-10-27，尚未新增集成）

- Main 仍为 `f4f0727d`，主目录认证/E2E Dirty 未变。本轮用户已批准 BD-LINKS 真实 FK 与 Backup V6 调整；由原窗口实施。本记录不代表已有新代码集成，不提交或合并代码。
- `codex/bd-links-closure` 已交付 `.tmp/bd-links-closure/proposal.md`，工作区无业务代码改动。结论是复用 Tag 字典、新增 CareerSkillDetail.tagId 可空真实 FK，skillName 保留快照；旧 legacy Skill 行不能直接充当职业素材关系。structuredData 假引用与按名自动关联仍禁止。
- **已批准的范围调整**：本次为原 B6 不新增 Schema 约束的明确例外；新增具名 FK（SetNull + tagId 索引），并升 Backup V6，向后支持 V1–V5，避免旧 V5 恢复代码接受新备份后静默剥离引用。不能把同一版本可解析等同于语义无损。
- 其余推荐语义：关联/解除时显式刷新 skillName 快照，item.title 不联动；关联态显示活 Tag 名，单一名称来源，通用补丁不得绕过关联字段的写入契约；删除计数含归档素材并保护并发，SetNull 仅兜底。冻结简历/已投递快照不随 Tag 改名更新。
- 已批准纳入未来迁移对 legacy Skill 已有 tagId 的保留，但仅限 Tag 存在且 createdBy 等于目标用户；无效或跨用户引用降级 NULL 并保留文本，不按名补链，不重跑已执行迁移。canonical 简历文本导入不自动关联。
- 已批准由 bd-links-closure 单一 Owner 修改 Schema/新 Migration/服务/UI/备份及 tag.actions、TagsTable、job.model、migrator/phase2Auditor；双语词条仍由主协调统一处理。具体合同见 CAREER_SCHEMA_CONTRACT_PROPOSAL.md 的 BD-LINKS 补充；可在原 Worktree 实施，不授权提交/合并/推送或真实数据操作。
- W7：已核对 service-checkpoints.json 与 web-checkpoints.json；执行窗口报告服务级 12 检查点、Web 真实 UI 11/11 通过，本轮未独立复跑。新增 `w7Resume.acceptance.spec.ts` 未提交；服务测试 PDF 是合成字节，只证明 artifact 存储/hash/路径，不能证明生产 PDF 渲染。
- W7 Electron 未执行：真实 PDF 导出、应用退出/重开仍待入口修复交付。当前脚本固定 CDP 9223 和 electron-data 根，实际运行前应改每轮动态 CDP/唯一数据根，同一轮退出重开才复用同一根；复用正式启动器的运行身份检查，不复制未交接认证 Dirty，不重复排查共享桌面壳。
- RM-RESUME 保持 IMPLEMENTED、passes false；RM-BIND 不受影响。原窗口保留活跃 handoff 与证据，不清理，不重复执行已有 Web 路径来充当桌面证据。

## W3/W5/W6 Main 集成与问题修复（2026-10-27）

用户授权提交、合并并检查问题。本轮已将 W3 `b2579202`、W5 `c1465700`、W6 `3702f87f` 集成 main，组合源码节点 `5ce3eaff`；`jobs.deadline` 双语词条提交 `2c8ccd9f`。后文工作区交付记录保留为历史，不代表这些代码仍待集成。

### 已修复并验证

- W3：Legacy Agent 不再公布或接受 DateOnly 新字段，不制造午夜 Instant，旧 offset Instant 契约保留；canonical 表单跨账户时区禁用宿主快捷日期、可靠读取 dirty；新写裸 Instant 一律 fullInstant，不按整分钟边界推断精度；补齐表单与 Agent 的 DateOnly 往返，以及真实隔离 SQLite 写入到 Upcoming 的时区/逾期联动回归。补齐表单 effect 的上下文依赖。
- W5：职位名称/地点/渠道改名在事务内检查本人 canonical 引用（含归档），有引用则明确拒绝，保护文本快照与计数/查找；未引用项可编辑，真实 FK 的标签/活动类型沿用原身份。新增同 key 标题不再隐式改名，渠道原样保存保留原 value。对话框异常保草稿，保存中禁止编辑/取消/关闭。
- 7 处旧 /unavailable/i 断言已改为现有消息常量的精确断言，错误码/门控未放松，相关套件通过。
- W6：不可用能力只隐藏编辑，不清除已有分配；模式切换、异步加载和原配置保留回归通过。
- 隔离集成目录组合验证 **26 文件/574 项全通过**；最终表单依赖修复后 AddJob 全套 **42 项通过**。完整 tsc、改动文件 ESLint（最后一处 Hook 告警已修复）、新增词条检查及 Git 差异检查通过。未运行完整 Build 或桌面 E2E，不宣称已通过完整应用验收。

### 当前剩余任务与边界

- W1–W6 代码均已集成；该阶段 BD-LINKS 尚为 PARTIAL；后续已按补充合同实现并集成，见文首。
- canonical 文本快照暂采用“引用中禁止改名”保护，不提供级联改名/快照迁移；系统渠道仍禁改。此限制不代表历史记录会自动随字典改名。
- W7 简历完整用户路径验收尚未执行；其他窗口仍待对应 Windows Electron fresh-native 验收及最终跨模块重开闭环，全部 passes 保持原值（仅 RM-BIND 为 true）。
- 桌面入口由另一窗口排查；真实系统自启操作另获授权；G-A 证据仍需技术核实。Task 性能参考仍为 avg 309.0ms/max 549.2ms，不将其冒充全部指标达标。
- 主目录认证/桌面 E2E 的 Dirty 均保留，未纳入本轮提交。未 Push，未操作真实数据库，未清理 Worktree/运行目录。相关源分支与集成分支的独有提交、未提交内容及进程占用在收尾核对。

## W3/W5/W6 工作区交付记录（2026-10-27，历史状态）

本轮按用户要求更新任务清单，不提交/合并功能代码，不启动下一任务。Main 仍为 `8b4ac777`；三分支均基于该提交且只有未提交修改。已核对分支、HEAD、Git status/diff；下列测试数字来自执行窗口报告，本轮未独立复跑，不作为组合构建或功能验收证据。

| 窗口 | 代码/Main 状态 | 验证报告 | 当前剩余 |
| --- | --- | --- | --- |
| W1 流程联动 | 已集成 Main | 原组合定向检查通过 | W3 接入后的跨模块闭环、Windows Electron 实际联动与重开 |
| W2 Task | 已集成 Main | 5k 排序分页正确；后续优化 avg 309.0ms/max 549.2ms | 桌面验收；300ms 参考预算仍略超，非新增开发阻塞 |
| W3 职位 | 工作区代码交付，未提交/集成 | 报告 18 文件/385 项和 tsc 通过 | 复审/集成、jobs.deadline 词条、Agent Legacy 契约核对、最终联动与桌面验收 |
| W4 职业资料 | 已集成 Main | 原组合与隐私专项检查通过 | 职业素材技能字典复用缺口交接、完整桌面验收 |
| W5 基础数据 | 维护 UI/action 已交付，引用闭环仍 PARTIAL，未提交/集成 | 报告 436 项相关测试通过、tsc/lint 通过；另报告 7 个既有失败断言 | 字典改名后的 canonical 关联/计数、职业素材 SKILL 复用、失败断言、复审/集成与桌面验收 |
| W6 设置 | 最小诚实态修复已交付，未提交/集成 | 报告 149 项与 tsc/lint 通过 | 复审/集成、桌面保存/失败/重开与 Backup V5 恢复验收；真实系统自启操作另获授权 |
| W7 简历 | 已有实现，尚未执行本轮验收任务 | 继续复用 RM-BIND 通过证据 | 素材→创建/复用→编辑/冻结→预览/导出→重开验收，不重复开发 |

### 必须保留的实际缺口

1. **BD-LINKS 职业素材技能复用**：CareerSkillDetail 仍只维护 skillName 文本。W5 的 structuredData.tagId 方案仅是建议，未批准；职业资料合同禁止以该 JSON 承载规格内结构化事实，不能把 JSON ID 当作真实 FK。由单一 Career Owner 核对最小合规方案；若必须调整字段合同或 Schema，再明确收口，不擅自落库。
2. **字典改名后的 canonical 关联**：JobOpportunity.title/locationText/sourceLabel 是文本快照，现有按 label 映射的计数会在改名后失配。禁止自动批量改写机会文本；需核对稳定身份映射/保留历史快照等兼容方案，不能因 Legacy FK 路径正常就宣称 canonical 也通过。
3. **7 个文案断言失败**：W5 报告 jobtitle/jobLocation/jobSource.actions 与 dictionaryAbReadPath 的 /unavailable/i 与实际产品文案不符。Main 源码确实仍有这些断言；基线可复现性和精确失败数待定向复核，不为让测试过而改回产品错误文案或放松门控。
4. **W3 集成事项**：补 jobs.deadline（en Deadline / zh-CN 截止日期）；复用已集成的 Upcoming 读取合同，仍需最终联动验证。Agent legacy 分支把 deadlineOn 映射本地午夜的改动须在集成复审时核对 Legacy instant-only 冻结边界，不能直接算验收通过。
5. **共同桌面验收**：另一窗口继续负责认证/桌面壳/E2E 入口；本轮三窗口均未完成 Windows Electron fresh-native 验收，所有 Feature passes 原值不变。不得将 Web 单测、tsc 或 report 的“完成”替代实机证据。

### 后续工作顺序（待执行）

- 核实并修正 W5 七个失败断言，同时收口 BD-LINKS 两项实际缺口；与 W3/W6 的集成前复审按文件 Owner 独立推进。
- 获授权后提交/集成 W3/W5/W6，在组合代码上做最小充分验证；Main 的 implementationStatus 仅在实际集成后更新。
- 桌面入口可用后，原各窗口接续对应验收，W1 补跨模块时间闭环；W7 执行简历验收，不再另拆通用验收窗口。
- 延期仍为 RM-MATCH、BD-ARCHIVE、REM-V1；G-A 证据与系统自启授权边界不变。Worktree/运行目录均保留，未授权不清理。

## Main 后续修复与下一批（2026-10-27，历史调度记录）

- 修复 `applicationProfile.materialPartialWrite.spec.ts` 四处 ActionResult 成功分支窄化，失败直接使测试失败；Main 当前完整 tsc 与修复后的组合源码 tsc 均通过。
- Task 到期排序仅在同一次调用内复用相同日历日的账户时区日终计算，保留排序/分页与 unknown 语义，不使用跨账户/时区缓存。新增跨时区重复调用排序回归。
- 4 个相关测试文件共 91 项通过；改动文件 ESLint 和差异检查通过。单独读取 5k/200 页性能结果：avg 309.0ms、max 549.2ms/页；较此前报告改善，但平均仍略高于 300ms 参考预算，不宣称全部性能指标达标。
- 下一批 W3（职位）、W5（基础数据）、W6（设置）可在独立 Worktree 并行。W3 不修改字典专属 action/admin UI；W5 不修改 AddJob、Job 专属读写与 Settings；W6 不修改字典/Task/Job/备份底层。共享时间工具、Upcoming/overview、Schema、双语词条和 wiki 继续由对应单 Owner 协调。
- 桌面验收入口仍由另一窗口排查。下一批先完成各自代码和定向验证，入口修复可用后再做对应隔离 Windows Electron fresh-native 验收；不让多个窗口重复修改认证、桌面壳或 E2E 启动器，也不以 Web 验证替代桌面通过。

## W1/W2/W4 Main 集成记录（2026-10-27，后续修复见上）

用户授权先合并、由另一窗口排查桌面验收。代码已于本轮集成至 main：W1 `e9a57b00`、W2 `fa672934`、W4 `0c524a37`，组合合并点 `fe8713d0`；职业资料双语补齐提交 `6aaab974`。

- W1/W2：P-PROC、P-TASK 和 Upcoming/Dashboard 消费者已实现；W1 仍待 W3 的截止日期写入接线及最终跨模块验收。P-JO 仍未开发，不提前核销。
- W4：Schema、新 Migration、Backup V5、服务/UI/复制与敏感保护已集成。职业资料继续补完整桌面用户路径证据；现有代码不重复开发。
- 合并前定向复审修复了时区改期漂移、Dashboard 混排遗漏、Upcoming 加载失败、unknown 精度推断、Task 跨区快捷日期、学历误派生、敏感明文迟到响应、5MB 上传入口与恢复类型校验。
- 隔离集成 Worktree 的组合验证：18 个测试文件、264 项全部通过；双语新增 literal/detail label 键检查、Git 差异检查通过。组合 tsc 仍只有 `applicationProfile.materialPartialWrite.spec.ts` 54/106/169/191 的 4 处既有 ActionResult 窄化错误，未修改这些无关测试；不宣称全量类型检查通过。
- W2 原报告 5k 分页 avg 547.6ms、max 1615.8ms/页，高于 300ms 参考预算；本轮未重复性能测试，不扩项优化。
- Windows Electron fresh-native 完整验收仍未通过，由另一窗口排查；本轮不启动桌面 E2E，不将代理作为已证实的唯一根因。全部未验收 passes 仍为 false。
- Main 已重新生成 Prisma Client，仅生成客户端，未对真实数据库执行 Migration。认证/桌面 E2E 的既有 Dirty 不纳入本轮提交；源 Worktree、运行目录和进程均保留，不擅自清理。

当前后续执行：W3 职位；W5 基础数据；W6 设置；W7 简历；W1/W2/W4 仅余实际缺口修复、交接与验收收尾。G-A 和相关 Worktree 状态在实际集成前核对。

## 合并执行方案（2026-10-27，当前调度口径）

按用户要求合并同类工作：原 9 个开发/集成工作包与 7 组验收合并为 **7 个执行单元**，另保留当前主协调窗口。以下为窗口分配，优先于后文分包和旧 Owner 表；功能范围、时间语义与验收条件不变。7 是计划任务数，不是同时运行数或完成时间承诺，真实阻塞可能影响安排。

| 单元 | 同一窗口负责的范围 | 完成标准与依赖 |
| --- | --- | --- |
| W1 流程与时间联动 | P-PROC、PROC-UPCOMING、共享时间工具、Upcoming/Dashboard；PROC-ATTEMPT/PROC-UX 真实路径验收 | 先交付缺失的共享接口；完成 Task/Job 交接后的跨模块时间验证与流程桌面验收，未接入前不提前结项 |
| W2 任务 | P-TASK 开发、列表排序分页、5k 数据验证和任务桌面验收 | 依赖 W1 提供必要共享接口；向 W1 交接 Task DTO/读取合同，不写 overview |
| W3 职位 | P-JO 开发及 JOB-01～05 桌面验收 | 同时核对新增/编辑、CSV、Agent、历史保护；向 W1 交接 Job 截止日期合同 |
| W4 职业资料 | Schema/Migration、Backup V5、服务、UI、复制/隐私及 CP 全组验收 | 同一负责人按底层→服务→UI/复制顺序实施，保护旧资料；W7 新素材引用验收依赖此单元完成 |
| W5 基础数据 | BD-CORE、BD-LINKS 缺口及 BD-INLINE 桌面验收 | 合并维护、引用和就地创建，复用现有 CRUD；职业素材引用与 W4 顺序交接共享文件 |
| W6 设置 | AI 设置最小接线；语言/时区/外观/桌面偏好/备份恢复验收 | 备份新格式验收在 W4 交付后完成；不改 W4 的备份源文件。真实系统配置操作另获授权 |
| W7 简历 | RM-RESUME 完整桌面验收、素材复用检查 | 复用已通过的 RM-BIND 证据，仅受影响时回归；新增素材闭环待 W4 完成 |

- 每个窗口负责实现、必要定向验证、真实桌面验收与本任务缺陷修复，不再独立开 7 个通用验收窗口。已有实现只补缺失证据。范围外问题记录，不扩项。
- W1 唯一写入流程 action/service/DTO/表单/Timeline，以及 upcomingReadModel.ts、UpcomingContainer.tsx、overview.ts 和 datetime 共享工具；W2/W3 只交接各自合同。旧表中的主集成负责人对这些源码的职责交给 W1。
- W4 唯一写入 Schema/Migration、备份和职业资料源码；W5 若需修改职业素材组件/服务，先交给 W4 接入或等其明确交接，不能同时改。W6 仅消费备份，不改其实现。
- 当前主窗口负责协调、双语词条、wiki 状态和获授权后的 Git 集成；执行者提交词条需求，由主窗口分批写入。验收使用含当轮词条和共享接口的构建；不要求另开协调/Review 窗口。
- 建议最多同时运行 3 个执行窗口。第一批 W1/W2/W4，W2 所需新增共享接口未就绪时先处理独立部分；第二批按空位安排 W3/W5/W6，W7 最后完成新增素材闭环。不为并行数拆出额外任务。
- 各单元可在不同批次继续同一任务，依赖等待不计新窗口。W1/W6 的跨包验收在依赖代码可用后继续；当前未经授权的提交/合并不因依赖自动发生。
- 旧版兼容证据和旧 Worktree 状态核实由主窗口在相关集成前处理，不单独计执行单元。本次仅更新调度计划，不启动任何开发窗口。

## 2026-10-27 时间合同与并行归属冻结

用户已批准 `DATETIME_CONSUMER_CONTRACT_PROPOSAL.md` §9 D1–D9 全部采用 A，以及该文档文首执行边界；以下为当前执行口径，优先于后文历史基线。

- P-TZ 存储、设置 UI、原子保存及客户端/服务端读取已实现，消费者直接复用；完整桌面验收待完成，不重新开发设置。
- 时间语义：纯日期写 *On，不制造 instant；计划时间须含时刻；unknown 原样保留且未修改不重写。Job/Task 本期表单仅日期输入，保留 Instant 数据和接口能力。
- Task 纯日期按用户时区日终排序、NULL 排尾、同值 priority desc/id asc；全量必要字段排序后分页。Upcoming 纯日期从当天开始提示、当天结束才逾期，两种排序边界不得混用。
- 静态条件下验证分页不漏不重，新增/改期/时区切换后重置列表。5,000 条合成数据记录实际性能，300ms/页为参考预算。
- 首批 P-PROC 与 P-TASK 两线并行；主集成负责人先补必要共享接口，再统一接入 Upcoming/Dashboard 和词条并定向验证。P-JO 后续接入，不自动启动。
- Process Owner：流程 action/service、DTO、各日期表单及 Timeline；Task Owner：任务类型、表单、读写、排序分页和展示。
- 主集成负责人：upcomingReadModel.ts、UpcomingContainer.tsx、overview.ts、datetime 共享工具、双语词条、功能状态清单；Process/Task/Job 不并行写这些文件。
- 各开发线使用独立 Worktree 和隔离数据；具体执行者在任务分配时指定。文档冻结不等于功能实现、Main 集成或验收通过，不授权 Git 提交/合并或真实数据操作。

## 2026-10-27 职业资料与本期范围决策（已批准）

用户已批准职业资料推荐方案，详细合同见 `CAREER_SCHEMA_CONTRACT_PROPOSAL.md` 文首及 §10。

- CP-SCHEMA：以合同逐字段清单为准，取消“精确 35 列”数量约束；新增语言明细、证明人、附件模型；新 Migration 与 Backup V5 同步，保留旧数据与兼容边界。
- 基础字段增加“保密”、独立手机号区号和家庭地址；毕业日期/预计标记与排名分项独立；科研信息关联教育，独立科研经历继续保留。
- 最高学历/学位只按明确已取得事实分别派生：博士后是经历，非在读不代表已毕业，MBA 名称不自动证明学历。信息不足保持未知，在读单独标注，历史毕业届次保留兜底；派生不回写。
- 主页复用 linksData；叙述内容复用 notes/evidence；techStack 独立字段；AI 应用技能复用 SKILL；本期不做教育与奖项的记录级关联。
- 证明人单条维护并归档；附件证件照限 JPG/PNG，证明材料另支持 PDF，单文件 5MB；证明人和附件统一敏感保护并纳入恢复非空检查。
- SET-AI-SERVICES 纳入本期 P1 的最小范围：仅交付已有业务必需的连接与模型分配配置，其余明确不可用，不扩展新 AI 能力，保留登录和 BYOK 隔离。具体必需项按现有生产消费者确认，属于实施核对。
- RM-MATCH 明确延期；与已延期的 BD-ARCHIVE、REM-V1 一并不阻塞本期 MVP，未实现/未验收状态不变。
- 本轮只更新计划、合同和 Feature 范围，不启动功能开发，不标记任何新增 passes，不授权提交、合并、发布或真实数据操作。

## 当前完整待办清单（2026-10-27）

统计按 `MVP_FEATURES.json` 的 Feature ID：共 31 项，本期 28 项（1 项已验收、27 项未完成验收），延期 3 项。Feature 与执行工作包不是一一对应，以下合并共享实现，避免重复开发。

### 工作包进度（W1–W6 均已集成，未完成项见文首）

| 工作包 | 对应 Feature | 剩余范围 |
| --- | --- | --- |
| 职业资料 Schema/备份/服务 | CP-RECORDS、CP-PRIVACY | W4 已集成字段/三模型、新 Migration、Backup V5、权限与敏感边界；剩余完整桌面验收 |
| 职业资料 UI 与复制 | CP-EDIT、CP-RECORDS、CP-PRIVACY、CP-COPY、CP-LEGACY | W4 已集成新字段/对象、教育派生和复制保护；剩余实际路径验收，发现缺口再修复 |
| 流程时间消费者 P-PROC | P-PROC | W1 已集成时间/精度/zone 的读写与展示；待最终跨模块和桌面验收 |
| 任务时间消费者 P-TASK | P-TASK | W2 已集成；5k 正确性通过，性能实测高于参考预算；待桌面验收 |
| 职位时间消费者 P-JO | P-JO | W3 已集成，Legacy 兼容/词条/定向联动已核对；待完整桌面验收 |
| 共享时间集成 | PROC-UPCOMING、P-TZ、P-PROC、P-TASK、P-JO | W1 共享接口及 Upcoming/Dashboard 已集成；待 W3 交付和最终联动验收 |
| 基础数据维护 | BD-CORE | W5 已集成，canonical 引用中禁改保护及失败断言已修复；待完整桌面验收 |
| 基础数据引用 | BD-LINKS | 既有引用、canonical 改名保护及职业素材 SKILL 真实 FK 已集成；待完整桌面验收 |
| AI 设置最小接线 | SET-AI-SERVICES | W6 已集成不可用能力诚实态修复，已有配置复用；待桌面验收 |

### 已有实现，安排缺失的验收

- 职业资料：CP-UI、CP-EDIT、CP-RECORDS、CP-COPY、CP-PRIVACY、CP-LEGACY。已有 Web 证据继续复用；补新能力与 Windows Electron 持久化/退出重开、剪贴板及真实输入法等缺失证据，不重做已实现功能。
- 职位：JOB-01～05。Windows Electron 验证草稿撤销、真实投递保护、薪资/渠道/来源、CSV、受限提示；JOB-05 迁移态详情提示仍需补测。
- 流程：PROC-ATTEMPT、PROC-UX、PROC-UPCOMING。验证多 Attempt、跨职位转投、事件新增/改期/完成/取消、窄窗口/键盘、归属与 Upcoming 联动及重开。
- 日期时区：P-TZ、P-PROC、P-JO、P-TASK。验证切换时区、DateOnly 不漂移、unknown 不重写、混排分页及跨模块一致性。
- 基础数据：BD-CORE、BD-INLINE、BD-LINKS。补维护/引用缺口后的桌面保存重开与跨模块复用验收；就地创建不重复开发。
- 设置：SET-LOCALE、SET-APPEARANCE、SET-DESKTOP、SET-DATA-PRIVACY、SET-AI-SERVICES。补完整 Settings 桌面路径、失败反馈、退出重开及备份恢复；系统自启涉及真实配置的操作另获授权，不能用模拟证据代替。
- 简历：RM-RESUME。素材→创建/复用→编辑→冻结→预览/导出→重开；RM-BIND 已通过，本轮不重复开发，仅受影响时回归。

默认功能验收使用隔离 Windows Electron fresh-native；Legacy/迁移态另建隔离场景。Web 与定向测试证据不冒充完整桌面验收，桌面 E2E 基础入口不等于全部业务已通过。

### 技术核实与延期

- G-A：核实旧版兼容/真实环境启用的必要证据，不阻塞隔离开发；不是待用户重新选择的产品范围。
- 旧 Worktree：仅在相关接续或集成前核对独有提交、Dirty 和进程；未获清理授权不移除。
- 延期 3 项：RM-MATCH（匹配）、BD-ARCHIVE（全品类归档）、REM-V1（本地持久提醒）。

执行顺序：首批共享接口 + P-PROC/P-TASK 两线；随后 P-JO 与跨模块集成。职业资料可在独立文件归属下另行排期，先 Schema，再服务/UI/复制；基础数据和 AI 设置按 P1 排期。所有功能开工仍等待明确任务授权。

## 本次集成进度（2026-10-26，历史记录）

以下为基线之后的代码集成状态；后文基线记录保留为历史背景，不代表这些功能仍需重复开发。

| Feature | 代码状态 | 已完成 | 剩余验收 |
| --- | --- | --- | --- |
| CP-UI | IMPLEMENTED | 七 Tab、显隐管理、UserSettings 原子持久化；保存期间串行切换 | 隔离环境真实保存、刷新、重启及历史数据保留 |
| JOB-05 | IMPLEMENTED | 用户提示去除内部实验术语，保留原有保护逻辑与错误码，中英文词条同步 | 实际用户路径触发并核对提示 |
| BD-INLINE | IMPLEMENTED | 就地创建后立即选中、去重与失败反馈，共享选择器读取新选项，标签池同步 | 隔离数据库创建、保存和重开 |

- 集成后的定向测试通过；修复 Tab 并发隐藏与共享选择器缓存问题后，受影响测试复测通过。定向 Lint、差异检查及独立代码复审通过。
- 三项 `passes` 仍为 `false`，代码集成与测试结果不替代完整功能验收。
- 下一项 Coding 建议为 CP-EDIT：现有个人信息仍需整组进入编辑并手动保存，应补齐字段直接编辑、自动保存、状态反馈与失败重试。

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
- 该缺口不得写成“只需复用验收”；P1 是否接通最小 canonical Match 或延期，已于 2026-10-27 批准延期，不将完整 Deep Match 当作首版 P0 前提。

### A8. Reminder — MISSING（条件纳入）

- 无用户提醒持久化模型与送达链路；`src/lib/scheduler` 仅服务 Automation 抓取。按范围规则不阻塞首版 MVP。

### A9. i18n / 其他横切

- `en.json` + `zh-CN.json` 双语完整（各 ~124K 行级词条）；中文界面已是默认交付物。残留工程术语见 JOB-05。
- Dashboard V2 概览/分析板、GettingStarted、ActivityCalendar 已并入 Main；`overview.ts` 当前由主集成负责人负责（2026-10-27 冻结）。

---

## B. Remaining MVP Work

> 复用既定工作包 ID；优先级 P0 > P1；每项给出可复用基础、最小范围、验收条件。

### B1. CP-V1 Career Profile 七 Tab（P0，最大增量）

- 可复用：`CandidateProfile`/`CandidateSensitiveInfo`/`CareerMaterialItem`+Detail/`JobSearchPreference`、`sensitiveMask`、`applicationCopy`、现有四 Tab 工作区与“复制本条”、教育 `gpaValue/gpaScale/rankText`、userSettings patch（Tab 显隐持久化可挂 settings JSON）。
- 最小范围：
  1. **CP-SCHEMA（单 Owner）**：按 2026-10-27 冻结的逐字段清单与 M2 三模型；Synthetic Migration、Backup V5、敏感字段安全审查；不动真实 DB。
  2. **CP-UI**：七 Tab 壳 + 「管理 Tab」显隐持久化；Tab 顺序与命名按冻结合同。
  3. **CP-EDIT**：字段行式直接编辑 + 自动保存（保存中/已保存/失败三态，失败保留输入可重试）；无全页编辑模式与保存按钮；Ctrl+Z 不劫持。
  4. **CP-RECORDS**：复用现有教育 GPA/排名与多条素材 CRUD，差量补齐科研、论文、语言多条及实习、项目、获奖、其他（证书/AI 技能/主页/证明人/补充）的七 Tab 呈现与所缺字段。
  5. **CP-COPY**：以已有“复制本条”为起点，补齐字段/组/记录/Tab/网申汇总五级一致体验；敏感项默认排除且单字段复制需显式操作。
  6. **CP-LEGACY**：旧 CandidateProfile/素材数据回填呈现；求职意向 Tab 从导航移除但数据保留。
- 验收：重启后七 Tab 数据一致；敏感字段默认掩码且不进批量复制；自动保存失败可恢复；Tab 显隐持久化生效；已有 GPA/排名可正确回填，新字段与多条经历可维护。

### B2. DT-CONSUMERS DateTime 消费者（P0，与 B1 并行）

- 前置：时间合同及 Owner 已于 2026-10-27 冻结（见文首及合同文档）；P-TZ 已实现，复用现有接口。历史 DT-11 R1 记录不作为未经核实的当前阻塞，遇到实际相关缺陷再处理。
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
- **Match（未交付，2026-10-27 已批准延期）**：canonical fresh 用户入口和生产执行链路缺失，本期不开发，也不标记通过。未来重新纳入时另行授权最小链路范围；完整 Deep Match 不属于当前任务。
- **首版 P0 边界**：完整 Match/Deep Match 不自动阻塞职业资料—职位—投递—流程—时间—简历复用闭环。

### B8. REM-V1 提醒（条件纳入）

- 仅在持久化模型 + Windows 通知送达链路完整后开放；不展示假功能。不阻塞 B1–B7。

---

## C. Dependencies & Parallel Work

### C1. 真实依赖（阻塞面最小化）

| 依赖                                    | 影响面                                                       | 处理                                                         |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| DT-11 R1 复审 + OD-A/B/C + 接口冻结     | P-TZ/PROC/JO/TASK 的写入合同                                 | 合同与 Owner 已冻结；共享接口按需补齐后两线并行                                 |
| CP-SCHEMA Gate（M1/M2 + Backup + 安全） | 仅 CP-V1 的 Schema 部分                                      | CP-UI 原型与复制层可先施工，落库前合并                       |
| Settings 宿主归属裁定                   | SET-MVP、P-TZ 设置项、桌面偏好 UI                            | 先处置 wave1-set01/03/08 未提交改动；保留现有 IPC            |
| P-PROC/PROC-UX 共享文件归属             | 两项任务的 ProcessStepDialog、Timeline、application action/service | 同一 Process Owner 控制共享文件的实施/交接，不并行改同一文件 |
| G-A 旧版门禁                            | 真实环境启用 canonical 写入                                  | 阻塞真实启用，不阻塞隔离开发                                 |

### C2. 可并行轨道（接口冻结后）

- 轨道 A（DateTime）：合同已冻结且 P-TZ 已实现；主集成负责人先补必要共享接口 → P-PROC/P-TASK 两线并行 → 集成与 P-INT；P-JO 后续接入，不自动启动。
- 轨道 B（Career）：CP-SCHEMA（单 Owner）∥ CP-UI/EDIT/RECORDS/COPY（Schema 冻结前可基于现有模型开发壳与非新增字段）。
- 轨道 C（Job UX）：JOB-04/05 + 一致性复核，独立小批量。
- 轨道 D（Process UX）：PROC-UX/PROC-ATTEMPT 已实现，安排缺失验收，不重复开发；`ProcessStepDialog`、Timeline 与 application action/service 必须与 P-PROC 由同一 Process Owner 修改或明确顺序交接，不允许两个 Agent 同时改这些文件。
- 轨道 E（Settings/BasicData/Resume 收口）：SET-MVP、BD-V1、Resume 收口按真实文件所有权并行；Match 是否进入本期由 Owner 选择。

### C3. 共享文件单一 Owner（必须显式指派）

| 文件/区域                                                    | 建议 Owner                                      | 现存冲突                                                     |
| ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| `prisma/schema.prisma` + migrations + `src/lib/backup/`      | Schema/Integration Owner                        | CP-SCHEMA 唯一写入口                                         |
| `src/lib/career/upcomingReadModel.ts`                        | 主集成负责人（含岗位截止读取合同）             | P-JO/P-PROC 经由此合同，不直接改                             |
| `ProcessStepDialog.tsx`、`ApplicationTimelineTab.tsx`、关联 application action/service | **Process Owner**（同时协调 P-PROC 与 PROC-UX） | 共享 UI/写路径只允许单 Owner 修改；其他 Agent 通过接口或明确交接接入 |
| `src/actions/dashboard/overview.ts`                          | 主集成负责人                                      | Dashboard/Upcoming/Task 三路交汇                             |
| `src/app/dashboard/settings/page.tsx` + `SettingsSidebar.tsx` + 各 Settings 卡片 | Settings Owner                                  | **wave1-set01/03/08 未提交改动必须先裁定**                   |
| `src/i18n/messages/{en,zh-CN}.json`                          | 主集成负责人分批集成                             | JOB-05/CP/DT/PROC 文案统一汇入                               |
| `src/actions/job/*`、`jobOpportunityAdapter.ts`              | Job UX Owner                                    | P-JO 写入共享，需协调                                        |
| `src/lib/datetime/*`                                         | 主集成负责人                                  | 复用原语，必要新增接口由单一 Owner 实施                                     |

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
2. 时间决策以 2026-10-27 冻结合同为准；G-A 旧版本兼容门禁仍需技术证据核对，仅影响真实环境启用。
3. 桌面托盘/最小化行为未逐文件核验（标记 UNVERIFIED）。
4. wave1-set01/03/08 未提交改动与 Main 的关系需归属裁定（疑似部分已被后续集成取代）。
5. Career M1/M2：2026-10-27 已批准按职业资料合同逐字段实施，取消 35 列数量约束。
6. Match：2026-10-27 已批准延期，不阻塞其他 MVP P0 Coding。
7. 2026-10-26 独立复审 Git 状态未见此前 7 个已跟踪删除文件；历史差异原因无证据，不据此判断当前产品状态。
