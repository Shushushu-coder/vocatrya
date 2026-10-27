# DateTime 消费者合同提案（P-TZ / P-PROC / P-JO / P-TASK 前置）

> **冻结记录：2026-10-27，用户已批准。** §9 D1–D9 全部采用 A，另批准下列执行边界与文件归属。本记录优先于正文保留的提案背景和旧状态；冻结不代表消费者已实现或验收通过，不授权提交、合并或真实数据操作。

### 本次冻结与当前实现

- P-TZ 的账户 IANA 时区存储、设置 UI、原子保存和客户端/服务端读取入口已实现，复用 `src/lib/userSettings/timeZone.ts` 与 `timeZone.server.ts`，不重复开发。清除键即跟随系统，脏值安全回退且不回写。完整桌面验收仍未完成。
- 计划时间必须含日期与时间；纯日期截止写 `*On`，不制造边界 instant 作为持久化事实。时区切换后日期文字与真实 instant 均不变，展示与 DateOnly 逾期边界使用当前账户时区，存储 zone 仅保留输入溯源。
- 历史 unknown 只显示日期；查看、编辑其他字段、原样保存均不重写原时间和 sidecar。Job/Task 本期表单仅日期输入，保留既有 Instant 数据和接口能力。
- Task 到期排序使用 DateOnly 的 `endIsoExclusive`，无到期值排尾，同值按 `priority desc → id asc`；全体匹配行先排序后分页，只 hydrate 本页。Upcoming 的 DateOnly 关注时间使用 `startIso`，当天即可提示，次日开始才逾期。两者用途不同，不共用一个隐含边界的排序 helper。
- 分页无重无漏以筛选条件、时区和数据集不变为前提；新增、改期或切换时区后重置并刷新列表，不承诺跨修改的分页快照。两阶段查询不得把阶段间数据变化误报为静态数据正确性证据。
- CSV 在现有列末尾追加单列 Deadline：DateOnly 原文、Instant 带 offset 的 ISO、无值为空；不将历史 unknown 推断成已知精度。
- Task 使用 §5.4 的 5,000 条合成数据验证全序、分页和 NULL 排尾；记录实际性能，300ms/页仅为参考预算，未实测不得宣称达标。

### 2026-10-27 合并窗口后的 Owner 补充

按用户要求合并同类工作，执行窗口以 `MVP_IMPLEMENTATION.md` 文首 W1–W7 为准。W1 同时承担 Process 与时间联动：流程源码、upcomingReadModel.ts、UpcomingContainer.tsx、overview.ts、datetime 共享工具由 W1 唯一写入；W2(Task)/W3(Job) 仅交接输入输出合同。当前主协调窗口保留双语词条、wiki 与获授权后的 Git 集成。下表的原主集成源码职责据此交接给 W1，不新增独立集成或通用验收窗口；时间语义不变。

### 批准的单一文件 Owner 与交接顺序

| Owner | 唯一写入范围 |
| --- | --- |
| Process 开发负责人 | 流程 action/service、DTO、ProcessStepDialog、QuickAdd、Reschedule、ProcessStepsTable、Timeline |
| Task 开发负责人 | Task 模型、表单、读写、排序分页与列表展示 |
| 主集成负责人 | `src/lib/career/upcomingReadModel.ts`、`src/components/myjobs/UpcomingContainer.tsx`、`src/actions/dashboard/overview.ts`、`src/lib/datetime/*`、双语词条、功能状态清单及合同文档 |
| 后续 Job 开发负责人 | Job 截止日期表单、服务、适配器、读取投影、详情、CSV、Agent；不写 Upcoming 和 Dashboard |

执行顺序：主集成负责人先提供缺失的共享接口与 DTO 合同（已有接口直接复用）→ P-PROC 与 P-TASK 在独立 Worktree/隔离数据中并行 → 主集成负责人接入 Upcoming/Dashboard 与词条 → 定向跨模块验证。P-JO 后续接入，不自动启动。负责人是文件职责角色，具体执行者在分配任务时指定；分支或 Worktree 隔离不改变同一文件单 Owner 约束。

本文档已于 2026-10-27 冻结，作为 `P-TZ`、`P-PROC`、`P-JO`、`P-TASK` 四个工作包的实现依据。本文档不修改任何运行时代码、Schema 或 Migration。

**标注约定**

- 【已有合同】：代码、Migration 或 wiki 文档中已经存在并核实的事实，消费者必须遵守。
- 【建议方案】：本文档提出的待冻结方案，给出具体字段、读写规则和实现建议。
- 【已决策】：§9 D1–D9 已获用户批准，全部采用 A；其余建议按文首冻结记录执行。

## 0. 目的与范围

DateTime V1 的基础库（`src/lib/datetime`）与 Schema 附加列已就绪，但没有任何生产代码读写这些列。本文档回答六个问题：

1. 用户 IANA 时区存哪里、怎么校验、未设置时怎么办、客户端/服务端怎么读。
2. `ApplicationProcessStep` 的 `DateOnly` / `Instant` / 精度 / 时区字段如何读写，历史 `unknown` 数据如何展示且只读不改写。
3. `JobOpportunity.deadlineOn` / `deadlinePrecision` 在表单、详情、CSV、Agent、Upcoming 中如何一致表达。
4. `Task.dueOn` / `duePrecision` 的混合排序、`NULL` 规则、稳定分页和可验证数据规模。
5. Upcoming DTO 和日期显示接口，以及各消费者需要修改的准确文件。
6. 可并行工作包、依赖顺序、共享文件单一 Owner。

非目标：不重新规划 MVP；不新增 Schema 列或 Migration；不实现代码。

## 1. 提案形成时的历史证据（当前状态见文首冻结记录）

### 1.1 已有合同（事实，禁止推翻）

**`src/lib/datetime` 基础库**（已实现并有 spec 覆盖）：

