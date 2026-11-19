# Agent 长任务 Harness 完整实施方案

状态：实施设计（未实施）；**2026-11-19 Owner 裁定本期范围与修订，见 §0.1，与正文冲突处以 §0.1 为准**
依据：Anthropic Engineering《Effective harnesses for long-running agents》(2025-11-26)、
《Harness design for long-running application development》(2026-03-24)、
anthropics/cwc-long-running-agents quickstart；Vocatrya 代码库逐文件实测核对（2026-11-16）。

---

## 0. 范围

**做**：求职长任务（跨天/跨周的面试冲刺、投递跟进）的持久化任务账本、结构化交接便签、
上下文重置式会话恢复、确定性开局核验、任务级唤醒调度。

**不做**：自主对外发送（所有外部副作用保持现有 approval-gated）；planner/generator/evaluator
三角色全家桶；改写 ConversationSummary（它继续当普通聊天的 transcript 缓存）；改动
careerDialogueRoute 路由表；改写任何已执行 migration。

**一句话**：把长任务状态从"聊天消息 blob + 可丢弃散文摘要"搬到"任务账本 + 强类型便签 + 域实体指针"，
每个会话降格为任务的一次性易失 session。

---

## 0.1 Owner 裁定（2026-11-19）

用户同意按协调窗口建议修订后实施（“D4 按你的想法先改”）。以下裁定覆盖正文中的冲突内容：

1. **本期范围 = 卡 A（账本）、B（便签）、C（冷启动）、E（UI 最小面）**。用户在任务页/会话内显式点「继续任务」推进；**卡 D（scheduler 唤醒与无头轮次）随 H06 继续 DEFERRED，卡 F（evaluator）不进本期**。本期 migration 不加 `nextWakeupAt` 等唤醒字段，留待卡 D 另行 additive migration；§8.4、§8.5 与 §16 第 6 条移出本期。
2. **任务会话不写 `agentRole=NULL`（废止 §4「会话 agentRole=NULL」一条）**。理由：与 `HARNESS_OPTIMIZATION_ROADMAP.json` 原则「历史兼容 agentRole=NULL 不作为新功能扩权手段」直接冲突，也与按角色划分工具/审批的多角色模型（含 MAO-AUTOROUTE）不一致。改为：任务会话归属 **Pilot** 槽位，按任务模板显式声明所需工具集，通过角色白名单的「任务扩展」入口加入并可测试，不借 NULL 扩权。
3. **首个消费场景 = 面试冲刺**：任务绑定 JobOpportunity，复用 `INTERVIEW-PREP-CONTINUITY` 已有的面试准备目标、固定 JD 版本与逐题进度作为 milestone 推导与 acceptanceItems 的证据来源；投递跟进等其他模板后续再加。
4. **§18 开放问题裁定**：
   - Q1 任务创建入口：V1 仅机会详情页按钮，不新增 `propose_agent_task` 模型工具。
   - Q2 自动唤醒默认：本期不做唤醒（见第 1 条）；将来实施时默认关闭、用户显式开启。
   - Q3 `AgentTaskEvent` 备份：随包备份（审计价值），idmap 覆盖新外键。
   - Q4 合成 kickoff 文案：本期固定文案，按 milestone 细化留后续。
   - Q5 evaluator：本期不做，先用确定性 grounding verifier 观察。
5. **排期**：会改 `contextBudget.ts`、`prompt.ts`、`accountTurn.ts` 与聊天路由，和其他聊天核心改动（MAO-AUTOROUTE 等）不并行；按 A→B→C→E 顺序串行，单一 Owner。

## 1. 事实核对结论（已逐条对照源码）

| 论断 | 代码事实 | 结论 |
|---|---|---|
| 组装上限 16k、历史 ≤6 轮、摘要 1k | `contextBudget.ts:33-44` | 属实 |
| 超预算先丢摘要 | `dropLowest()` `:655-660` 第一步即丢；另有两条独立丢弃路径：超 1k 整丢 `:577-579`、覆盖有缺口作废 `:703-712` | 属实且更严重 |
| 摘要禁数据库 ID、工具输出降维 | `conversationSummaryPrompt.ts:43-46` 投影为 `Tool ${name} finished (${status})`；`:62` 明文禁 ID | 属实，且是输入投影+提示词双重剥离 |
| Task=人工待办、Automation=轮询 | `schema.prisma:506,532` | 属实 |
| 无开局环境核验 | `careerDialogueRoute.ts` 纯正则、`accountTurn.ts:657` 直接进决策循环 | 属实 |
| 摘要机制"粗略" | 不准确：coverageHash+revision CAS、失败退避、确定性 operationId 防重复计费（`conversationSummary{Commit,Scheduler}.ts`）是 production 级管线 | 修正：粗的是内容不是机制，机制是便签写入器的复用骨架 |
| 上下文严禁 ID | 需限定：AGENT_DECISION 在 list_jobs/get_job 固定路径回注 job.id（`contextBudget.ts:226-253`）；摘要路径全断 | 修正：断锁发生在摘要/跨会话层 |

