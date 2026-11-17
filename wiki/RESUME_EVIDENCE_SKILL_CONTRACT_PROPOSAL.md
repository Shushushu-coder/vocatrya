# 简历证据深挖：技能内容与结果合同（首版提案）

> **状态：首版提案。尚未批准、尚未加载、尚未实施。**
>
> 本文只交付 Vocatrya **产品内置技能**的可执行内容与结果合同。它不是给开发 Agent 安装的 Codex／Devin 宿主技能，不写入 `~/.codex/skills`，不使用 skill-creator，不引入第三方脚本或依赖。
>
> 本轮不实现产品运行时、UI、持久化、Schema 或备份，不调用写工具，不修改 `AgentChatProvider`、聊天路由、工具注册表、权限设置或运行时。原生会话协议、权限桥和运行时事件由并行窗口负责；本文只列出运行时必须提供的最小能力，并把未定接口标为依赖。
>
> 基线：`main@071f48e031609b131a65a7df4f20739b720743bc`。工作分支：`codex/resume-evidence-skill`。工作树：`.worktrees/resume-evidence-skill`。
>
> 标注：
>
> - 【已有事实】：在该基线上核对过的代码或已提交文档。
> - 【建议方案】：本技能首版内容，供批准后加载。批准前不得当作已上线行为。
> - 【依赖】：要等另一合同或现有入口才能落地，不把本文留成空壳。
> - 【待裁定】：不阻塞内容包成立，但实施前需要人决定。

- 技能标识：`vocatrya.skill.resume-evidence-deep-dive`
- 技能版本：`0.1.0-proposal`
- 结果合同版本：`resume-evidence-result/v0.1`

## 1. 用户能拿到什么

从用户**这一次明确交出的一段经历**出发，逐轮核对个人贡献、行动、难点、结果、时间和证据，形成一份**待用户确认的职业素材草稿**。

用户在结束时能看到：

- 哪些句子是用户说过的，或来自本次授权材料；
- 哪些仍待确认、互相冲突，或被用户跳过；
- 哪几条可以映射成现有 `CareerEvidence` 事实点；
- 哪几句只是建议表达，还没有变成事实；
- 若以后要保存，必须再确认什么。

对话、阶段总结和这份 JSON **都还不是**正式职业素材。保存要等用户另一次明确确认，并由应用调用既有入口。模型口头说“已保存”无效。

## 2. 位置与边界

### 2.1 它是什么

【已有事实】`wiki/EXTENSIONS_IMPLEMENTATION.md` §6 将「简历证据深挖（Grill Me 改造）」列为首批产品技能：逐轮追问个人贡献、成果指标和项目细节，形成用户确认的素材。同节要求 Skill 提供流程、模板和规则；复用 Insight／Pilot／Reflect，不为每个技能新建 Agent；工具授权仍遵守角色合同。Grill Me 只借鉴持续追问，针对求职重写，不复制开发工具中的指令和依赖。每轮围绕一个重点，允许跳过、暂停和查看阶段总结。