- `DateOnlyString`：规范格式 `YYYY-MM-DD`，严格校验真实日历日期（`parseDateOnly` / `requireDateOnly`）。不代表时间点，不带时区，禁止静默转成 `Date`。
- `InstantIso`：ISO-8601 且必须带 `Z` 或数字 offset；`requireInstantIso` 拒绝裸日期和无 offset 的 wall time。Prisma/SQLite `DateTime` 列以 epoch milliseconds 存储，canonical 写入应使用 `new Date(iso)` 产生的 UTC instant。
- `TimePrecision = "dateOnly" | "minute" | "fullInstant" | "unknown"`。
- `BusinessTimeValue`：`{ kind: "dateOnly", date } | { kind: "instant", iso, precision }`。
- `FIELD_TIME_CONTRACT`（`fields.ts`）已冻结字段语义：
  - `scheduledAt`：必须带时间的 wall time，输入精度 `minute`，需要显式 zone；`parseScheduledAtInput` 拒绝裸日期。
  - `deadlineAt`：`dateOnlyOrDatetime`；裸日期保持 `dateOnly`，带时间 wall time 变 `minute` instant；**不制造 `23:59` / `00:00` 假 instant**（`parseDeadlineAtInput`）。
  - `completedAt`：仅服务端时钟，`completedAtNow()` 生成 `fullInstant`；不接受客户端传入。
- `classifyStoredInstant` / `readStoredInstantAsBusinessTime`：无精度 sidecar 的历史 instant 返回 `unknown`，并附带 `utcMidnight` / `onMinuteBoundary` 诊断标记；**不允许依据 UTC midnight 或 minute boundary 反推 `dateOnly` 或精度**。
- `isDeadlineOverdue(value, now, timeZone?)`：`dateOnly` 在其时区 `[local midnight, next local midnight)` 结束（`endIsoExclusive`）后才 overdue；`instant` 到达后即 overdue；未设置永不 overdue。`timeZone` 缺省回退 `runtimeTimeZone()`——这是 TZ 合同落地前的唯一时区来源，账户合同落地后消费者必须显式传 zone。
- `dateOnlyUtcWindow(date, tz)`：`DateOnly` 在用户时区内的 `[startIso, endIsoExclusive)` 区间；不制造代表性 `23:59:59.999`。
- `wallTimeToInstant`：DST gap 默认拒绝（可选 `shiftForward`），fold 默认取 earlier（可选 later），返回 `disambiguation` 信息。
- `assertValidTimeZone`：以 `Intl.DateTimeFormat` 验证运行时可解析时区；空值、非法值抛 `DATETIME_INVALID_TIMEZONE`。`runtimeTimeZone()` 读取运行时 zone，**不得作为账户级时区的持久化替代**。
- `formatDateOnly`：固定 UTC anchor + `timeZone: "UTC"` 渲染，查看者时区不会导致日期漂移。`formatInstant(iso, locale, timeZone?)` 支持显式 zone，未传时用运行时 zone。
- `serializeBusinessTime` / `parseBusinessTimeValue`：序列化 envelope `{ value, precision }`，往返保留 precision。
- UI 桥接：`dateOnlyFromPickerDate`（picker 的本地 `Date` → `DateOnly`）、`parseTimeOfDay12h`（`"hh:mm AM"` → `{hour, minute}`）。

**Prisma Schema 与 Migration**（`prisma/migrations/20261026000000_datetime_v1_additive_columns`，additive-only）：

- `ApplicationProcessStep`：`scheduledAt DateTime?`、`scheduledAtPrecision String?`、`scheduledAtZone String?`、`deadlineAt DateTime?`、`deadlineOn String?`、`deadlinePrecision String?`、`deadlineZone String?`、`completedAt DateTime?`、`completedAtPrecision String?`。
- `JobOpportunity`：`deadline DateTime?`（旧列）、`deadlineOn String?`、`deadlinePrecision String?`。**没有 zone 列**。
- `Task`：`dueDate DateTime?`（旧列）、`dueOn String?`、`duePrecision String?`。**没有 zone 列**。
- Migration 只加列、全部初始 `NULL`、不 UPDATE、不 backfill，并明确禁止从 UTC midnight 或 local midnight 推断 DateOnly。
- 存储探针结论：Prisma/SQLite `DateTime` 写整数 epoch ms；裸 `YYYY-MM-DD` 写 `DateTime` 列会导致读取失败；DateOnly 必须存 TEXT 的 `*On` 列。
- Backup V4 已覆盖全部 10 个 sidecar 字段；矛盾数据（如 `deadlineAt` 与 `deadlineOn` 同时有值）原样保留，不自动修复。

**UserSettings 原子 patch**（`src/lib/userSettings/patch.ts`）：

- `UserSettings.settings` 是 JSON 文档；`patchUserSettings` 做 read → merge → `updateMany`（精确旧 JSON 字符串）CAS 循环，冲突返回 `SETTINGS_CONFLICT`。
- 深 merge：对象递归合并；标量/数组/`null` 整体替换；键值为 `undefined` 删除该子树（已有 `ai.interview`、`display.theme` 先例）。
- 已注册 namespace：`ai`、`display`、`settings`、`careerProfile`；未注册顶层键被拒绝；`settings` 与 `careerProfile` 走通用 JSON 合并，具体键规则由调用方校验（`updateSettingsLocale` 即先例：action 先 `isValidLocale` 再 patch）。
- `settings.general.locale` 已存在（`GeneralSettings.locale?: Locale`）；**尚无 timeZone 字段**。

**迁移行为**（`src/lib/legacy-migration/migrator.ts`）：legacy `Job.dueDate` → `JobOpportunity.deadline`（instant 原样拷贝），不写新 sidecar；迁移产生的 ProcessStep 不带合成时间。因此所有迁移/历史行的 precision 均为 `NULL` → `unknown`。

### 1.2 已核实的消费者缺口