补充：`ChatConversation.messages` 是单列 JSON blob（`schema.prisma:698`）——跨天恢复必整段载入再被裁剪，这是换宿主的结构性根因。

## 2. Anthropic 机制提炼（官方原文校准）

1. **Initializer + worker 两阶段**：首 session 展开全量清单，后续每轮只做一个增量，结束保持"可直接合并"的干净状态。
2. **Default-FAIL 清单**：JSON 存储、全部 `passes:false` 开局、未出示证据不得翻 true、不得删改验收项。与 `wiki/MVP_FEATURES.json` 的 `passes` 语义同构。
3. **Context Reset > Compaction**：官方明确原地摘要治不了 context anxiety，必须彻底重置 + 结构化 handoff。
4. **开局仪式是机械验证**：读进度 → 跑启动 → 冒烟 → 才选活。不是让模型"回忆"。
5. **Evaluator 独立纯净上下文**：调"多疑"的独立验收比让 worker 自评容易；模型够强时可退化为末尾单验。
6. **失败模式清单**：过早宣布胜利、半成品环境、未验证标完成、每轮重复摸索环境——分别对应清单拦截、干净状态+冒烟、证据门槛、装配固化。

## 3. 可复用资产（实测）

| 需要 | 已有 | 位置 |
|---|---|---|
| Environment as Ground Truth | A+B 域实体全链：JobOpportunity → JobDescriptionVersion（不可变、contentHash）→ JobDescriptionParse → MatchAnalysis（inputHash、isStale）→ ResumeVariantVersion（DRAFT/FROZEN/SUBMITTED、targetJdVersionId、sourceMatchAnalysisId）→ ApplicationAttempt（投递三元组指针）→ ApplicationProcessStep → InterviewSession（自带状态机+currentQuestionInstanceId 指针） | `schema.prisma:764-2085` |
| 幂等/断点 | AgentToolExecution（turnKey 去重、operationKey、原子提交、崩溃重放）+ checkpointConversationTool | `schema.prisma:1808`、`conversationRequest.ts:157` |
| 异步状态写入管线 | Summary scheduler：trigger 判定、CAS、退避、in-flight 去重、deterministic operationId | `conversationSummary*.ts` |
| 唤醒循环 | node-cron claim loop + 单活守卫 + stale reaper | `scheduler/index.ts` |
| 定时锚点 | Reminder（fireAt claim 索引、polymorphic targetId 无 FK 先例） | `schema.prisma:1025` |
| 角色裁权 | agentRole allowlist（服务端权威、只缩不扩） | `agentRoles.ts:49-73`、`toolPermissions.ts` |
| 约束结构 | JobSearchPreference（薪资/地点硬约束的结构化存储） | `schema.prisma:1143` |

**差距收敛为一句话：缺任务级编排状态**——没有一个实体记录"战役进行到哪、产出了什么、卡在哪、下一步是什么"。

## 4. 总体架构

```
用户 / Scheduler claim
        │
        ▼
┌─ AgentTask（账本：milestone + acceptanceItems + 单活守卫 + nextWakeupAt）
│      │
│      ├── AgentTaskEvent（事件溯源：SESSION_START/GROUNDING/STEP/MILESTONE/BLOCKED/COMMIT）
│      ├── AgentTaskHandoff（便签链：revision 单调、stateHash、CAS）
│      └── sessions → ChatConversation[ ]（每 session = 一次 context reset，
│              agentTaskId 挂靠，agentRole=NULL 通用注册表）
│
├─ 读路径（每轮）：loadHandoff → groundingVerifier（纯代码逐 ID 查库）
│      → handoff 行注入 contextBudget（never-drop 级）
│
├─ 写路径（每轮结束/挂起）：handoffScheduler → 代码收集实体指针
│      + 模型产散文（summary/nextActions/blocking）→ zod 校验
│      → 实体存在性复核 → CAS 落库
│
└─ 推进：每轮一个原子动作 → deriveMilestone（纯代码从域实体推导）
         → acceptanceItems 证据门槛 → 写 Event → 结束/挂起
```

**核心设计决定（与课前草案的差异）**：

- **实体指针由代码注入，不由模型书写**。handoff 的 `completedWork.*Ids` 全部由写入器从
  AgentToolExecution/域查询确定性收集；模型只产 `summary`/`nextActions`/`blocking` 散文。
  模型想在便签里塞假 ID 没有管道——比"提示词要求写对 ID"强一个量级。
- **Handoff 校验两段式**：zod 结构校验 + 提交前对每个实体 ID 做一次存在性复查
  （与 grounding verifier 复用同一批查询函数）。
- ~~**会话 agentRole=NULL**~~（2026-11-19 废止，见 §0.1 第 2 条）：任务 session 需要全工具注册表，写 NULL 是对既有
  "pre-multi-agent 通用助手"语义的**显式契约扩展**（新代码此前不写 NULL，
  见 `agentRoles.ts:10` 注释——本方案把它变为"任务会话专用标记"，前端 slotRoleFor
  已能把 NULL 归入 Pilot 槽位展示，无需 UI 改动）。