【已有事实】Grill Me 参考入口见[上游技能](https://github.com/mattpocock/skills/blob/main/skills/productivity/grill-me/SKILL.md)。许可证结论来自内容窗口报告，本次协调核验未重新确认；后续若复制上游内容须重新核对对应版本及许可。本文只沿用 §6 已记录的交互原则（一个重点、可跳过、可暂停、可看阶段总结）。**不复制**该 `SKILL.md` 的指令、步骤或依赖。压力面试属于用户主动选择的面试训练，不属于本技能。

【建议方案】「经历表达训练（STAR）」仍是相邻技能。本技能用同一组事实槽位核对经历，产出职业素材草稿，不把完整面试口述稿当作主结果。是否把 STAR 技能并入本技能，见 §11。

### 2.2 它不做什么

- 不扫描职业资料库、简历库、附件、敏感表、Notion 或本机目录。只使用 §3 的本次授权包。
- 不运行匹配分析，不写 `MatchAnalysis` 或 `MatchEvidenceLink`。可选 JD 只用来决定先问哪个缺口。
- 不开启面试练习会话，不打分，不恢复已隐藏的面试练习板块，不撤销 EXT-INTERVIEW-WEB 的暂停。
- 不改简历版本图。建议表达不是 `ResumeExpression`。用户以后若把已保存的证据拖入简历，仍走现有简历工作台。
- 不收集模型内部推理，不索取证件号、证明人、家庭成员、紧急联系人或账号密钥。用户主动粘贴了这些内容时，结果里只保留与这段经历直接相关的职业事实，并在 `pending` 标明多余敏感内容未采纳。
- 不把“必须量化”当作要求。没有指标时保留定性结果。
- 用户接受一句表达，只表示这句话可以作为建议措辞。首版只输出草稿，`saveGate.saveAuthorized` 与 `persisted` 固定为 false。结果 JSON 中任何模型生成的布尔值均不构成授权或写入证明；后续保存必须另由应用确认动作绑定目标、字段及草稿版本，并以服务端回执显示结果，不修改该草稿为已保存事实。

### 2.3 可复用的相邻能力

| 能力 | 基线上的事实 | 本技能如何对待 |
| --- | --- | --- |
| 职业素材 | `CareerMaterialItem` + 类型 detail + `CareerEvidence`。服务见 `CareerMaterialService` | 结果映射到这些已有字段，不新建业务表 |
| 资料页写入口 | `createApplicationMaterial`、`updateApplicationMaterial`、`addApplicationMaterialEvidence`（`src/actions/applicationProfile.actions.ts`） | 将来只在用户确认保存后由**应用**调用。证据入口把 `kind` 固定为 `FACT`，只接收 `content` 与可选 `metricText` |
| 资料页读与归档 | `archiveApplicationMaterial`；`EMPLOYMENT` 与 `CUSTOM` 在资料页为只读（`careerMaterialInput.ts`、`materialFields.ts`） | 本技能不调用归档。这两类只能产出 `draft_only`，不能假装资料页能改正文 |
| 服务层 `confirm()` | `CareerMaterialService.confirm` 把 `verificationStatus` 写成 `USER_CONFIRMED`；资料页 Action 未暴露该方法 | 技能里的“用户确认”不调用它，也不把状态写成 `USER_CONFIRMED` |
| 简历导入证据种类 | 文案有 `RESPONSIBILITY`／`ACTION`／`ACHIEVEMENT`／`METRIC`／`SKILL_USAGE`／`OUTPUT`／`OTHER` | 只作为结果里的 `semanticRole`。走资料页新增证据时，落库 `kind` 仍是 `FACT` |
| 快速匹配 | `runFastScreening` 阅读职业材料与 JD，写入匹配历史 | 不调用。JD 缺口不是匹配结论 |
| 面试出题 | `questionPlanning.ts` 把已有职业材料压缩成事实行供出题 | 不调用。本技能的中间结果也不能直接送去出题 |
| Agent 工具 | `AGENT_ROLE_TOOL_ALLOWLIST` 中 Insight 可匹配／评审简历，Pilot 可添加职位；两套提示都写明当前不能编辑 career evidence（`prompt.ts` 的 `limitations`） | 不把现有工具当成保存入口，不扩大角色白名单 |

## 3. 输入与开始条件

【建议方案】一次技能运行只处理一段经历。运行时负责把下面的授权包交给技能；交付方式属于【依赖：原生会话适配窗口】。包的字段是内容合同，不是会话协议。

```json
{
  "skillId": "vocatrya.skill.resume-evidence-deep-dive",
  "skillVersion": "0.1.0-proposal",
  "experienceText": "2024 年暑期我在北海市集科技做青禾超市履约小程序，把超时订单的人工复核从当天积压改成按小时处理。",
  "existingMaterial": null,
  "purpose": "resume_bullet",
  "targetJdText": null
}
```

| 字段 | 规则 |
| --- | --- |
| `experienceText` | 用户选定或粘贴的原文。空白且没有 `existingMaterial` 时，只请用户给出这一段经历，然后等待 |
| `existingMaterial` | 可选。仅当用户点名这一条已有素材时填入：`id`、`type`、`title`、`startDate`、`endDate`、`isCurrent`、`notes`、该类型 detail 的已有列、未归档 `evidence`（`id`、`kind`、`content`、`metricText`）。不附带其他素材 |
| `purpose` | `resume_bullet`、`interview_story`、`career_record`、`unspecified` 之一。它只影响建议表达的长度，不改变事实标准 |
| `targetJdText` | 可选。空字符串视为未提供。没有 JD 时照常深挖，不向用户索要 JD |

开始时技能必须先复述授权范围：本次只使用这段经历、用户随后的回答，以及用户一并给出的用途和 JD。`authorization.fullLibraryScanned` 固定为 `false`。

信息不足时保持 `pending` 或 `skipped`。不得用行业常情、岗位名称或模型记忆补写公司、时间、人数、比例、职责或个人贡献。

用户随后的话进入 `sourceRefs`，`kind` 为 `user_turn`。纠正、换方向、跳过和结束都是正常输入，不是异常。

## 4. 逐轮流程

【建议方案】阶段只有五个：`intake`、`clarifying`、`summarizing`、`ready_to_stop`、`stopped`。

### 4.1 事实槽位与提问顺序

每一轮先选**一个** `focus`。顺序如下，已确认或已跳过的槽位跳过：

1. `conflict`：授权材料与用户新说法不一致，或两条用户说法同时成立。
2. `personal_contribution`：成果分不清是个人、团队还是混合。
3. `action`：还没有用户本人做了什么。
4. `result`：还没有结果；定性结果即可。
5. `difficulty`：只有难点会改变行动的含义时才问。
6. `time_range`：材料里没有起止，且用户没跳过。
7. `evidence_pointer`：用户提到报表、上线记录、评审时，可以问它叫什么；不知道就跳过。
8. `jd_relevance`：仅当本次带了 JD，且已有事实里有一句可能被 JD 误读时才问。

`organization`、`role`、`context` 只在原文缺失且影响标题时询问，不单独展开背景调查。

### 4.2 每轮问题数量

- 默认 **1** 个问题。
- 仅当第二个问题是在拆开“这是你做的，还是团队做的”时，才允许 **2** 个。
- 不一次发出整张问卷，不重复已经回答或已经跳过的槽位。
- 用户说“不知道”“不方便说”“没有数”“跳过”时，写入 `skipped`，本轮结束该槽位。
- 澄清轮次达到 6 轮仍未自然停止时，必须进入 `summarizing`，请用户纠正、换方向或结束。6 轮是本版技能规则，不是新的产品设置（是否改成设置见 §11）。

### 4.3 用户控制

| 用户意图 | 技能行为 |
| --- | --- |
| 纠正 | 新说法成为候选事实。与旧说法冲突时两边都保留在 `conflicts`，不覆盖原文摘录 |
| 换方向 | 更换 `focus`。旧槽位保持原状态 |
| 跳过／不知道／不方便 | 写入 `skipped`，不再追问，除非用户重新打开 |
| 查看阶段总结 | 进入 `summarizing`，不新增问题 |
| 结束 | 进入 `stopped`。已有内容保留，缺失保持待确认 |

### 4.4 何时可以停止

同时满足下列条件时，`session.sufficiency.met = true`，阶段变为 `ready_to_stop`，并给出阶段总结：

- 没有 `resolution = open` 的冲突；
- 个人贡献已经是 `personal`、`team` 或 `mixed`，或者该槽位已跳过；
- 至少有一条个人行动，或者行动槽位已跳过；
- 结果已有定性或定量陈述，或者结果槽位已跳过；跳过指标不等于跳过结果；
- 时间范围已有，或者已跳过。

证据指针不是停止的必要条件。没有量化指标也可以停止。

用户主动结束时即使条件未满也要停止：`stopReason = insufficient_user_stop`，`sufficiency.met = false`，缺什么写在 `missingSlots`。条件已满且用户结束或接受停止时，`stopReason = sufficient`。条件已满但用户尚未结束时，阶段停在 `ready_to_stop`，`stopReason` 仍为 `null`。

开放冲突未解决时不得标记 `sufficient`。若用户在冲突仍开放时结束，`stopReason = insufficient_user_stop`，冲突保持 `open`。

## 5. 事实与表达规则

五类认识地位不得混用：

| 地位 | 存放 | 含义 |
| --- | --- | --- |
| `user_stated` | `confirmedFacts` 及贡献／行动／结果 | 用户在本轮对话里明确说过 |
| `source_material` | 同上 | 来自本次 `experienceText`、已有素材或已有证据的原文 |
| `pending` | `pending` | 还不能当事实 |
| `suggested_wording` | `suggestedExpressions` | 技能建议的说法，每句必须列出 `basisFactIds` |
| `assumption` | `assumptions` | 模型推断。`promoted` 在用户用自己的话确认之前保持 `false`，且不得进入 `confirmedFacts` |

数字、公司、时间、职责和个人贡献必须带 `sourceRefs`。来源是稳定引用：已有行用数据库 `id` 填 `stableId`；粘贴文本和对话用本结果内的 `src-*`，并在摘录中保留原句。`src-*` 只在这一份结果里有效，不是新的数据库主键。

建议表达里出现的每个数字、公司、时间和职责，都要能在 `basisFactIds` 指向的已确认事实上找到。找不到就删掉该措辞，或把整句留在 `assumptions`。

冲突展示左右原文和引用，向用户提问。用户明确指出旧稿错误并给出替代事实，也属于选定，不要求再次认可同一句事实。用户选定之后：胜出的句子进入 `confirmedFacts`，`conflicts[].resolution = user_resolved`，落败的原文仍留在冲突记录里。

阶段总结使用同一套字段，不另写一套“正式素材”。`artifactKind` 固定为 `skill_result_draft`。

## 6. 结果字段

顶层对象就是技能每一轮可以刷新的草稿。字段含义如下；五个完整实例在 §12。

| 字段 | 含义 |
| --- | --- |
| `contractVersion` | 固定 `resume-evidence-result/v0.1` |
| `skillId` / `skillVersion` | 固定为本文件文首标识与版本 |
| `artifactKind` | 固定 `skill_result_draft`。禁止把该对象直接插入 `CareerMaterialItem` |
| `exampleKind` | 设计示例用 `design_example`。真实运行用 `model_output`。两种都不是质量验收结论 |
| `session.stage` | §4 的五个阶段之一 |
| `session.stopReason` | `null`、`sufficient`、`insufficient_user_stop` |
| `session.roundIndex` | 已经发出的澄清轮次数，从 0 起 |
| `session.focus` | 当前槽位；停止后为 `null` |
| `session.sufficiency` | `met` 与仍缺的 `missingSlots` |
| `authorization` | 复述本次范围。`scope` 为 `single_experience`，`fullLibraryScanned` 为 `false` |
| `sourceRefs` | `pasted_text`、`existing_material`、`existing_evidence`、`user_turn`、`optional_jd` |
| `confirmedFacts` | 仅指有本次用户陈述或来源材料支持的事实，不代表外部核实或已获保存授权。`slot` 见 §4.1；`epistemic` 只能是 `user_stated` 或 `source_material` |
| `pending` | 待确认。`reason`：`unknown`、`not_disclosed`、`unquantified`、`conflict`、`not_yet_asked` |
| `conflicts` | 左右原文、引用、`open` 或 `user_resolved` |
| `contributions` / `actions` / `outcomes` | 从已确认事实抽出的贡献、行动、结果。`outcomes.quantified = false` 时 `metricText` 为 `null` |
| `suggestedExpressions` | 建议表达。`saveAuthorized` 默认 `false` |
| `assumptions` | 未确认推断 |
| `skipped` | `user_skip`、`user_unknown`、`user_private`、`no_metric` |
| `materialMapping` | 首版operation固定draft_only；futureOperation/futureEntrypoints仅为后续保存候选映射，不是待执行调用 |
| `saveGate` | 措辞接受意向及未来需确认事项；首版saveAuthorized/persisted固定false，所有模型字段均不具授权效力 |
| `next` | `ask`、`summarize`、`offer_stop`、`wait_for_save_confirmation`、`hand_to_user`；`questionBudget` 为 0、1 或 2 |

`materialMapping.evidenceToAdd` 的每一条：

- `kindOnWrite` 固定 `FACT`；
- `semanticRole` 取 `responsibility`、`action`、`outcome`、`metric`、`skill_usage`、`output`、`context`、`other`，不写入数据库 `kind`；
- `userAcceptedAsEvidence` 为 true 只表示用户同意把这句当作事实点预览，仍不等于保存授权；
- `content` 使用用户确认过的事实句。未被接受的建议表达不得放进这里。

`materialMapping.verificationStatusOnWrite` 固定 `USER_AUTHORED`，`originOnWrite` 固定 `USER`。这与 `CareerMaterialService.create`／`addEvidence` 的现有写入一致；`update` 只重设 origin 为 USER，保留既有 verificationStatus，不能用该意向字段覆盖现有状态。

## 7. 映射到现有职业素材

【已有事实】当前类型为 `EMPLOYMENT`、`INTERNSHIP`、`PROJECT`、`RESEARCH`、`PUBLICATION`、`COMPETITION`、`CAMPUS_ACTIVITY`、`EDUCATION`、`AWARD`、`SKILL`、`CERTIFICATION`、`LANGUAGE`、`CUSTOM`（`src/lib/career/identities.ts` 的 `CAREER_MATERIAL_TYPE`）。父行可承载 `title`、`startDate`、`endDate`、`isCurrent`、`notes`。资料页 detail 白名单以 `careerMaterialInput.ts` 的 `APPLICATION_PROFILE_DETAIL_FIELDS` 为准；`structuredData`、`companyId`、`tagId` 不走通用补丁。

【建议方案】映射只填用户已确认、且列名在白名单内的值。

| 技能内容 | 现有落点 |
| --- | --- |
| 标题 | `CareerMaterialItem.title`。`LANGUAGE` 的标题由 `language` 与 `examOrLevel` 组成，沿用 `resolveApplicationMaterialTitle` |
| 起止与是否至今 | `startDate`／`endDate`／`isCurrent`。技能只输出用户明确提供的 `YYYY-MM-DD` 或 `null`；只有年月时保留来源文字，不补具体日 |
| 组织、角色、学校、奖项等 | 对应 detail 列。列不在白名单则放入 `blockedWrites`，不写入 `notes` 兜底 |
| 已确认的行动、结果、指标 | 将来调用 `addApplicationMaterialEvidence`：`content` 为事实句，`metricText` 为用户原话中的指标字符串，`kind` 由该 Action 写成 `FACT` |
| 建议表达 | 不落库。用户若在简历工作台自行改写，那是版本图上的 `expression.content`，不回写素材 |
| 技能标签 | 本版不调用 `setApplicationSkillTag` |
| 归档、物理删除 | 不使用。资料页“删除”实际是 `archiveApplicationMaterial` |

首版 `operation` 统一为 `draft_only`、`callsExistingEntrypoints` 为空。下列仅记录 `futureOperation` 和 `futureEntrypoints` 的后续保存意向，不是首版执行计划：

- 用户点名了可编辑的已有素材：`futureOperation = update_existing`，只提交有变化且已确认的父字段和 detail，证据只追加。
- 没有已有行，且类型属于资料页可创建集合（教育、研究、发表、语言、实习、项目、奖项、竞赛、校园活动、技能、证书）：`futureOperation = create_new`。
- 类型是 `EMPLOYMENT` 或 `CUSTOM`，或 detail 含白名单以外的列：`futureOperation = draft_only`，`blockedWrites` 写明原因。已有 `EMPLOYMENT` 行可以被用户选中阅读，但资料页不能改正文；本技能同样不发明新的写接口。
- 没有任何已确认事实：`evidenceToAdd` 为空，`futureOperation = draft_only`。

草稿中的 null 表示未知/不适用，绝不能直接展开为 Action 参数。未来更新已有行时只发送已确认变化字段；清空字段须有独立、明确的用户清空意图；未知的 isCurrent 应省略而非传 null。

将来若应用执行保存，顺序是：需要新建时先 `createApplicationMaterial`，再用返回的 id 逐条 `addApplicationMaterialEvidence`。该顺序**尚未实现**，也不是一个事务。失败时不得报告整包已保存。本轮不调用这两处。

`CareerEvidence` 上还有 `metricValue`／`metricUnit`／`sortOrder`。资料页 Action 不接收它们。本版全部留空，不在技能侧拆数字，避免同一指标出现两套口径。

## 8. 可执行提示

【建议方案】下面三块是加载器应原样使用的技能文本。它们不引用任何厂商私有工具名。加载器如何注册、如何把文本放进会话，是【依赖：原生会话适配窗口】。

若运行时没有材料输入、连续对话或结果展示，技能不得开始。若没有“用户确认后调用既有写入口”的应用动作，技能仍可对话并产出 JSON，且必须保持 `saveGate.persisted = false`，并说明保存还不可用。

### 8.1 技能主提示

```text
你是 Vocatrya 的产品技能「简历证据深挖」（vocatrya.skill.resume-evidence-deep-dive，0.1.0-proposal）。你的工作是把用户本次交出的一段经历核对成待确认的职业素材草稿。

你只使用本次授权包里的 experienceText、optional existingMaterial、purpose、targetJdText，以及用户在这次对话里的后续回答。授权包以外的职业资料、简历、附件、敏感身份信息和外部系统都不在范围内。没有 JD 时继续工作，不要索取 JD。

认识地位只有五类，不能混写：
- user_stated：用户在对话里明确说的话。
- source_material：授权包原文里已经写明的话。
- pending：尚未能当作事实。
- suggested_wording：你建议的表达。每句都要指向已确认事实。
- assumption：你的推断。在用户用自己的话确认之前，它不能进入已确认事实。

公司、时间、职责、个人贡献和数字必须带上来源引用。来源可以是已有素材或证据的 id，或本份结果里的临时引用。不要用常情补写缺失细节。没有量化指标时保留定性结果，不要为了好看而编造数字。

每轮只处理一个重点。默认只问一个问题；只有在拆开“你个人做的”和“团队做的”时才可以问第二个。不要一次抛出整张问卷，不要重复已经回答或已经跳过的点。

用户可以纠正、换方向、跳过、要求总结或结束。用户说不知道、不方便说或没有数时，记录为跳过并停止追问该点；跳过指标不等于跳过结果。明确否定旧稿并给出替代事实属于事实纠正，保留两侧原文并记user_resolved，不再要求重复确认；只有仍有事实歧义才继续澄清。

满足以下全部条件后，给出阶段总结并告诉用户可以停止：没有未解决冲突；个人贡献已说明或已跳过；至少有一条个人行动或行动已跳过；结果已说明或已跳过；时间已说明或已跳过。证据名称不是停止条件。澄清满 6 轮时必须总结，并请用户决定是否结束。

阶段总结和最终 JSON 都是草稿，artifactKind 为 skill_result_draft。用户认可一句表达，只记录 suggestedExpressions[].userAcceptedWording 的措辞接受意向。首版的 saveAuthorized 和 persisted 必须始终为 false。用户提到保存只能作为后续意向；你不能生成授权或保存回执，必须明确说明本技能只产出草稿。

不要收集内部推理，不要索取证件、证明人、家庭、账号或与这段经历无关的敏感信息。不要调用或声称调用了匹配、面试训练、简历改写、归档或外部笔记。
```

### 8.2 阶段规则

```text
阶段：intake → clarifying → summarizing → ready_to_stop → stopped。

intake：复述本次只使用哪一段经历、用途和可选 JD。列出已经能当作 source_material 的事实，以及还空着的槽位。若经历文本和已有素材都为空，只请用户贴出这一段，然后等待。不要在 intake 追问成果。

clarifying：按冲突、个人贡献、行动、结果、会改变行动含义的难点、时间、证据名称、与可选 JD 的误读风险这个顺序，选择第一个尚未确认且尚未跳过的槽位。问完等待用户。

summarizing：用已确认、待确认、冲突、跳过、建议表达五段话总结。明确这还不是职业资料里的记录。然后问用户要纠正、换方向、继续，还是结束。本阶段 questionBudget 为 0。

ready_to_stop：停止条件已满足。展示总结，并把 next.recommendation 设为 offer_stop。用户要继续时，只追问用户新指出的点。

stopped：不再追问。输出完整结果。条件已满且用户结束时 stopReason 为 sufficient；条件未满时为 insufficient_user_stop。

任何阶段都接受纠正。纠正若制造冲突，回到 clarifying，focus 为 conflict。
```

### 8.3 追问与总结模板

```text
开始：
这次只使用你给出的这段经历{，以及你附上的目标岗位说明}。我不会打开其他职业资料。已经写明的内容我会当作原材料；没有写明的公司、时间、职责、个人贡献和数字，我会标成待确认，不会补上。你可以随时纠正、换个方向、跳过，或说到这里为止。

追问（个人贡献）：
你写到「{excerpt}」。我想先分清你自己做的部分：这件事里哪一段是你动手完成的？如果是几个人一起做的，你负责哪一块？不知道或不方便说，可以直接跳过。

追问（没有指标）：
结果已经可以保留为「{qualitative}」。你如果记得可以核对的数字或口径，用你自己的说法补充；没有这组成绩，或现在不方便说，我们就保持定性描述。

追问（冲突）：
这里有两句还不能并成一件事。材料里是「{left}」。你后来的说法是「{right}」。哪一句为准，或者两句各自指什么？

阶段总结：
可以当作事实的是：{confirmed}。
还不能当作事实的是：{pending_or_conflict}。
你选择跳过的是：{skipped}。
建议这样写（仍是建议，不是已保存的素材）：{expression}。
{stop_line}
若要写入职业资料，需要你再确认一次保存。这次总结不会自动保存。
```

`stop_line` 在条件已满时写“这些已经够形成一版待确认素材，可以停在这里。”条件未满时写“还缺：{missingSlots}。你也可以现在结束，缺的部分会继续标成待确认。”

## 9. 确认与保存边界

【建议方案】将来的保存分成三步，本轮只定义，不执行。

1. **预览。** 应用展示 `materialMapping` 里将要写入的标题、日期、detail 和 `evidenceToAdd`，并同时展示待确认、冲突、跳过和建议表达。建议表达默认不在写入清单里。
2. **修改。** 用户可以改预览中的句子、去掉某条证据、或返回对话继续纠正。修改后的预览仍是草稿，未来确认必须绑定目标、内容与版本；修改后旧确认失效。
3. **确认保存。** 用户明确同意写入后，应用才调用 §7 的既有 Action。首版草稿的`saveGate.persisted`始终为false；将来另由应用持有的保存回执显示成功，不接受模型修改布尔值作为依据。调用失败或入口不存在时，向用户展示未写入，不重试成第二次新建，除非用户再次确认。

权限沿用现有入口，技能文本不能放宽：

- 调用者必须是已登录用户，且通过职业资料写门控与 `assertResumeV1Writable`；
- 只能改该用户自己的素材；当前 requireOwned 仅核对 id/userId，并未排除归档行，未来保存编排必须显式拒绝已归档目标，不能假定既有 Action 已提供该校验；
- 资料页不提供 `EMPLOYMENT`／`CUSTOM` 正文编辑，detail 白名单也排除它们；这不代表服务层或所有父字段调用均会拒绝。未来编排应主动保持 `draft_only`，不以绕过 detail 参数的方式写入；
- 不写 `CandidateSensitiveInfo`、证明人、附件字节、简历版本、匹配历史、面试复盘或 Notion；
- 不调用 `archiveApplicationMaterial`，不调用 `CareerMaterialService.confirm`。

【已有事实】现有 Agent 提示写明不能编辑 career evidence。因此保存不应当成模型自己的工具调用。应用上的确认动作才是调用方。该动作如何接到 Codex／Devin 会话，是【依赖：原生会话适配窗口】。在依赖落地前，技能只产出 `persisted: false` 的草稿。

## 10. 运行时最小能力

【依赖：原生会话适配窗口】负责如何加载。本技能要求运行时最终能够做到下面四件事，但不规定消息格式、事件名或权限桥：

| 能力 | 没有这项时 |
| --- | --- |
| 接收 §3 的单段经历授权包 | 不开始深挖 |
| 在同一次任务里连续对话，并保留已确认、跳过和冲突 | 不把上一轮总结写成新的素材 |
| 向用户展示 §6 的结果草稿 | 不声称已形成职业资料 |
| 后续阶段的用户确认后保存动作（非首版必要能力） | 首版始终只展示草稿，`persisted` 为 false |

技能版本以本文 `0.1.0-proposal` 为准。加载器需要把版本和 `skillId` 一起交给会话，避免执行另一份提示。最小加载输入对应 [原生会话提案](./NATIVE_SESSION_ADAPTER_CONTRACT_PROPOSAL.md) 的 NativeSkillContentV1：requiredCapabilities 只声明 multi_turn_user_input，instructions 为本文§8；单段授权包与草稿展示仍由宿主提供。不要求 business_write。两份提案均待批准，原生首切片不加载技能，当前不能宣称已执行。

## 11. 协调核验后的推荐边界（待批准）

首版推荐只交付草稿内容：保存、事务、USER_CONFIRMED、metricValue/metricUnit 和只读素材写路径均后置；6轮为阶段总结阈值、不新增设置；STAR保持独立。下表保留后续议题，不把它们列为首版内容交付阻塞。

## 11.1 后续议题

| 编号 | 事项 | 本版临时做法 |
| --- | --- | --- |
| D1 | 技能挂在 Insight、Pilot 还是 Reflect | 不新建角色，不改白名单。保存不走现有工具 |
| D2 | 澄清 6 轮是否做成用户设置 | 先写在技能规则里 |
| D3 | 是否把 STAR 表达训练并入本技能 | 本版不并入，只共用事实槽位 |
| D4 | `EMPLOYMENT`／`CUSTOM` 将来用哪条已有写路径 | 本版 `draft_only`，不新开接口 |
| D5 | 是否暴露 `confirm()` 来写 `USER_CONFIRMED` | 本版不暴露，写入状态保持 `USER_AUTHORED` |
| D6 | `metricValue`／`metricUnit` 是否要填 | 本版只使用 Action 已接收的 `metricText` |
| D7 | 新建素材与多条证据是否要放进一个事务 | 本轮不实现；未实现前不得报告整包成功 |
| D8 | 原生加载与确认动作的接口 | 留给并行窗口；本文内容不依赖该接口才能阅读和执行 |

## 12. 设计示例

以下经历、公司、产品和数字都是合成资料。对话是合同示例，用来固定结果形状和停止条件。**它们不是真实模型输出，也不代表模型质量验收已经通过。** 每份 JSON 的 `exampleKind` 都是 `design_example`，`saveGate.persisted` 都是 `false`。

### 12.1 信息充分，且有用户给出的指标

用户粘贴：“2024-07 至 2024-09，我在北海市集科技实习，做青禾超市履约小程序。我把超时订单的复核从每天收工时一次，改成值班同学按小时处理。”

- 技能：复述范围，并问个人做了什么。
- 用户：“复核规则和值班表是我写的。同事负责门店培训。上线后那两个月，超时未复核订单从每天大约 40 单降到 10 单以内，数来自周会记录。”
- 技能：贡献、行动、结果、时间和证据名称都已齐，没有冲突。告知可以停止。
- 用户：“可以停在这里。”

停止理由：`sufficient`。指标来自用户原话，并保留“大约”“以内”和“周会记录”，没有改成精确值。月份没有被补成具体日。

```json
{
  "contractVersion": "resume-evidence-result/v0.1",
  "skillId": "vocatrya.skill.resume-evidence-deep-dive",
  "skillVersion": "0.1.0-proposal",
  "artifactKind": "skill_result_draft",
  "exampleKind": "design_example",
  "session": {
    "stage": "stopped",
    "stopReason": "sufficient",
    "roundIndex": 1,
    "focus": null,
    "sufficiency": {
      "met": true,
      "missingSlots": []
    }
  },
  "authorization": {
    "scope": "single_experience",
    "fullLibraryScanned": false,
    "purpose": "resume_bullet",
    "targetJdRef": null
  },
  "sourceRefs": [
    {
      "ref": "src-paste",
      "kind": "pasted_text",
      "label": "用户粘贴的经历",
      "stableId": null,
      "excerpt": "2024-07 至 2024-09，我在北海市集科技实习，做青禾超市履约小程序。我把超时订单的复核从每天收工时一次，改成值班同学按小时处理。"
    },
    {
      "ref": "src-turn-1",
      "kind": "user_turn",
      "label": "用户补充贡献与指标",
      "stableId": null,
      "excerpt": "复核规则和值班表是我写的。同事负责门店培训。上线后那两个月，超时未复核订单从每天大约 40 单降到 10 单以内，数来自周会记录。"
    }
  ],
  "confirmedFacts": [
    {
      "id": "fact-org",
      "text": "实习组织是北海市集科技，事项是青禾超市履约小程序。",
      "slot": "organization",
      "epistemic": "source_material",
      "sourceRefs": [
        "src-paste"
      ],
      "attribution": "unknown"
    },
    {
      "id": "fact-time",
      "text": "时间是 2024-07 至 2024-09。",
      "slot": "time_range",
      "epistemic": "source_material",
      "sourceRefs": [
        "src-paste"
      ],
      "attribution": "unknown"
    },
    {
      "id": "fact-action",
      "text": "用户本人编写了复核规则和值班表。",
      "slot": "action",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "personal"
    },
    {
      "id": "fact-team",
      "text": "门店培训由同事负责。",
      "slot": "personal_contribution",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "team"
    },
    {
      "id": "fact-metric",
      "text": "上线后的两个月，超时未复核订单从每天大约 40 单降到 10 单以内。",
      "slot": "metric",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "mixed"
    },
    {
      "id": "fact-pointer",
      "text": "数字来自周会记录。",
      "slot": "evidence_pointer",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "unknown"
    }
  ],
  "pending": [],
  "conflicts": [],
  "contributions": [
    {
      "id": "contrib-1",
      "statement": "用户负责复核规则和值班表；门店培训不是用户的贡献。",
      "attribution": "personal",
      "actionIds": [
        "action-1"
      ],
      "outcomeIds": [
        "outcome-1"
      ],
      "sourceRefs": [
        "src-turn-1"
      ],
      "epistemic": "user_stated"
    }
  ],
  "actions": [
    {
      "id": "action-1",
      "statement": "编写超时订单的复核规则和值班表，使复核改为按小时进行。",
      "actor": "personal",
      "sourceRefs": [
        "src-paste",
        "src-turn-1"
      ],
      "epistemic": "user_stated"
    }
  ],
  "outcomes": [
    {
      "id": "outcome-1",
      "statement": "上线后两个月，超时未复核订单从每天大约 40 单降到 10 单以内。",
      "quantified": true,
      "metricText": "每天大约 40 单降到 10 单以内",
      "attribution": "mixed",
      "sourceRefs": [
        "src-turn-1"
      ],
      "epistemic": "user_stated"
    }
  ],
  "suggestedExpressions": [
    {
      "id": "expr-1",
      "text": "编写青禾超市超时订单的复核规则和值班表，推动复核改为按小时处理；上线后两个月，超时未复核订单从每天大约 40 单降到 10 单以内（周会记录）。",
      "basisFactIds": [
        "fact-org",
        "fact-action",
        "fact-metric",
        "fact-pointer"
      ],
      "epistemic": "suggested_wording",
      "userAcceptedWording": false,
      "saveAuthorized": false
    }
  ],
  "assumptions": [],
  "skipped": [],
  "materialMapping": {
    "operation": "draft_only",
    "careerMaterialItemId": null,
    "type": "INTERNSHIP",
    "parent": {
      "title": "北海市集科技 · 青禾超市履约小程序",
      "startDate": null,
      "endDate": null,
      "isCurrent": false,
      "notes": null
    },
    "detail": {
      "organizationName": "北海市集科技"
    },
    "evidenceToAdd": [
      {
        "content": "用户本人编写了复核规则和值班表。",
        "metricText": null,
        "kindOnWrite": "FACT",
        "semanticRole": "action",
        "basisFactIds": [
          "fact-action"
        ],
        "userAcceptedAsEvidence": false
      },
      {
        "content": "上线后的两个月，超时未复核订单从每天大约 40 单降到 10 单以内，数来自周会记录。",
        "metricText": "每天大约 40 单降到 10 单以内",
        "kindOnWrite": "FACT",
        "semanticRole": "metric",
        "basisFactIds": [
          "fact-metric",
          "fact-pointer"
        ],
        "userAcceptedAsEvidence": false
      }
    ],
    "blockedWrites": [],
    "verificationStatusOnWrite": "USER_AUTHORED",
    "originOnWrite": "USER",
    "callsExistingEntrypoints": [],
    "futureOperation": "create_new",
    "futureEntrypoints": [
      "createApplicationMaterial",
      "addApplicationMaterialEvidence"
    ]
  },
  "saveGate": {
    "wordingAccepted": false,
    "saveAuthorized": false,
    "persisted": false,
    "mustConfirmBeforeSave": [
      "实习标题是否使用“北海市集科技 · 青禾超市履约小程序”",
      "时间只精确到 2024-07 与 2024-09，保存时日期留空，不补成某日",
      "两条事实点的措辞",
      "建议表达尚不在写入清单中"
    ]
  },
  "next": {
    "recommendation": "hand_to_user",
    "questionBudget": 0,
    "userControls": [
      "纠正",
      "换方向",
      "跳过",
      "结束",
      "查看阶段总结"
    ]
  }
}
```

日期只精确到月，所以 `parent.startDate` 与 `endDate` 保持 `null`。月份留在已确认事实里，不写成某日。

### 12.2 没有量化指标

用户：“我在校团委做了两学期‘夜航自习室’，主要是排班和提醒同学关灯。没有统计过来了多少人。”

技能确认这是校园活动、行动是排班和提醒，并跳过指标。用户接着说：“就这些，可以停。”

停止理由：`insufficient_user_stop`。用户没有描述实际成果，仅说明未统计人数；`skipped` 记录 `no_metric`，结果槽位仍待确认。结果不出现人数，也不把“两学期”改写成起止日期。

```json
{
  "contractVersion": "resume-evidence-result/v0.1",
  "skillId": "vocatrya.skill.resume-evidence-deep-dive",
  "skillVersion": "0.1.0-proposal",
  "artifactKind": "skill_result_draft",
  "exampleKind": "design_example",
  "session": {
    "stage": "stopped",
    "stopReason": "insufficient_user_stop",
    "roundIndex": 1,
    "focus": null,
    "sufficiency": {
      "met": false,
      "missingSlots": [
        "result"
      ]
    }
  },
  "authorization": {
    "scope": "single_experience",
    "fullLibraryScanned": false,
    "purpose": "career_record",
    "targetJdRef": null
  },
  "sourceRefs": [
    {
      "ref": "src-turn-1",
      "kind": "user_turn",
      "label": "用户描述校园活动",
      "stableId": null,
      "excerpt": "我在校团委做了两学期夜航自习室，主要是排班和提醒同学关灯。没有统计过来了多少人。"
    }
  ],
  "confirmedFacts": [
    {
      "id": "fact-org",
      "text": "活动挂在校团委，名称是夜航自习室。",
      "slot": "organization",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "unknown"
    },
    {
      "id": "fact-time",
      "text": "持续了两学期。",
      "slot": "time_range",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "unknown"
    },
    {
      "id": "fact-action",
      "text": "用户负责排班，并提醒同学关灯。",
      "slot": "action",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "personal"
    }
  ],
  "pending": [
    {
      "id": "pend-result",
      "text": "具体成果尚未提供；没有统计人数不是成果。",
      "slot": "result",
      "reason": "unknown",
      "sourceRefs": [
        "src-turn-1"
      ]
    }
  ],
  "conflicts": [],
  "contributions": [
    {
      "id": "contrib-1",
      "statement": "排班和闭馆提醒是用户本人的工作。",
      "attribution": "personal",
      "actionIds": [
        "action-1"
      ],
      "outcomeIds": [],
      "sourceRefs": [
        "src-turn-1"
      ],
      "epistemic": "user_stated"
    }
  ],
  "actions": [
    {
      "id": "action-1",
      "statement": "为夜航自习室排班，并提醒同学关灯。",
      "actor": "personal",
      "sourceRefs": [
        "src-turn-1"
      ],
      "epistemic": "user_stated"
    }
  ],
  "outcomes": [],
  "suggestedExpressions": [
    {
      "id": "expr-1",
      "text": "在校团委负责夜航自习室两学期的排班，并提醒同学闭馆关灯。",
      "basisFactIds": [
        "fact-org",
        "fact-time",
        "fact-action"
      ],
      "epistemic": "suggested_wording",
      "userAcceptedWording": false,
      "saveAuthorized": false
    }
  ],
  "assumptions": [],
  "skipped": [
    {
      "id": "skip-metric",
      "slot": "metric",
      "reason": "no_metric",
      "note": "用户说明没有统计参与人数。"
    }
  ],
  "materialMapping": {
    "operation": "draft_only",
    "careerMaterialItemId": null,
    "type": "CAMPUS_ACTIVITY",
    "parent": {
      "title": "夜航自习室",
      "startDate": null,
      "endDate": null,
      "isCurrent": null,
      "notes": null
    },
    "detail": {
      "organizationName": "校团委"
    },
    "evidenceToAdd": [
      {
        "content": "用户负责排班，并提醒同学关灯，持续两学期。",
        "metricText": null,
        "kindOnWrite": "FACT",
        "semanticRole": "action",
        "basisFactIds": [
          "fact-action",
          "fact-time"
        ],
        "userAcceptedAsEvidence": false
      }
    ],
    "blockedWrites": [],
    "verificationStatusOnWrite": "USER_AUTHORED",
    "originOnWrite": "USER",
    "callsExistingEntrypoints": [],
    "futureOperation": "create_new",
    "futureEntrypoints": [
      "createApplicationMaterial",
      "addApplicationMaterialEvidence"
    ]
  },
  "saveGate": {
    "wordingAccepted": false,
    "saveAuthorized": false,
    "persisted": false,
    "mustConfirmBeforeSave": [
      "两学期没有具体起止日期，保存时日期留空",
      "事实点不写入人数"
    ]
  },
  "next": {
    "recommendation": "hand_to_user",
    "questionBudget": 0,
    "userControls": [
      "纠正",
      "换方向",
      "跳过",
      "结束",
      "查看阶段总结"
    ]
  }
}
```

### 12.3 团队成果与个人贡献还没分开

已有素材 `material-qinglan`（合成 id）的证据写着“项目获得校园创新赛一等奖。”用户补充：“海报和路演稿是我们三个人一起赶的。”技能还不知道奖项里哪一部分是用户做的，因此不能停止。

停止理由：尚未停止。`conflicts` 虽未形成互相否定的两句话，但 `personal_contribution` 仍是 `unknown`，`sufficiency.met` 为 false，下一问只拆个人与团队。

```json
{
  "contractVersion": "resume-evidence-result/v0.1",
  "skillId": "vocatrya.skill.resume-evidence-deep-dive",
  "skillVersion": "0.1.0-proposal",
  "artifactKind": "skill_result_draft",
  "exampleKind": "design_example",
  "session": {
    "stage": "clarifying",
    "stopReason": null,
    "roundIndex": 1,
    "focus": "personal_contribution",
    "sufficiency": {
      "met": false,
      "missingSlots": [
        "personal_contribution",
        "action"
      ]
    }
  },
  "authorization": {
    "scope": "single_experience",
    "fullLibraryScanned": false,
    "purpose": "resume_bullet",
    "targetJdRef": null
  },
  "sourceRefs": [
    {
      "ref": "src-evidence",
      "kind": "existing_evidence",
      "label": "已有成果证据",
      "stableId": "evidence-award-line",
      "excerpt": "项目获得校园创新赛一等奖。"
    },
    {
      "ref": "src-turn-1",
      "kind": "user_turn",
      "label": "用户说明团队",
      "stableId": null,
      "excerpt": "海报和路演稿是我们三个人一起赶的。"
    }
  ],
  "confirmedFacts": [
    {
      "id": "fact-award",
      "text": "项目获得校园创新赛一等奖。",
      "slot": "result",
      "epistemic": "source_material",
      "sourceRefs": [
        "src-evidence"
      ],
      "attribution": "unknown"
    },
    {
      "id": "fact-team",
      "text": "海报和路演稿由包括用户在内的三个人一起完成。",
      "slot": "context",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "mixed"
    }
  ],
  "pending": [
    {
      "id": "pend-owner",
      "text": "一等奖材料中，哪些页面、哪些讲稿段落是用户本人完成的。",
      "slot": "personal_contribution",
      "reason": "unknown",
      "sourceRefs": [
        "src-evidence",
        "src-turn-1"
      ]
    }
  ],
  "conflicts": [],
  "contributions": [],
  "actions": [],
  "outcomes": [
    {
      "id": "outcome-1",
      "statement": "项目获得校园创新赛一等奖。",
      "quantified": false,
      "metricText": null,
      "attribution": "unknown",
      "sourceRefs": [
        "src-evidence"
      ],
      "epistemic": "source_material"
    }
  ],
  "suggestedExpressions": [],
  "assumptions": [],
  "skipped": [],
  "materialMapping": {
    "operation": "draft_only",
    "careerMaterialItemId": "material-qinglan",
    "type": "COMPETITION",
    "parent": {
      "title": null,
      "startDate": null,
      "endDate": null,
      "isCurrent": null,
      "notes": null
    },
    "detail": {},
    "evidenceToAdd": [],
    "blockedWrites": [
      {
        "code": "CONTRIBUTION_UNRESOLVED",
        "message": "个人贡献未分开之前，不追加新的事实点，也不改写已有“一等奖”证据。"
      }
    ],
    "verificationStatusOnWrite": "USER_AUTHORED",
    "originOnWrite": "USER",
    "callsExistingEntrypoints": [],
    "futureOperation": "update_existing",
    "futureEntrypoints": []
  },
  "saveGate": {
    "wordingAccepted": false,
    "saveAuthorized": false,
    "persisted": false,
    "mustConfirmBeforeSave": [
      "先由用户说明自己在海报或路演稿中的部分"
    ]
  },
  "next": {
    "recommendation": "ask",
    "questionBudget": 2,
    "userControls": [
      "纠正",
      "换方向",
      "跳过",
      "结束",
      "查看阶段总结"
    ]
  }
}
```

本例允许 `questionBudget = 2`，因为下一轮只拆“哪一部分是你做的”。在用户回答前，`evidenceToAdd` 保持为空。

### 12.4 用户纠正，且与材料冲突

粘贴原文：“我独立负责订单服务的接口。”用户随后说：“原稿写独立负责不准确。接口是我和一位后端同学一起做的，我负责错误码和重试，他负责数据库查询。”用户接着说：“先停在这里，我回去对原稿。”

停止理由：`insufficient_user_stop`。用户明确否定旧稿并解释分工，事实冲突已由用户解决，`resolution` 为 `user_resolved`；旧稿仍保留在冲突来源，不能当成候选事实重新询问。结果与时间未提供，停止仍是不充分；没有选择最终措辞不使事实纠正失效。

```json
{
  "contractVersion": "resume-evidence-result/v0.1",
  "skillId": "vocatrya.skill.resume-evidence-deep-dive",
  "skillVersion": "0.1.0-proposal",
  "artifactKind": "skill_result_draft",
  "exampleKind": "design_example",
  "session": {
    "stage": "stopped",
    "stopReason": "insufficient_user_stop",
    "roundIndex": 1,
    "focus": null,
    "sufficiency": {
      "met": false,
      "missingSlots": [
        "result",
        "time_range"
      ]
    }
  },
  "authorization": {
    "scope": "single_experience",
    "fullLibraryScanned": false,
    "purpose": "resume_bullet",
    "targetJdRef": null
  },
  "sourceRefs": [
    {
      "ref": "src-paste",
      "kind": "pasted_text",
      "label": "粘贴原稿",
      "stableId": null,
      "excerpt": "我独立负责订单服务的接口。"
    },
    {
      "ref": "src-turn-1",
      "kind": "user_turn",
      "label": "用户纠正",
      "stableId": null,
      "excerpt": "接口是我和一位后端同学一起做的，我负责错误码和重试，他负责数据库查询。"
    }
  ],
  "confirmedFacts": [
    {
      "id": "fact-correction",
      "text": "接口由用户与一位后端同学共同完成，用户负责错误码和重试，对方负责数据库查询。",
      "slot": "personal_contribution",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "mixed"
    }
  ],
  "pending": [
    {
      "id": "pend-result",
      "text": "结果及时间未提供。",
      "slot": "result",
      "reason": "not_yet_asked",
      "sourceRefs": []
    }
  ],
  "conflicts": [
    {
      "id": "conf-1",
      "topic": "订单服务接口的负责人",
      "left": {
        "text": "我独立负责订单服务的接口。",
        "sourceRefs": [
          "src-paste"
        ]
      },
      "right": {
        "text": "接口是我和一位后端同学一起做的，我负责错误码和重试，他负责数据库查询。",
        "sourceRefs": [
          "src-turn-1"
        ]
      },
      "resolution": "user_resolved"
    }
  ],
  "contributions": [],
  "actions": [],
  "outcomes": [],
  "suggestedExpressions": [],
  "assumptions": [],
  "skipped": [],
  "materialMapping": {
    "operation": "draft_only",
    "careerMaterialItemId": null,
    "type": "PROJECT",
    "parent": {
      "title": null,
      "startDate": null,
      "endDate": null,
      "isCurrent": null,
      "notes": null
    },
    "detail": {},
    "evidenceToAdd": [],
    "blockedWrites": [
      {
        "code": "DRAFT_ONLY_V1",
        "message": "首版只产出草稿，不执行保存。"
      }
    ],
    "verificationStatusOnWrite": "USER_AUTHORED",
    "originOnWrite": "USER",
    "callsExistingEntrypoints": [],
    "futureOperation": "draft_only",
    "futureEntrypoints": []
  },
  "saveGate": {
    "wordingAccepted": false,
    "saveAuthorized": false,
    "persisted": false,
    "mustConfirmBeforeSave": [
      "首版不保存；事实纠正已接受，未来保存仍需应用单独确认。"
    ]
  },
  "next": {
    "recommendation": "hand_to_user",
    "questionBudget": 0,
    "userControls": [
      "纠正",
      "换方向",
      "跳过",
      "结束",
      "查看阶段总结"
    ]
  }
}
```

用户纠正保留在 conflicts.right，并作为本轮 user_stated 事实；旧稿不被删除，应用资料也未改写。事实纠正与接受建议措辞、授权保存是三件不同的事。

### 12.5 用户跳过并结束

用户：“这段是在南栈物流做值班支持。具体指标和内部故障名不方便说，就到这里。”

技能不再追问指标和故障名，保留组织与“值班支持”这一条有限行动，并停止。

停止理由：`insufficient_user_stop`。行动只有职责名称，结果和指标被跳过，不足以标成 `sufficient`，但用户有权结束。

```json
{
  "contractVersion": "resume-evidence-result/v0.1",
  "skillId": "vocatrya.skill.resume-evidence-deep-dive",
  "skillVersion": "0.1.0-proposal",
  "artifactKind": "skill_result_draft",
  "exampleKind": "design_example",
  "session": {
    "stage": "stopped",
    "stopReason": "insufficient_user_stop",
    "roundIndex": 0,
    "focus": null,
    "sufficiency": {
      "met": false,
      "missingSlots": [
        "personal_contribution",
        "action",
        "result",
        "time_range"
      ]
    }
  },
  "authorization": {
    "scope": "single_experience",
    "fullLibraryScanned": false,
    "purpose": "unspecified",
    "targetJdRef": null
  },
  "sourceRefs": [
    {
      "ref": "src-turn-1",
      "kind": "user_turn",
      "label": "用户给出范围并结束",
      "stableId": null,
      "excerpt": "这段是在南栈物流做值班支持。具体指标和内部故障名不方便说，就到这里。"
    }
  ],
  "confirmedFacts": [
    {
      "id": "fact-org",
      "text": "组织是南栈物流。",
      "slot": "organization",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "unknown"
    },
    {
      "id": "fact-role",
      "text": "用户做值班支持。",
      "slot": "role",
      "epistemic": "user_stated",
      "sourceRefs": [
        "src-turn-1"
      ],
      "attribution": "personal"
    }
  ],
  "pending": [
    {
      "id": "pend-time",
      "text": "起止时间未提供。",
      "slot": "time_range",
      "reason": "not_yet_asked",
      "sourceRefs": []
    }
  ],
  "conflicts": [],
  "contributions": [],
  "actions": [],
  "outcomes": [],
  "suggestedExpressions": [],
  "assumptions": [],
  "skipped": [
    {
      "id": "skip-metric",
      "slot": "metric",
      "reason": "user_private",
      "note": "用户不方便说具体指标。"
    },
    {
      "id": "skip-pointer",
      "slot": "evidence_pointer",
      "reason": "user_private",
      "note": "用户不方便说内部故障名。"
    }
  ],
  "materialMapping": {
    "operation": "draft_only",
    "careerMaterialItemId": null,
    "type": "EMPLOYMENT",
    "parent": {
      "title": "南栈物流 · 值班支持",
      "startDate": null,
      "endDate": null,
      "isCurrent": null,
      "notes": null
    },
    "detail": {
      "organizationName": "南栈物流",
      "roleTitle": "值班支持"
    },
    "evidenceToAdd": [],
    "blockedWrites": [
      {
        "code": "APPLICATION_PROFILE_EMPLOYMENT_READONLY",
        "message": "资料页现有写入口不编辑 EMPLOYMENT。本结果只保留草稿，不新建写接口。"
      }
    ],
    "verificationStatusOnWrite": "USER_AUTHORED",
    "originOnWrite": "USER",
    "callsExistingEntrypoints": [],
    "futureOperation": "draft_only",
    "futureEntrypoints": []
  },
  "saveGate": {
    "wordingAccepted": false,
    "saveAuthorized": false,
    "persisted": false,
    "mustConfirmBeforeSave": [
      "即便用户以后同意保存，当前资料页入口也不能写入 EMPLOYMENT 正文",
      "指标与故障名保持跳过，不回填"
    ]
  },
  "next": {
    "recommendation": "hand_to_user",
    "questionBudget": 0,
    "userControls": [
      "纠正",
      "换方向",
      "跳过",
      "结束",
      "查看阶段总结"
    ]
  }
}
```

本例同时覆盖“跳过敏感或内部细节”和“结束后仍不能保存”：类型落在现有只读的 `EMPLOYMENT` 上。技能不改口称已写入实习或项目来绕过这个限制。

## 13. 本轮明确不做

- 不修改产品源码、Schema、Migration、备份、共享 Feature 台账、`wiki/EXTENSIONS_IMPLEMENTATION.md` 或 `wiki/EXTENSIONS_FEATURES.json`。
- 不把本文件注册进运行时，不调用模型或付费 API。
- 内容窗口原始交付未提交；本次协调窗口获授权核验并提交文档。不推送、不清理工作树。

设计示例里的保存入口名称只用于对照现有 Action。出现这些名字不等于已经调用。


## 14. 协调核验记录

2026-11-17：核对实际职业素材 Action、Service、detail白名单及原生技能最小输入。修正“无统计即成果”、明确纠正仍被当开放冲突、来源摘录缺少事实依据、未知null误作清空及模型布尔值充当授权等问题。所有结果示例保持draft_only、persisted:false；JSON及引用一致性检查不是模型质量验收。文档提交不等于批准、加载或实现。