| 消费者 | 现状 | 缺口 |
| --- | --- | --- |
| ProcessStep 表单/弹窗 | `ProcessStepDialog.tsx`、`QuickAddProcessStep.tsx`、`RescheduleStepDialog.tsx` 用 `DatePicker` 产出本地零点 `Date`，无时间输入 | 日期被写成"伪 instant"；无 precision/zone |
| ProcessStep action/service | `application.actions.ts` `parseOptionalDate` 直接 `new Date(value)`；`applicationService.ts` 只写 `scheduledAt`/`deadlineAt`/`completedAt`，完成时 `new Date()` | 不写 precision/zone；DTO 无精度字段 |
| ProcessStep DTO | `applicationTimeline.ts` `ApplicationProcessStepDTO`：`scheduledAt`/`deadlineAt`/`completedAt` 为简单 ISO 字符串 | 无 `*On`/`*Precision`/`*Zone` |
| Job 表单 | `AddJob.tsx` `dueDate: Date | null`，默认 `addDays(now, 3)`（含时刻），preset 也是带时刻的 `Date` | 只写 `deadline` instant；无 dateOnly 语义 |
| Job 详情 | `JobSummaryCard.tsx` `formatDate(job.dueDate)`；`JobStatusBadge.tsx` `new Date() > job.dueDate` 判断 expired | 无 dateOnly/overdue 区间语义 |
| Job CSV | `src/lib/jobs/exportJobsCsv.ts` 12 列，`createdAt`/`appliedDate` 用 `format(date,"yyyy-MM-dd")`（运行时 zone） | **完全没有 deadline 列** |
| Agent | `canonicalJobRead.ts` `get_job` 返回 `dueDate: isoOf(job.dueDate)`；`add_job` 输入 `dueDate` 为 `z.string().datetime({offset:true})` | 不返回/不接收 `deadlineOn`、`deadlinePrecision` |
| Upcoming | `upcomingReadModel.ts` 只查 `deadline`/`scheduledAt`/`deadlineAt`；`attentionAt` = 较早者；bucket 用 `date-fns` `endOfDay`/`addDays`（宿主时区）；overdue 仅 instant 比较 | 不读 sidecar；bucket/overdue 无用户时区语义 |
| Task 列表 | `queries.ts` `orderBy dueDate asc`（+ priority/createdAt），offset 分页 `skip/take` | 无混排、无 `id` 唯一 tie-break、`NULL` 顺序依赖 SQLite 默认 |
| Task 写路径 | `mutations.ts` 只写 `dueDate`；`addTaskForm.schema.ts` 校验 `Date` 且不早于本地零点 | 不写 `dueOn`/`duePrecision` |
| Dashboard | `overview.ts` `getOverviewReminders` 读 task `dueDate` 与 upcoming `attentionAt` | 不读 `dueOn`/`deadlineOn` |
| Settings | `GeneralSettings.tsx` 仅 locale + Desktop preferences | 无时区 UI |
| i18n | `formatters.ts` `formatDate`/`formatDateTime` 用运行时 zone | 无账户时区来源（format 选项可透传 `{timeZone}`） |

## 2. 用户 IANA 时区合同（P-TZ）

### 2.1 存储位置

- 【建议方案】新增 `settings.general.timeZone?: string`，与 `settings.general.locale` 并列，存于 `UserSettings.settings` JSON 文档。`settings` namespace 已注册且走通用合并，**`patch.ts` 无需改动**；只新增：
  - `src/models/userSettings.model.ts`：`GeneralSettings` 增加 `timeZone?: string`。
  - `src/actions/userSettings.actions.ts`：新增 `updateSettingsTimeZone(timeZone: string | undefined)`，仿照 `updateSettingsLocale`：先 `assertValidTimeZone(timeZone)`，再 `patchUserSettings(userId, { settings: { general: { timeZone } } })`。
- 【建议方案】清除语义：传 `undefined` 删除该键（已有 patch 语义），回到"跟随系统"。**不存储 `"system"`、`"auto"` 等字面量**，避免把伪值混进合法 IANA 集合。
- 【建议方案】读取语义（单一规则，所有消费者共用）：
  - 键缺失 / 值为 `null` / 非字符串 / 非合法 IANA → 视为"未设置"，**不抛错**（防止手改 DB 或备份恢复后整个应用崩溃）。
  - 未设置 → 解析结果为 `runtimeTimeZone()`（跟随系统）。解析结果只用于当次请求/渲染，**永不回写**到 settings。

### 2.2 合法性校验

- 【已有合同】`assertValidTimeZone`（`src/lib/datetime/zoneMath.ts`）是唯一校验入口，基于 `Intl` 验证 IANA ID。写入 action 在 patch 之前调用，非法值直接返回错误、旧值不变。
- 【建议方案】拒绝固定 offset（`+08:00`）、地区别名缩写（`CST`、`PST`）等非 IANA 字符串——账户写入须复用已实现的 `isSupportedTimeZone`：仅用 `Intl` 校验不足以拒绝缩写和裸 offset。

### 2.3 未设置时的默认行为

- 【已决策 D2】推荐：未设置 = 跟随系统运行时 zone（`runtimeTimeZone()`）。理由：本应用是 local-first 单机应用，server/渲染宿主即用户机器，系统时区即用户所处时区；行为与现状完全一致、零迁移。备选：固定 `Asia/Shanghai`——对中国求职市场用户更"确定"，但对任何不在东八区的用户静默错误，且与现状行为不一致。

### 2.4 客户端 / 服务端读取方式

- 【建议方案】服务端：`src/lib/userSettings/timeZone.ts`（新文件）导出 `getUserTimeZone(userId): Promise<string>`——读 `UserSettings.settings`，合法则返回，否则 `runtimeTimeZone()`；调用方（server action、读模型、service）在入口处解析一次，然后**显式**传给 `src/lib/datetime` 的各函数。禁止在业务深处隐式调用 `runtimeTimeZone()` 作为账户语义。
- 【建议方案】客户端：
  - 需要 zone 的读模型/渲染接口在返回 envelope 中带 `timeZone`（见 §6 Upcoming），或经 server component 注入。
  - 纯展示调用统一格式化入口：DateOnly → `formatDateOnly`；Instant → `formatInstant(iso, locale, userTz)` 或 i18n `formatDate/formatDateTime(value, { timeZone })`。禁止消费者 `new Date(dateOnlyStr)`、`toLocaleDateString` 或裸 `date-fns format`。
  - 输入解释（picker、time input）也使用账户时区，而非 Electron 宿主时区——两者在单机上一致时无差异，但语义上以账户时区为准。
- 【建议方案】更新失败行为：`updateSettingsTimeZone` 校验失败或 CAS 冲突返回错误对象，UI toast，settings 中保留旧值；并发更新沿用 `SETTINGS_CONFLICT` 语义。

### 2.5 输入输出示例

```ts
// 写入合法时区
updateSettingsTimeZone("Asia/Shanghai")
// → patch: { settings: { general: { timeZone: "Asia/Shanghai" } } }
// → settings 文档 settings.general.timeZone = "Asia/Shanghai"

// 非法输入
updateSettingsTimeZone("CST")            // → { success:false, message:"Invalid time zone" }，settings 不变
updateSettingsTimeZone("+08:00")         // → 同上
updateSettingsTimeZone("")               // → 同上

// 清除（跟随系统）
updateSettingsTimeZone(undefined)
// → patch: { settings: { general: { timeZone: undefined } } } → 键删除

// 读取
getUserTimeZone(userId)                  // 存储 "Asia/Shanghai" → "Asia/Shanghai"
getUserTimeZone(userId)                  // 未设置 → runtimeTimeZone()，settings 不回写
```