## 5. 数据模型（additive migration `YYYYMMDDHHMMSS_agent_task_harness`）

### 5.1 新模型

```prisma
/// 求职长任务账本。一个 AgentTask 横跨多个 ChatConversation session。
/// 与 RecruitmentCampaign（企业招聘季域实体）不同概念：本表是 Agent 编排单元。
model AgentTask {
  id              String   @id @default(uuid())
  userId          String

  title           String
  // 任务锚点二选一：面试冲刺挂机会，批量投递挂战役；均可空（纯咨询型任务）
  jobOpportunityId  String?
  campaignId        String?

  // RESEARCH | TAILORING | APPROVAL | APPLYING | INTERVIEW_PREP | REVIEW | DONE | ABANDONED
  milestone       String   @default("RESEARCH")
  // ACTIVE | PAUSED | BLOCKED | DONE | ABANDONED
  status          String   @default("ACTIVE")

  // default-FAIL 验收清单（JSON）：[{key,label,passes,evidenceRef}]
  // 只能由代码按 §9 判定矩阵翻转，模型无权自签。
  acceptanceItems String

  // 并发与调度
  revision        Int       @default(0)       // handoff CAS 基线
  activeSessionId String?                     // 单活守卫：同一 task 同时只有一个 session
  activeSessionClaimedAt DateTime?            // 超时回收依据（对照 AutomationRun stale reaper）
  nextWakeupAt    DateTime?                   // scheduler claim 锚点；NULL=不自动唤醒
  blockedReason   String?                   // WAITING_USER_CONFIRMATION | WAITING_SCHEDULE | MISSING_FACTS | EXTERNAL_REPLY
  blockedInputKey String?                   // 恢复时向用户索取的具体字段

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  archivedAt DateTime?

  user            User                 @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobOpportunity  JobOpportunity?      @relation(fields: [jobOpportunityId], references: [id], onDelete: SetNull)
  campaign        RecruitmentCampaign? @relation(fields: [campaignId], references: [id], onDelete: SetNull)
  handoffs        AgentTaskHandoff[]
  sessions        ChatConversation[]
  events          AgentTaskEvent[]

  @@index([userId, status])
  @@index([status, nextWakeupAt])
  @@index([jobOpportunityId])
}

/// 结构化交接便签。append-only 链；读取 = revision 最大行。
/// 与 ConversationSummary 同为 CAS 写入，但语义相反：这是 career-fact，永不丢弃。
model AgentTaskHandoff {
  id        String   @id @default(uuid())
  taskId    String
  revision  Int      // == 写入时 AgentTask.revision+1；@@unique 防并发写偏
  state     String   // JSON AgentTaskHandoffState（§6 zod 校验后落库）
  stateHash String   // canonical JSON 的 sha256——恢复时校验未被手改/写偏
  sessionId String?  // 产出本便签的 session
  generationMs Int?
  createdAt DateTime @default(now())

  task    AgentTask         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  session ChatConversation? @relation(fields: [sessionId], references: [id], onDelete: SetNull)

  @@unique([taskId, revision])
  @@index([taskId, createdAt])
}

/// 任务级事件溯源日志（衔接第一课 DeepSeek 式 event log）。append-only。
model AgentTaskEvent {
  id        String   @id @default(uuid())
  taskId    String
  // SESSION_START | GROUNDING | STEP | MILESTONE | BLOCKED | RESUMED | HANDOFF_COMMIT | SESSION_END | ERROR
  kind      String
  payload   String   // JSON，按 kind 定形；只放指针与短码，不放长文
  createdAt DateTime @default(now())

  task AgentTask @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId, createdAt])
}
```

### 5.2 既有模型修改点

```prisma
model ChatConversation {
  // ... 既有字段不变，新增一列：
  agentTaskId String?
  agentTask   AgentTask? @relation(fields: [agentTaskId], references: [id], onDelete: SetNull)
  taskHandoffs AgentTaskHandoff[]   // 反向关系
  @@index([agentTaskId])
}

model User {
  // ... 追加反向关系一行：
  agentTasks AgentTask[]
}

model JobOpportunity {
  // ... 追加：
  agentTasks AgentTask[]
}

model RecruitmentCampaign {
  // ... 追加：
  agentTasks AgentTask[]
}
```

语义约定（写入迁移注释与 schema 注释）：
- `ChatConversation.agentTaskId` NULL = 普通聊天，行为与今天完全一致；
- 任务 session 的 `agentRole` 写 NULL（通用注册表），`title` 由代码写成 `任务 · <task.title>`；
- `AgentTask` 删除 → handoff/event Cascade、session SetNull（transcript 留存为普通聊天）。

### 5.3 备份/恢复分类（`src/lib/backup/`）

`coverage.ts` 的守卫测试要求每个 Prisma 模型有分类。决策：

