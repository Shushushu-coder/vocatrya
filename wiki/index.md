# Vocatrya Wiki 文档索引

`wiki/` 保存 MVP 开发所需的**项目协调、实施记录与领域合同**，不包含运行时代码。本文是目录入口；下列四份文件是当前核心文档。

## 文档导航

| 文档 | 定位 | 何时阅读 |
| --- | --- | --- |
| [`MVP_FEATURES.json`](./MVP_FEATURES.json) | **功能状态与验收清单**：28 项 `IN_SCOPE` Feature，包含 ID、类别、优先级、实现状态、验收步骤和 `passes`。 | 选择下一项任务、确认功能缺口或核对验收状态时。 |
| [`MVP_IMPLEMENTATION.md`](./MVP_IMPLEMENTATION.md) | **实施计划与事实台账**：各 Feature 的实现评估、W1–W7 工作包、文件 Owner，以及按时间倒序维护的集成与验收记录。 | 理解 MVP 范围、工作包依赖、文件归属或追溯集成情况时。 |
| [`CAREER_SCHEMA_CONTRACT_PROPOSAL.md`](./CAREER_SCHEMA_CONTRACT_PROPOSAL.md) | **职业资料 Schema 冻结合同**（2026-10-27 已批准）：CP-SCHEMA、CP-RECORDS、CP-PRIVACY 的字段和模型基线、派生规则、备份兼容、D1–D18 决策；文首含已集成 Main 的 BD-LINKS 补充合同（`CareerSkillDetail.tagId` 真实 FK、Backup V6）。 | 实施或修改职业资料、关联数据、隐私和备份相关工作包前。 |
| [`DATETIME_CONSUMER_CONTRACT_PROPOSAL.md`](./DATETIME_CONSUMER_CONTRACT_PROPOSAL.md) | **DateTime 消费者冻结合同**（2026-10-27 已批准）：P-TZ、P-PROC、P-JO、P-TASK 对 `src/lib/datetime` 的消费规则，包括 `DateOnly`、`Instant`、精度/时区、历史 `unknown`、排序分页、CSV 和文件 Owner 交接。 | 实施或修改时间语义及相关业务消费者前。 |

## 使用原则

- **先按任务读取**：普通功能开发不必通读整个 `wiki/`。先查对应 Feature；仅当涉及范围、依赖或领域约束时再打开相关文档。
- **状态与验收分离**：代码已实现、已集成 Main，不等于最终验收通过。`passes: true` 只能在该 Feature 指定的用户验收步骤全部通过后设置；`passes: false` 也不代表尚未编码。
- **状态单一 Owner**：`MVP_FEATURES.json` 由 Main 集成 Owner 维护；并行 Agent 不直接争用该文件。
- **合同优先**：两份名称保留 `PROPOSAL` 的领域文档均已获批准，不能按“待讨论草案”处理。涉及相应工作包时遵守冻结约束及文件 Owner/交接顺序；如需改变合同，先明确提出变更。
- **避免重复记录**：Feature 状态以 JSON 为准；实施与集成历史以 `MVP_IMPLEMENTATION.md` 为准；具体领域决策以对应合同为准。不要把同一进度复制到多个文件。