## 3. `ApplicationProcessStep` 合同（P-PROC）

### 3.1 写合同（逐字段）

| 字段 | 输入形态 | 写入列 | 规则 |
| --- | --- | --- | --- |
| `scheduledAt` | `{date, hour, minute}` + 输入时区 | `scheduledAt` = UTC instant；`scheduledAtPrecision` = `"minute"`；`scheduledAtZone` = 输入时区 | 【已有合同】`parseScheduledAtInput` 拒绝裸日期，输入精度 minute。【建议方案】UI 必须提供日期+时间输入；纯日期语义归属 `deadlineOn` |
| `deadlineAt`（dateOnly 分支） | `"YYYY-MM-DD"` + 当前用户时区 | `deadlineOn` = `"YYYY-MM-DD"`；`deadlinePrecision` = `"dateOnly"`；`deadlineAt` = `NULL`；`deadlineZone` = 写入时用户时区 | 【已有合同】`parseDeadlineAtInput` 保留 dateOnly，不造 `23:59` 伪 instant。【已决策 D4】zone 的解释语义 |
| `deadlineAt`（timed 分支） | `{date, hour, minute}` + 输入时区 | `deadlineAt` = UTC instant；`deadlineOn` = `NULL`；`deadlinePrecision` = `"minute"`；`deadlineZone` = 输入时区 | 【已有合同】`wallTimeToInstant`；DST gap 拒绝/fold earlier |
| `completedAt` | 无输入，服务端完成动作 | `completedAt` = `completedAtNow()`；`completedAtPrecision` = `"fullInstant"` | 【已有合同】仅服务端时钟；不接受客户端伪造/截断。Schema 无 `completedAtZone`，**不新增** |
| 清空任一字段 | `null` | 对应 value 与全部 sidecar 同时置 `NULL` | 【建议方案】不留矛盾组合（如 `deadlineOn` 有值但 `deadlinePrecision` 为 `NULL`） |

【建议方案】action 输入形态：`createUserProcessStep` / `updateUserProcessStep` / `rescheduleProcessStep` 的时间参数从 `Date | string` 改为结构化输入——

```ts
type StepTimeInput =
  | { kind: "dateOnly"; date: DateOnlyString }
  | { kind: "wallTime"; date: DateOnlyString; hour: number; minute: number }
  | null;
// scheduledAt 仅接受 wallTime | null；deadlineAt 接受两者 | null
```

服务端用账户时区做 `wallTimeToInstant`/`parseScheduledAtInput`/`parseDeadlineAtInput`。DST gap 按现有合同默认拒绝并向用户报错；fold 默认 earlier，如需 later 由产品另行提出（`wallTimeToInstant` 已支持）。

### 3.2 读合同

- 【建议方案】`ApplicationProcessStepDTO` 增加字段（JSON 兼容，原 ISO 字符串字段保留）：

```ts
scheduledAt: string | null;            // instant ISO
scheduledAtPrecision: "minute" | "unknown" | null;
scheduledAtZone: string | null;
deadlineOn: string | null;             // "YYYY-MM-DD"
deadlineAt: string | null;             // instant ISO
deadlinePrecision: "dateOnly" | "minute" | "fullInstant" | "unknown" | null;
deadlineZone: string | null;
completedAt: string | null;
completedAtPrecision: "fullInstant" | "unknown" | null;
```

- 【建议方案】行 → `BusinessTimeValue` 的确定性规则（consumer 共用，实现于 `applicationService.ts`/读模型，不复制多套判断）：
  1. `deadlineOn` 非空且 `deadlinePrecision === "dateOnly"` 且 `requireDateOnly` 通过 → `{ kind:"dateOnly", date }`。
  2. 否则 `deadlineAt` 非空 → `{ kind:"instant", iso, precision: 合法 precision 值 ?? "unknown" }`。
  3. 两者都空 → 无 deadline。
  4. `deadlineOn` 与 `deadlineAt` 同时有值且 `deadlinePrecision` 不指明 dateOnly → 以 `deadlineAt`（历史事实）为准并视为矛盾数据；Backup V4 已要求原样保留，读路径同样**不修复**。
  5. precision 值不在枚举内（手改 DB）→ 按 `unknown` 处理。
  - `scheduledAt` 同理：有值 → instant，precision = `scheduledAtPrecision`（NULL → `unknown`）。

### 3.3 历史 `unknown` 展示与"只读不改写"

- 【已有合同】历史 instant（precision `NULL`）= `unknown`；禁止用 `utcMidnight`/`onMinuteBoundary` 反推。
- 【已决策 D7】推荐：unknown instant 沿用现状渲染——`formatDate(iso, { timeZone: userTz })` 只显示日期，不新增"伪时刻"；编辑弹窗把原 instant 按用户时区的 wall date 回填 picker；**未修改即保存时不得重写 precision/zone**（`update` 仅写入用户实际改动的字段）。备选：始终显示日期+时间——会把历史零点值渲染成"00:00"，暗示不存在的时刻精度，不推荐。
- 【建议方案】"只读不改写"条款：
  - 任何读路径、列表、timeline、upcoming 不写 precision/zone。
  - 编辑表单未触碰该字段 → 更新语句不包含对应列。
  - 用户实际修改 → 按 §3.1 写新值与新 precision（这是用户的显式声明，允许）。
  - 迁移/备份/恢复路径不回填 precision。

## 4. `JobOpportunity` deadline 合同（P-JO）

### 4.1 Canonical 表达

- 【已有合同】`deadlineOn` / `deadline` / `deadlinePrecision` 三列与 §3 相同的 dateOnly/instant 语义；无 `deadlineZone` 列。
- 【建议方案】**单载体原则**：`deadlineOn` XOR `deadline`，由 `deadlinePrecision` 声明语义——
  - dateOnly：`deadlineOn = "YYYY-MM-DD"`，`deadlinePrecision = "dateOnly"`，`deadline = NULL`。
  - timed instant：`deadline = UTC instant`，`deadlineOn = NULL`，`deadlinePrecision = "minute" | "fullInstant"`。
  - 历史：仅 `deadline` 有值 → `deadlinePrecision = NULL` → `unknown`。
  - 禁止双写（`deadline` = 某边界 instant + `deadlineOn`）——会制造伪 instant 并引入双源漂移。