| 模型 | 分类 | 理由 |
|---|---|---|
| AgentTask | **BACKED_UP** | 用户 career-fact（任务账本本体） |
| AgentTaskHandoff | **BACKED_UP** | 任务状态链，恢复后不重建 |
| AgentTaskEvent | **BACKED_UP** | 审计轨迹，量小；与 AgentToolExecution 的"运行时账本"性质不同——它是用户可见的历史，不是恢复用 reservation |
| ChatConversation.agentTaskId | zod schema 加 `optId.optional()`（沿用既有 additive-column 惯例，旧备份无此键可恢复） | — |

改动文件：`backup/schema.ts`（三个 zod + ChatConversation 加键）、`backup/ordering.ts`
（INSERT_ORDER：JobOpportunity/RecruitmentCampaign 之后插 AgentTask；ChatConversation 之后插
AgentTaskHandoff、AgentTaskEvent——sessionId FK 要求晚于 ChatConversation）、`backup/idmap.ts`
（`ChatConversation.agentTaskId`、`AgentTask.jobOpportunityId/campaignId`、`AgentTaskHandoff.sessionId`
加入需重映射的键清单，参照 `:68` 既有模式）。不新增 INTENTIONALLY_EXCLUDED。

## 6. HandoffState 契约（`src/models/agentTask.schema.ts`）

```ts
export const AGENT_TASK_HANDOFF_SCHEMA_VERSION = "agent-task-handoff-v1";

export const AgentTaskHandoffStateSchema = z.object({
  schemaVersion: z.literal(AGENT_TASK_HANDOFF_SCHEMA_VERSION),
  taskId: z.string().min(1),
  milestone: z.enum([
    "RESEARCH", "TAILORING", "APPROVAL", "APPLYING",
    "INTERVIEW_PREP", "REVIEW",
  ]),
  completedWork: z.object({
    summary: z.string().max(3000),               // 散文简述（代码收集实体后模型补写）
    jobOpportunityIds: z.array(z.string()).max(50),
    jobDescriptionVersionIds: z.array(z.string()).max(50),
    matchAnalysisIds: z.array(z.string()).max(50),
    resumeVariantVersionIds: z.array(z.string()).max(50),  // version 级，非 variant
    applicationAttemptIds: z.array(z.string()).max(50),
    interviewSessionIds: z.array(z.string()).max(50),
  }),
  acceptanceSnapshot: z.array(z.object({
    key: z.string(),
    passes: z.boolean(),
    evidenceRef: z.string().optional(),           // 实体 ID 或 agent_tool_execution.operationKey
  })).max(50),
  blocking: z.object({
    isBlocked: z.boolean(),
    reason: z.enum([
      "WAITING_USER_CONFIRMATION", "WAITING_SCHEDULE",
      "MISSING_FACTS", "EXTERNAL_REPLY",
    ]).optional(),
    requiredInputKey: z.string().optional(),
  }),
  nextActions: z.array(z.object({
    action: z.string().max(500),
    toolHint: z.string().optional(),
    targetRef: z.string().optional(),
  })).min(1).max(10),
  criticalConstraints: z.array(z.string().max(300)).max(20),
  constraintSourceIds: z.array(z.string()).max(20), // JobSearchPreference.id 等
});
export type AgentTaskHandoffState = z.infer<typeof AgentTaskHandoffStateSchema>;
```

`stateHash` = `sha256(canonicalStringify(sortKeys(state)))`，复用
`conversationSummaryCoverage.ts` 的 `sortSummaryJson`/hash 思路。

**渲染进上下文的文本形态**（handoff 行，≤1.5k tokens，装配器产出，非原始 JSON）：

```
Active task state (system-maintained, verified <ISO时间>):
Task: 准备字节跳动前端面试 · milestone=INTERVIEW_PREP · blocked=no
Done: JD解析+匹配分析完成 [match:88分, 分析已落库]; 简历变体 v2 FROZEN
Acceptance: [x] jd-parsed [x] match-scored [ ] mock-session-1 [ ] salary-benchmark
Next: 生成高并发前端性能自测题（仅推进这一项）
Constraints: 期望薪资≥30k; 只看远程; 绝不接受外包 [来源: JobSearchPreference]
Grounding discrepancies: variant v2 便签称 FROZEN，实际 DRAFT（已按实际修正）
```

## 7. 新模块清单（`src/lib/agent/task/`）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `agentTaskStore.ts` | 任务 CRUD、claim/release 单活、milestone CAS | `createAgentTask` `claimAgentTaskSession` `releaseAgentTaskSession` `updateAgentTaskMilestone` `archiveAgentTask` |
| `agentTaskHandoffStore.ts` | 便签 CAS 读写（仿 `conversationSummaryStore.ts` repository 模式） | `loadLatestHandoff` `commitHandoff` `recordHandoffFailure` |
| `agentTaskHandoffPrompt.ts` | 便签散文段的生成提示词（只产 summary/nextActions/blocking，不产 ID） | `buildTaskHandoffPrompt` `projectTaskSessionInput` |
| `agentTaskHandoffScheduler.ts` | 触发判定 + 生成 + 两段校验 + CAS 落库（骨架仿 `conversationSummaryScheduler.ts`，含 in-flight Map、退避、managed operationId=`task:<taskId>:handoff:<hash16>`） | `scheduleTaskHandoff` `condenseTaskHandoff` |
| `agentTaskGrounding.ts` | 确定性核验器（§9 检查表），产 verified/discrepancies | `verifyHandoffState` `verifyAcceptanceItem` |
| `agentTaskBootstrap.ts` | 冷启动装配：读便签→核验→渲染 handoff 行文本 | `buildTaskHandoffLine` |
| `agentTaskMilestone.ts` | 域状态 → milestone 纯函数推导 + acceptance 判定矩阵 | `deriveTaskMilestone` `evaluateAcceptanceItems` |
| `agentTaskEvents.ts` | Event append 助手 | `recordTaskEvent` |
| `agentTaskRunner.ts` | 无头 session 轮次执行（供 scheduler 唤醒；§8.3） | `runTaskSessionTurn` `resumeDueAgentTasks` |

## 8. 既有文件修改点（精确到函数）

### 8.1 `src/lib/agent/contextBudget.ts`

- `CAREER_DIALOGUE_CONTEXT_BUDGETS` 增加 `handoffTokens: 1_500`；
- `CareerDialogueContextInput` 增加 `handoffLine?: string`；
- `assemble()`/`dynamicParts()`：handoff 行插在 summaryLine 之后、history 之前；
- `dropLowest()`：**不触碰** handoffLine（与 fixed instructions 同级保护）；
- 防御闸：`handoffLine` 超 `handoffTokens` 时丢弃并在返回值 `size` 里计
  `handoffDropped: true`——写入侧已卡预算，读到超大行只可能是历史脏数据；
- `CareerDialogueContextSize` 增加 `handoffTokens`、`handoffDropped`；
- `careerDialogueContextLogFields` 增加对应字段。

### 8.2 `src/lib/agent/accountTurn.ts`

- `renderCareerDialoguePrompt` input 增加 `handoffLine?: string`，透传进
  `buildCareerDialogueContext`；三个 profile（FAST_CHAT/AGENT_DECISION/AGENT_RESPONSE）全部可见；
- `AccountAgentTurnInput` 增加 `handoffLine?: string`；
- `runAccountAgentTurn` 内 `promptFor()` 透传——决策与回答都看得到任务状态。

### 8.3 `src/app/api/ai/chat/route.ts`

`accountChatResponse` 内、`loadFreshConversationSummary` 同位（`:322` 附近）：

```ts
const handoff = conversation.agentTaskId
  ? await buildTaskHandoffLine({ userId, taskId: conversation.agentTaskId, db: prisma })
  : undefined;
```

- `conversation` 需含 `agentTaskId`：`CHAT_ROW_SELECT`（`chatConversationStore.ts:51`）加 `agentTaskId: true`；
- `buildTaskHandoffLine` 内部：loadLatestHandoff → verifyHandoffState → 渲染；
  任务无便签（首次）→ 返回任务初始状态行（milestone=初始、空 completedWork）；
- 传参链：`runCareerDialogueTurn` → `runAccountAgentTurn`/`renderCareerDialoguePrompt`；
- `onFinish` 里 `scheduleCareerDialogueSummary` 之后追加：`conversation.agentTaskId` 非空时
  `scheduleTaskHandoff({ userId, taskId, sessionId: conversationId, ... })`；
- `CHAT_ROW_SELECT` 变化会扩散到 `snapshotOf`（`agentChat.actions.ts:97`）——快照类型
  `ChatConversationSnapshot` 加 `agentTaskId?: string | null`。

### 8.4 `src/lib/scheduler/index.ts`

`runDueAutomations` 旁新增 `runDueAgentTasks`（同一 cron tick 顺序执行）：

```ts
const due = await db.agentTask.findMany({
  where: { status: "ACTIVE", nextWakeupAt: { lte: now }, activeSessionId: null },
});
// 逐任务：claimAgentTaskSession（CAS 占位）→ runTaskSessionTurn（无头轮次）
// → 异常则 release + status=BLOCKED（blockedReason=MISSING_FACTS 兜底）
```

`reapStaleRuns` 同款：`activeSessionClaimedAt < now-SESSION_STALE_MS` 的 task 释放占位
并记 `AgentTaskEvent(SESSION_END, reason:"stale")`。

### 8.5 无头轮次（`agentTaskRunner.ts`）

复用请求生命周期，不新造轮子：

```
admitConversationRequest({ operation:"send", conversationId, requestId,
  expectedRevision, newMessage: { role:"user", parts:[{type:"text",
    text:"【任务步进】继续推进当前阶段。" }] }, userId })
→ 与 route 相同的 lock/preflight/tools 装配（抽公共函数或内联复用）
→ createUIMessageStream({ execute: runCareerDialogueTurn(…headless writer…) })
→ 手动消费 stream → onFinish 走 finishConversationRequest + scheduleTaskHandoff
```