- 【建议方案】`mapOpportunityToJobView` 的 `JobView` 增加 `deadlineOn`、`deadlinePrecision`；`dueDate` 保留为 `deadline` instant 的兼容投影，纯 dateOnly 行 `dueDate = null`。

### 4.2 各消费者一致表达

- **表单（`AddJob.tsx` / `addJobForm.schema.ts` / `jobOpportunityAdapter.ts` / `opportunityService.ts`）**【建议方案】：
  - picker 产出日历日期 → `dateOnlyFromPickerDate` → 写 `deadlineOn` + `"dateOnly"`，`deadline = NULL`。【已决策 D8】推荐 MVP 不提供时间输入。
  - 日期不再输入"带时刻的 `Date`"：默认推荐值（3 天后）改为 `addDaysToDateOnly(todayDateOnly(userTz), 3)`。
  - 编辑回填：dateOnly → 用本地年月日部件构造 picker `Date`（`new Date(y, m-1, d)`，**不得 `Date.parse("YYYY-MM-DD")`**——UTC 解析在负 offset 时区会回退一天）；历史 unknown instant → 按用户时区取 wall date 回填。
  - 未修改即保存 → 不写 deadline 三列（保留 unknown instant 事实），同 §3.3。
- **详情（`JobSummaryCard.tsx`、`JobStatusBadge.tsx`）**【建议方案】：dateOnly → `formatDateOnly`；instant → `formatDate(iso, { timeZone: userTz })`；expired 判定统一 `isDeadlineOverdue(value, now, userTz)`——dateOnly 在该日于用户时区结束后才过期（相比现状 instant 比较是行为变化：同一天内不再提前过期）。
- **CSV（`exportJobsCsv.ts`、`jobsReadDispatch.ts` 的 `JOB_EXPORT_SELECT`、`getJobsIterator`）**【已决策 D9】推荐：在 `salaryRange` 后追加一列 `Deadline`（i18n key `jobs.deadline`），单元格为 canonical 原文——dateOnly → `"2026-10-25"`；instant → `"2026-10-25T09:00:00.000Z"`（ISO 带 Z）；无 → 空。**不本地化、不截断到日期**——localized `yyyy-MM-dd` 会把 instant 悄悄降精度。备选：再追加 `Deadline Precision` 列；或导出用户时区表达（会丢语义）。
- **Agent（`canonicalJobRead.ts`、`agent.model.ts`、`tools/addJob.ts`、`agent.schema.ts`、`createAgentOpportunity.ts`）**【建议方案】：
  - `get_job` 返回 `deadlineOn`、`deadlinePrecision`，并保留 `dueDate`（= `deadline` instant ISO 或 `null`）。unknown 必须如实标注精度，不得把旧 instant 说成准确 DateOnly。
  - `add_job` 输入合同：`deadlineOn?: "YYYY-MM-DD"`（→ dateOnly）与 `dueDate?: ISO datetime`（→ instant；精度按 `isOnMinuteBoundary` 判定 `"minute"/"fullInstant"`）二选一；两者同传时拒绝或 `deadlineOn` 优先——推荐拒绝以避免歧义。
  - MCP `dueDate` 工具走 legacy `Job.dueDate` 路径，保持 instant，不在 P-JO 范围内。
- **Upcoming**：见 §6。
- **范围声明**：P-JO 只覆盖 canonical `JobOpportunity`；legacy `Job.dueDate`（LEGACY_ONLY 模式与 MCP 写入）保持 instant-only 现状。

## 5. `Task` due 合同（P-TASK）

### 5.1 读写表达

- 【建议方案】与 §4 同构：`dueOn` XOR `dueDate`，`duePrecision ∈ {"dateOnly","minute","fullInstant",NULL→unknown}`。
  - 表单（`TaskForm.tsx` / `addTaskForm.schema.ts` / `task.model.ts` / `mutations.ts`）：picker → `dueOn` + `"dateOnly"`，`dueDate = NULL`。【已决策 D8】推荐 MVP 不做时间输入。
  - "不得早于今天"校验改为 `dueOn < todayDateOnly(userTz)` 拒绝（语义与现状"本地零点"一致，时区来源换成账户时区）。
  - 编辑回填与未修改不改写规则同 §4.2。
  - `Task` DTO 增加 `dueOn`、`duePrecision`；`dueDate` 保留兼容投影。

### 5.2 混合排序合同

- 【建议方案】排序键：把每行的 due 语义映射为单个排序 instant——
  - instant → 该 instant；
  - dateOnly → 该日 `endIsoExclusive`（用户时区内该日结束的 instant）。【已决策 D6】推荐 end-of-day：与 overdue 边界一致（"due 当天有效至日终"），同日 timed instant（如 10:00）排在 dateOnly 行之前，符合直觉。
  - NULL（`dueOn`、`dueDate` 皆空）→ **排尾**。【已决策 D5】推荐排尾，与 `MVP_IMPLEMENTATION.md` 中 OD-B 既定方向一致；不能依赖 SQLite 对 `NULL` 的默认排序，必须在排序逻辑中显式。
- 【建议方案】确定性全序：`sortKey asc → priority desc → id asc`。`id` 为唯一最终 tie-break——现有 `createdAt` 不保证唯一，没有它 offset 分页会出现跨页重复/漏行。
- 【建议方案】同日混排示例（`userTz = Asia/Shanghai`）：
  - T1 `dueDate = 2026-10-25T02:00Z`（= 本地 10:00，minute）→ key `02:00Z`
  - T2 `dueOn = "2026-10-25"` → key `2026-10-26T16:00:00Z`？否——`endIsoExclusive` = 本地 10-26 00:00 = `2026-10-25T16:00:00Z`
  - T3 `dueDate = 2026-10-26T00:30Z`（本地 08:30）→ key `00:30Z+1d`
  - T4 NULL → 排尾
  - 顺序：T1 → T2 → T3 → T4。

### 5.3 分页实现

- 【建议方案】混合键无法用 Prisma `orderBy` 表达（`dueOn` TEXT 与 `dueDate` epoch-ms 混合且需要时区换算），**不允许先取一页再内存混排**（必然分页错误）。推荐两阶段：
  1. `findMany({ where, select: {id, dueOn, dueDate, duePrecision, priority} })` 取全量匹配行的排序字段；
  2. 在服务端按 §5.2 全序排序、切出本页 `id` 列表；
  3. 二次查询 hydrate 本页完整行（含 `activityType`/`activities`），按已计算顺序返回。
  - 备选（不推荐 MVP）：raw SQL 表达式排序（需在 SQL 内做时区换算，不可移植）；新增物化排序列（schema 改动 + 时区变更后 stale，且本任务禁改 schema）。