要点：合成用户消息**真实落 transcript**（诚实审计，不伪装成用户输入——文案固定且带标记）；
approval 需求在无头轮次直接转 `blocking=WAITING_USER_CONFIRMATION` + PAUSED，
不发起 approval-requested（无人可点）。

### 8.6 `src/lib/constants.ts`

```ts
// 沿用既有扁平命名（AGENT_CHAT_* 同款）
AGENT_TASK_HANDOFF_TOKENS: 1_500,
AGENT_TASK_SESSION_STALE_MS: 2 * 60 * 60 * 1000,
AGENT_TASK_HANDOFF_BACKOFF_INITIAL_MS: 60_000,
AGENT_TASK_HANDOFF_BACKOFF_CAP_MS: 15 * 60_000,
AGENT_TASK_MAX_NEXT_ACTIONS: 10,
AGENT_TASK_WAKE_PER_TICK_PER_USER: 1,
```

### 8.7 `src/lib/agent/prompt.ts`

新增系统段落（仅 `agentTaskId` 非空会话注入，`buildAgentChatSystemPrompt` 加
`taskBound?: boolean` 参数）：

```
You are driving a long-running job-search task. The "Active task state" block is
system-maintained ground truth verified against the database — trust it over the
conversation history when they disagree. Advance exactly ONE next action this turn,
then stop: the harness persists your progress. Never claim an artifact exists
unless the task state lists it or a tool result this turn returned it. If the task
state marks an item blocked, ask the user for exactly the named input and nothing else.
```

## 9. Grounding Verifier 检查表（`agentTaskGrounding.ts`）

对每个 `completedWork` 指针执行存在性+状态核对（全部 ownership-scoped 查询）：

| 指针 | 核对 | 不符时 |
|---|---|---|
| jobOpportunityIds[] | 行存在、未 archived、status≠CLOSED/EXPIRED | 从渲染行移除并记 discrepancy |
| jobDescriptionVersionIds[] | 行存在且仍属该机会 | 同上 |
| matchAnalysisIds[] | status=COMPLETED 且 isStale=false | 标 "分析已失效，需重跑" |
| resumeVariantVersionIds[] | 行存在；status 字段与便签叙述对照 | 以实际 status 渲染 + discrepancy |
| applicationAttemptIds[] | 行存在、未 archived；submittedAt/currentStageCategory 与 milestone 一致性 | discrepancy |
| interviewSessionIds[] | status 未 ARCHIVED | discrepancy |
| constraintSourceIds[] | 行存在（JobSearchPreference 等） | 从渲染移除，保 criticalConstraints 文本 |
| acceptanceSnapshot[].evidenceRef | 指向实体存在 | 对应 acceptanceItems[i].passes 强制回 false（证据缺失不翻 true） |

返回 `{ verifiedLine: string; discrepancies: Discrepancy[] }`；discrepancies 逐条写
`AgentTaskEvent(GROUNDING)`。**verifier 是纯代码，无模型调用**——这是切断幻觉接力的硬边界。

Milestone 推导矩阵（`deriveTaskMilestone`，任务锚点为 JobOpportunity 时）：

| 当前 | 迁移到 | 判据（域实体真实状态） |
|---|---|---|
| RESEARCH | TAILORING | JobDescriptionParse 完成 且 MatchAnalysis COMPLETED !isStale |
| TAILORING | APPROVAL | 存在 ResumeVariantVersion targetJdVersionId=当前 JD |
| APPROVAL | APPLYING | （无码判据——由 handoff.blocking 解除+用户确认驱动；代码不猜） |
| APPLYING | INTERVIEW_PREP | ApplicationAttempt.submittedAt 非空 且 ProcessStep category=INTERVIEW 存在 |
| INTERVIEW_PREP | REVIEW | InterviewSession.status=COMPLETED 或 ProcessStep.result 回填 |
| REVIEW | DONE | acceptanceItems 全 true 且 Attempt outcome∈{OFFER,REJECTED,WITHDRAWN} |

`evaluateAcceptanceItems`：每个 key 一张判据表（如 `jd-parsed`→JD parse exists、
`mock-session-1`→InterviewSession 有 ≥1 ANSWERED QuestionInstance、`salary-benchmark`→
JobOpportunityNote/研究记录存在）；**无 evidenceRef 或 evidenceRef 失验 → 强制 false**。

## 10. API/Actions 表面（`src/actions/agentTask.actions.ts`）

```ts
createAgentTask(input: { title; jobOpportunityId?; campaignId?; kind: "INTERVIEW_PREP"|"JOB_APPLY"|"CAMPAIGN_FOLLOWUP"; acceptanceTemplate?: string })
listAgentTasks(filter?: { status? })            // 列表页
getAgentTask(taskId)                             // 详情：task + 最新 handoff + events 时间线
pauseAgentTask(taskId) / resumeAgentTask(taskId) // resume = claim + 建 session + 返回 conversationId
updateAgentTaskWakeup(taskId, nextWakeupAt|null) // 定时唤醒开关
archiveAgentTask(taskId)
```