- 【建议方案】offset 分页保留（`useTasksList` 无限滚动按页取数），前提是排序是全序确定性的——§5.2 的 `id` tie-break 使 offset 分页在快照不变时精确；新增/修改任务导致的顺序漂移属于正常列表语义，不做快照承诺。

### 5.4 可验证数据规模

- 【建议方案】验收数据集（synthetic，隔离 SQLite）：单用户 **5,000** 个 task，分布：60% `dueOn`（dateOnly）、30% `dueDate`（instant）、10% 无 due；其中 ≥200 行共享相同排序键，≥50 行 `NULL`，若干行排序键恰好落在 25/页 的页边界上。页大小 = `APP_CONSTANTS.RECORDS_PER_PAGE = 25` → 200 页。
- 验收点：
  1. 200 页取全后行集与原集合完全相等，无重复、无缺失；
  2. 全序性质全局成立（任取相邻两页交接行满足顺序关系）；
  3. `NULL` 全部位于尾部；
  4. 同一查询多次执行返回完全一致顺序（确定性）；
  5. 单页响应时间实测记录（建议预算 ≤300ms/页，5k 规模下 JS 排序为 O(N log N)，须记录实测结果，不预先承诺达标）。
- 若未来单用户 task 数远超该规模，再评估 raw SQL / 物化键方案——属于后续优化，不在本合同冻结范围。

## 6. Upcoming DTO 与日期显示接口

### 6.1 Upcoming DTO

- 【建议方案】`UpcomingApplicationEvent` 扩展（保留原有字段兼容）：

```ts
type UpcomingApplicationEvent = {
  // ...现有 jobId/applicationId 等字段不变
  scheduledAt: string | null;              // instant ISO
  scheduledAtPrecision: "minute" | "unknown" | null;
  scheduledAtZone: string | null;
  deadlineOn: string | null;               // "YYYY-MM-DD"
  deadlineAt: string | null;               // instant ISO
  deadlinePrecision: "dateOnly" | "minute" | "fullInstant" | "unknown" | null;
  deadlineZone: string | null;
  attentionAt: string | null;              // 派生排序 instant（见下）
};
// action 返回 envelope：{ events: UpcomingApplicationEvent[]; timeZone: string }
```

- 【建议方案】`attentionAt` 派生规则（它是排序/提醒的代表 instant，不是伪造的事实）：
  - 事件 `APPLICATION_DEADLINE`：dateOnly → `dateOnlyUtcWindow(date, userTz).startIso`（当日开始即值得关注）；instant → 该 instant。
  - 事件 `PROCESS_STEP`：`earlierOf(scheduledAt, deadline 的代表 instant)`——scheduled 是 instant；deadline 是 dateOnly 时取 `startIso`。
  - overdue 判定不再用 `attentionAt < now`，统一走 `isDeadlineOverdue(value, now, userTz)`：dateOnly 当日结束才 overdue；instant 到达即 overdue。
- 【建议方案】bucket（`overdue/today/next7Days/later`）边界按**用户时区日历日**计算：`todayDateOnly(userTz)`、`addDaysToDateOnly` + `dateOnlyUtcWindow` 求各日窗口；**替换 `date-fns` `endOfDay`/`addDays` 的宿主时区逻辑**。bucket 函数保留为纯函数，签名增加 `timeZone` 参数，`UpcomingContainer` 从 action envelope 取 zone 传入。

### 6.2 日期显示接口

- 【建议方案】统一规则（所有消费者遵守）：
  - `DateOnly` → `formatDateOnly(date, locale)`（UTC anchor，无漂移）。
  - `Instant` → `formatInstant(iso, locale, userTz)` 或 i18n `formatDate/formatDateTime(iso, { timeZone: userTz })`。
  - `unknown` → 按 instant 渲染日期部分（§3.3 D7）。
  - **禁止**：`new Date(dateOnlyStr)`、`toLocaleDateString`、裸 `date-fns format`、把 DateOnly 塞进需要 instant 的接口。
- 【建议方案】如缺则向 `src/lib/datetime` 只增不改地补充两个 helper（主集成负责人）：`businessTimeDueSortKey(value, tz): InstantIso | null`（仅 §5.2 到期排序；§6.1 关注排序单独使用 startIso）、`formatBusinessTime(value, locale, tz)`（统一分派 dateOnly/instant/unknown 的显示）。若已存在等价实现则复用，不重造。

### 6.3 Dashboard overview 汇合

- 【建议方案】`src/actions/dashboard/overview.ts` `getOverviewReminders`：
  - task 分支 `dueDate lte next7End` → 改为"due 区间与 `[now, next7End]` 相交"：`dueOn` 行按当日窗口参与，`dueDate` 行按 instant 参与；`NULL` 不入选。overdue 标记走 `isDeadlineOverdue`。
  - upcoming 分支复用 §6.1 DTO，`at` 字段沿用 `attentionAt` 语义。
  - 该文件在 Task 与 Upcoming 之间汇合，由主集成负责人独占写入。

## 7. 消费者文件矩阵与单一 Owner

| 文件 | 工作包 | Owner | 改动性质 |
| --- | --- | --- | --- |
| `src/lib/datetime/*` | 全部 | 主集成负责人 | **只增不改**：如需新增 `businessTimeDueSortKey`/`formatBusinessTime` helper |
| `src/models/userSettings.model.ts` | P-TZ | TZ Owner | `GeneralSettings.timeZone` 类型 |
| `src/actions/userSettings.actions.ts` | P-TZ | TZ Owner | `updateSettingsTimeZone` + 读取透传 |
| `src/lib/userSettings/timeZone.ts`、`timeZone.server.ts`（已实现） | P-TZ | TZ Owner | 客户端解析与服务端 `getUserTimeZone` 入口 |
| `src/components/settings/GeneralSettings.tsx` | P-TZ | Settings Owner | 时区选择 UI（IANA 搜索，OD-C） |
| `src/app/dashboard/settings/page.tsx`、`SettingsSidebar.tsx` | P-TZ | Settings Owner | 如需挂接（预计仅复用现有卡片结构） |
| `src/lib/career/applicationService.ts` | P-PROC | Process Owner | step 三字段读写、DTO 映射、complete/cancel 写 `completedAtPrecision` |
| `src/lib/career/applicationTimeline.ts` | P-PROC | Process Owner | `ApplicationProcessStepDTO` 扩展 |
| `src/actions/application.actions.ts` | P-PROC | Process Owner | step 时间入参结构化（§3.1）；upcoming action envelope 由集成负责人提供合同，Process Owner 在本文件接入 |
| `src/components/myjobs/job-details/ProcessStepDialog.tsx` | P-PROC | Process Owner | 日期+时间输入、unknown 回填不改写 |
| `src/components/myjobs/job-details/QuickAddProcessStep.tsx` | P-PROC | Process Owner | 同上 |
| `src/components/myjobs/job-details/RescheduleStepDialog.tsx` | P-PROC | Process Owner | 同上 |
| `src/components/myjobs/job-details/ProcessStepsTable.tsx` | P-PROC | Process Owner | 精度感知显示 |
| `src/components/myjobs/job-details/ApplicationTimelineTab.tsx` | P-PROC | Process Owner | action payload 结构化 |
| `src/lib/career/upcomingReadModel.ts` | P-PROC | **主集成负责人**（Process/Job 交接输入合同） | 读 `deadlineOn`/`deadlinePrecision`/step sidecar、`attentionAt`/overdue/bucket 合同 |
| `src/components/myjobs/UpcomingContainer.tsx` | 集成 | 主集成负责人 | envelope 取 zone、显示按 §6.2 |
| `src/actions/dashboard/overview.ts` | 集成 | 主集成负责人 | task dueOn 汇合 + upcoming 合同对齐 |
| `src/models/addJobForm.schema.ts` | P-JO | Job UX Owner | dueDate → DateOnly 表达 |
| `src/components/myjobs/AddJob.tsx` | P-JO | Job UX Owner | picker → dateOnly；unknown 保留 |
| `src/actions/job/mutations.ts`（含 `job.actions.ts` 透传） | P-JO | Job UX Owner | 结构化 deadline 透传 |
| `src/lib/career/jobOpportunityAdapter.ts` | P-JO | Job UX Owner | 写 `deadlineOn`/`deadline`/`deadlinePrecision`；view 投影 |
| `src/lib/career/opportunityService.ts` | P-JO | Job UX Owner | `OpportunitySafeFields` 接受结构化 deadline |
| `src/lib/career/jobsReadDispatch.ts` | P-JO | Job UX Owner | list/export select 增加三列 |
| `src/components/myjobs/job-details/JobSummaryCard.tsx`、`JobStatusBadge.tsx` | P-JO | Job UX Owner | 显示 + expired 规则 |
| `src/lib/jobs/exportJobsCsv.ts`、`src/app/api/jobs/export/route.ts` | P-JO | Job UX Owner | 追加 deadline 列 |
| `src/lib/agent/canonicalJobRead.ts`、`src/models/agent.model.ts` | P-JO | Job UX Owner | `get_job` 返回新字段 |
| `src/lib/agent/tools/addJob.ts`、`src/models/agent.schema.ts`、`src/lib/agent/prompt.ts`（仅能力描述变化时） | P-JO | Job UX Owner | `deadlineOn` 输入 + 工具描述 |
| `src/lib/career/createAgentOpportunity.ts` | P-JO | Job UX Owner | agent deadline 写入 |
| `src/models/addTaskForm.schema.ts`、`src/models/task.model.ts` | P-TASK | Task Owner | `dueOn`/`duePrecision` 类型 |
| `src/components/tasks/TaskForm.tsx` | P-TASK | Task Owner | picker → dateOnly；unknown 保留 |
| `src/components/tasks/TasksTable.tsx` | P-TASK | Task Owner | dueDate 分组按用户时区日历日 |
| `src/components/tasks/TasksContainer.tsx`、`tasks-container/useTasksList.ts`、`TasksToolbar.tsx` | P-TASK | Task Owner | 分页/分组调用点按需 |
| `src/actions/task/queries.ts` | P-TASK | Task Owner | 混合全序 + NULL 排尾 + 两阶段分页 |
| `src/actions/task/mutations.ts` | P-TASK | Task Owner | 写 `dueOn`/`duePrecision` |
| `src/actions/dashboard/overview.ts` | 见上 | 主集成负责人 | 共享文件，跨包协调 |
| `src/i18n/messages/en.json`、`zh-CN.json` | 全部 | **主集成负责人**（分批追加） | 时区标签、CSV 表头、精度标注文案 |

原则重申：两个 Agent 不得同时写同一物理文件；`upcomingReadModel.ts` 由主集成负责人独占，P-JO 通过 DTO 合同消费；`src/lib/datetime` 任何人不得修改已有导出语义。

## 8. 并行工作包与依赖顺序

1. **Phase 0（本提案冻结，已完成）**：2026-10-27 用户批准 §9 全部 A 及文首执行边界。
2. **P-TZ 合同层**（已实现，复用）：`GeneralSettings.timeZone` 类型 + `updateSettingsTimeZone` + `getUserTimeZone`。Settings UI 选择器可随后续排期，不阻塞其他消费者——它们依赖的是读取合同而非 UI。
3. **并行层**（任一顺序，文件不相交）：
   - `P-PROC`：§7 中流程表单、action/service、DTO、Timeline；Upcoming/overview 按文首批准归属交由主集成负责人。
   - `P-JO`：Job UX Owner 全部文件（不触碰 `upcomingReadModel.ts`，依赖其 DTO 形状——已在本合同冻结）。
   - `P-TASK`：Task Owner 全部文件（不触碰 Process 共享文件；`overview.ts` 由单一 Owner 处理）。
4. **P-INT**：跨模块回归（Upcoming 三种事件 + task 混排 + settings 时区切换后的展示/overdue 一致性）。
5. i18n 文案由主集成负责人在各包接口冻结后分批追加。

## 9. 已冻结决策清单（2026-10-27 全部采用 A）