`resumeAgentTask` 内部：`claimAgentTaskSession` CAS →
`createChatConversationRecord({ userId, messages: [], context: <机会页 context>, agentRole: null, agentTaskId })`
（`createChatConversationRecord` 加 `agentTaskId` 形参）→ 返回新会话快照 → 前端跳转 agent 页携带 conversationId。
任务 session 的创建锁复用 `resolveChatCreationLock`（lock 解析逻辑零改动）。

## 11. UI 最小面

- `dashboard/agent-tasks` 新路由（组件目录 `src/components/agent-tasks/`）：
  列表（title/milestone 徽章/status/blockedReason/nextWakeupAt）、
  详情（acceptanceItems checklist 只读、Events 时间线、历次 handoff 折叠查看）、
  "继续任务"按钮 → `resumeAgentTask` → 跳转会话；
- 会话内：task-bound 会话 header 显示任务 chip（读 `snapshot.agentTaskId` → 任务名）；
- 创建入口：JobOpportunity 详情页 "为此机会创建求职任务" 按钮（V1 唯一创建路径，防滥用）。
- **不碰**：聊天主界面结构、History 列表（任务 session 自然混排，title 前缀可辨）。

## 12. 观测性

- `log.info("[agent-task] ...")` 一族：`task.claim/release/handoff/grounding/milestone/wakeup`，
  字段只放 id、revision、计数、毫秒、稳定 code（沿用 `logSummary` 风格）；
- turn 日志 `logTurn` 加 `agentTaskId`、`taskMilestone`、`handoffTokens`、`groundingDiscrepancies`；
- turnSpan attrs：`jobsync.agent_task_id`、`jobsync.task_milestone`；
- 便签生成走 managed operationId `task:<taskId>:handoff:<stateHash16>`——重试 replay 不重复计费
  （沿用 summary 的 M4 契约）。

## 13. 安全与权限边界

- **审批不绕**：任务 session 内所有 needsApproval 工具照旧 approval-gated；无头轮次遇审批
  转 BLOCKED 等人，不自动执行。外部副作用（Notion 写、未来投递提交）永远人工确认。
- **IDOR**：所有查询 ownership-scoped；handoff 中的 ID 只做 `findFirst({id, userId})` 复查，
  绝不把指针当授权。
- **Prompt injection**：handoff 行是"系统维护数据"块，内部不含用户/JD 原文
  （completedWork 只有 ID+短散文，散文由生成提示词约束不复述 JD/paste）；
  合成 kickoff 消息固定文案，不携带外部文本。
- **备份**：三表全量随包走；恢复后 sessionId/jobOpportunityId 经 idmap 重映射，孤儿指针
  在首次 grounding 时自然暴露为 discrepancy 而非崩溃。
- **速率**：`checkRateLimit(userId,"chat")` 对无头轮次同样计数；scheduler 每 tick 每用户
  最多推进 N=1 个任务（常量），防止单用户刷爆 BYOK 额度。

## 14. 测试计划（`__tests__/`，沿用现有命名与 vitest 约定）

| spec 文件 | 覆盖 |
|---|---|
| `agentTaskStore.spec.ts` | 创建/锚点校验/claim CAS 单活/release/归档；并发 claim 只有一个成功 |
| `agentTaskHandoffSchema.spec.ts` | zod 全字段边界；超预算拒绝；stateHash 稳定性 |
| `agentTaskHandoffCommit.spec.ts` | revision CAS；并发写后到者丢弃；failure backoff |
| `agentTaskGrounding.spec.ts` | §9 每行检查表：实体缺失/状态漂移/证据缺失回 false |
| `agentTaskMilestone.spec.ts` | 推导矩阵全迁移路径 + 不可迁移保持 |
| `agentTaskBootstrap.spec.ts` | 渲染行内容、discrepancy 注入、首次任务空便签 |
| `contextBudgetHandoff.spec.ts` | handoff never-drop（summary/history 全丢它仍在）、三 profile 可见、超预算防御闸 |
| `agentTaskScheduler.spec.ts` | due 筛选、单活跳过、stale 回收、无头轮次 admission→finish→handoff 全链 |
| `agentChatTaskSession.spec.ts` | route 集成：agentTaskId 会话注入 handoff 行、普通会话零变化 |
| `backupAgentTask.spec.ts` | 三表 round-trip、agentTaskId 重映射、旧备份无新表可恢复 |
| 更新：`agentPrompt.spec.ts`、`agentToolPermissions.spec.ts`、`agentSchema.spec.ts`、`backupSchema.spec.ts`/`backupOrdering.spec.ts`（coverage guard 自动覆盖） | 回归 |