| # | 决策点 | 选项 | 推荐 | 理由 |
| --- | --- | --- | --- | --- |
| D1 | 时区存储键与清除语义 | A. `settings.general.timeZone`，键缺失=跟随系统，`undefined` 删除；B. 新顶层 namespace | **A** | 复用已注册 namespace 与通用 merge，`patch.ts` 零改动；与 `locale` 并列符合直觉 |
| D2 | 未设置时区默认 | A. 跟随系统（`runtimeTimeZone()`，不回写）；B. 固定 `Asia/Shanghai` | **A** | local-first 单机，系统时区即用户时区；行为与现状一致；B 对非东八区用户静默错误 |
| D3 | `scheduledAt` 是否允许纯日期 | A. 必须带时间（FIELD_TIME_CONTRACT 现状）；B. 放宽允许 dateOnly | **A** | 已有合同已定；纯日期需求由 `deadlineOn` 表达，语义不混淆 |
| D4 | `*Zone` 列语义 + DateOnly 解释时区 | A. 写入时记录输入时区，排序/overdue/显示始终按**当前**用户时区解释；B. 钉死存储时区 | **A** | DateOnly 是"那一天"的日历事实，跟随时区变化最符合用户预期；zone 列保留作审计/输入溯源 |
| D5 | Task `NULL` due 排序位置 | A. 排尾；B. 排首 | **A** | 与 wiki 既定 OD-B 方向一致；"无截止"不应抢占注意力 |
| D6 | dateOnly 在混排中的排序点 | A. `endIsoExclusive`（日终）；B. `startIso`（日初） | **A** | 与 overdue 边界一致："due 当天有效至日终"；同日 timed 项先到期先排 |
| D7 | 历史 `unknown` 显示 | A. 按用户时区渲染日期（现状视觉），编辑未动不改写；B. 显示日期+时间 | **A** | 历史零点值渲染出 "00:00" 会暗示不存在的时刻精度 |
| D8 | Job/Task 表单是否提供时间输入 | A. MVP 仅日期 → `deadlineOn`/`dueOn`；B. 加时间输入 → instant | **A** | 国内求职截止惯例为日期；时间输入走 Agent/后续扩展，UI 复杂度最小 |
| D9 | CSV deadline 表达 | A. 末位追加单列 `Deadline`，dateOnly 原文 / instant ISO；B. 追加 value+precision 两列；C. 本地化格式 | **A** | canonical 原文即可由形状区分 dateOnly/instant，零语义损失、列数最少；C 会把 instant 悄悄降精度 |

**上下文说明**：`MVP_IMPLEMENTATION.md` 中 OD-A/B/C 的具体选项文字未写入仓库，本节将已知方向（OD-B → NULL 排尾 → D5；OD-C → IANA 搜索选择器 → 设置 UI 实现细节）与本提案决策项对齐；如用户记忆与本文推荐冲突，以用户裁决为准。

## 10. 验收样例与边界用例

### 10.1 输入输出样例

**ProcessStep 写入**（userTz = `Asia/Shanghai`）：

```ts
// scheduled 输入 {kind:"wallTime", date:"2026-03-15", hour:14, minute:30}
→ scheduledAt = "2026-03-15T06:30:00.000Z"
→ scheduledAtPrecision = "minute", scheduledAtZone = "Asia/Shanghai"

// deadline 输入 {kind:"dateOnly", date:"2026-03-15"}
→ deadlineOn = "2026-03-15", deadlinePrecision = "dateOnly"
→ deadlineAt = NULL, deadlineZone = "Asia/Shanghai"   // D4 推荐

// 输入 {kind:"dateOnly"} 给 scheduledAt → 校验错误，拒绝（D3）
```

**历史行展示**：`deadlineAt = "2026-03-15T16:00:00.000Z"`（precision NULL）→ `unknown` → 列表显示用户时区当日日期；编辑弹窗回填 wall date；未修改保存 → 不写任何 precision/zone 列。

**Task 排序**：见 §5.2 示例。

**Upcoming DTO**：

```json
{
  "timeZone": "Asia/Shanghai",
  "events": [{
    "scheduledAt": "2026-03-15T06:30:00.000Z",
    "scheduledAtPrecision": "minute",
    "scheduledAtZone": "Asia/Shanghai",
    "deadlineOn": "2026-03-20",
    "deadlineAt": null,
    "deadlinePrecision": "dateOnly",
    "deadlineZone": "Asia/Shanghai",
    "attentionAt": "2026-03-15T06:30:00.000Z"
  }]
}
```

**CSV**：`deadlineOn = "2026-03-20"` → 单元格 `2026-03-20`；`deadline` instant → `2026-03-20T16:00:00.000Z`；均无 → 空。

### 10.2 边界用例

| 用例 | 合同行为 |
| --- | --- |
| 用户时区未设置 | 全部按 `runtimeTimeZone()` 解析与显示（D2-A），settings 不回写 |
| settings 中存了非法时区 | 读取按未设置处理，不崩溃；设置 UI 显示"跟随系统" |
| 用户改了时区 | DateOnly 语义随新时区重解释（D4-A）；已写 instant 不变；`*Zone` 列保留写入时区作溯源 |
| DST gap 中的 wall 输入 | `wallTimeToInstant` 默认拒绝 → 表单报错，不静默 shift |
| DST fold | 默认 earlier；如产品要给用户选择，需另行提出 |
| `deadlineOn` + `deadlineAt` 同时有值 | §3.2 确定性规则；原样保留不修复；显示按 precision 声明或 `deadlineAt` |
| precision 值不在枚举 | 按 `unknown` 处理 |
| `deadlineOn` 文本非法 | `requireDateOnly` 抛错 → 数据面错误，不静默降级 |
| 编辑表单未触碰日期字段 | 更新语句不写该字段任何列（unknown 保留） |
| dateOnly 预填 picker | `new Date(y, m-1, d)` 本地构造；禁止 `Date.parse("YYYY-MM-DD")` |
| Agent 传裸日期 | `deadlineOn` 分支；Agent 传带秒 datetime → 按 `isOnMinuteBoundary` 定 `minute`/`fullInstant` |
| Task 排序键并列 | `priority desc → id asc`，跨页零重复 |
| 新增任务改变排序 | 下一页基于最新快照，属正常列表语义 |
| `dueOn` < 今日 | 表单拒绝（`todayDateOnly(userTz)` 比较） |

### 10.3 兼容性声明

- 所有新列保持 `NULL` 即"未声明精度"，历史行为不回退：旧 instant 仍按 instant 比较、仍显示（未知精度），不写回。
- `dueDate`/`deadline`/`scheduledAt`/`deadlineAt` 旧列保留为 instant 载体与兼容投影来源，不删除、不回填。
- Legacy `Job.dueDate` 与 MCP 工具路径行为不变。
- Backup V4 的"矛盾数据原样保留"与 §3.2 读取规则一致。