定向验证命令：`npx vitest run __tests__/<file>.spec.ts`、`npx tsc --noEmit`、
`npx eslint <changed files>`（沿用仓库现有命令；不默认全量/不默认桌面实测）。

## 15. 分阶段实施卡

| 卡 | 改动 | 完成判据 |
|---|---|---|
| **A 账本** | §5 migration + `agentTaskStore` + `agentTaskEvents` + backup 三件套 + actions 骨架 | migration 上隔离库；store spec 全绿；coverage guard 过 |
| **B 便签** | `agentTask.schema.ts` + handoffStore + handoffPrompt + handoffScheduler + `contextBudget` handoff 行（含 constants、size 字段、log fields） | schema/commit/budget spec 全绿；普通会话 transcript 逐字节不变 |
| **C 冷启动** | grounding + bootstrap + milestone + route 接线（CHAT_ROW_SELECT、accountTurn 透传、snapshot）+ `resumeAgentTask` + prompt 段落 | grounding/milestone/bootstrap/route spec 全绿；隔离库端到端"建任务→写便签→新会话见到已核验状态行" |
| **D 循环** | scheduler 接线 + `agentTaskRunner` 无头轮次 + stale 回收 | scheduler spec 全绿；合成轮次在隔离库产出 transcript+handoff+event |
| **E UI** | `dashboard/agent-tasks` 页面 + 会话 chip + 机会页创建按钮 | 页面渲染列表/详情；按钮链路通 |
| **F（可选）验收员** | evaluator 只读回合（role 扩展或专用 toolset 参数）+ evidence 抽查回写 | 独立 spec；未证据化 acceptanceItem 不可翻 true |

依赖：A→B→C 必须顺序；D 依赖 C；E 依赖 C；F 依赖 D 且可选。

## 16. 验收条件（MVP_FEATURES 风格草案）

1. 创建绑定某 JobOpportunity 的任务，任务页可见 milestone=RESEARCH 与 default-FAIL 清单；
2. 在任务会话完成一次 match_job，新会话打开时状态行显示该分析（含真实分数），历史聊天不复述；
3. 手工把 MatchAnalysis.isStale 置 true 后开新会话，状态行标注"分析已失效"而非沿用旧结论；
4. 暂停任务三天后"继续任务"，新会话首条助手回复直接推进 handoff.nextActions[0]，不重复已完成步骤；
5. acceptanceItem 无证据的项在用户界面永远显示未完成；evidenceRef 指向已删实体时自动回退；
6. 设置 nextWakeupAt 到期，scheduler 自动开一个带标记的步进轮次，transcript 可见合成消息；
7. 普通（非任务）会话的提示词、预算、摘要行为与升级前完全一致（回归零差异）。

## 17. 风险登记册

| 风险 | 缓解 |
|---|---|
| 便签散文段幻觉（模型编的 nextActions 不着调） | 指针代码注入 + grounding 纠偏；nextActions 仅为建议，milestone 由代码判 |
| 无头轮次失控烧钱 | 每 tick 每用户 1 任务 + 单轮 ≤4 步 + rate limit 照常 + operationId 幂等 |
| claim 泄漏（session 建完进程死） | activeSessionClaimedAt + stale 回收（照搬 AutomationRun reaper 语义） |
| 备份恢复后指针孤儿 | 首次 grounding 暴露为 discrepancy；idmap 覆盖全部新外键 |
| 双窗口写同一 task | claim CAS + handoff revision CAS 双闸门 |
| agentRole=NULL 语义扩展破坏老契约 | 仅 task session 写入；NULL 行为本来就是"通用助手"，前端 slotRoleFor 已有兜底 |
| milestone 推导与域状态分歧 | 推导唯一真相是域实体；推导失败保持原 milestone 并记 Event |

## 18. 开放问题（需 Owner 决策）

> 2026-11-19 已裁定，见 §0.1 第 4 条。

1. **任务创建入口**：V1 建议仅"机会详情页按钮"一处；是否允许聊天中由模型建议创建（要新工具 `propose_agent_task` + approval）？
2. **自动唤醒默认**：`nextWakeupAt` 默认 NULL（不自动跑），用户显式开启——还是按任务类型默认开？
3. **AgentTaskEvent 备份**：建议随包（审计价值）；若视为运行时账本则改 INTENTIONALLY_EXCLUDED。
4. **合成 kickoff 文案**：固定"【任务步进】继续推进当前阶段。"是否需要按 milestone 细化。
5. **evaluator（卡 F）**是否进本期：建议先用确定性 verifier 观察，再决定是否上独立模型验收。

## 19. 与第三课的衔接

高危动作断点/幂等留给现有 `AgentToolExecution + checkpointConversationTool` 管线。
第三课落点：turnKey 从"用户消息 id"扩展为"任务步 id"（`taskId:nextActionIndex`），
以及 approval 暂停跨 session 的恢复语义——本方案 `blocking=WAITING_USER_CONFIRMATION` +
`blockedInputKey` 已预留接口面。
