# Vocatrya — Agent Development Rules

## 1. Project

- Vocatrya 是面向中国求职市场的 local-first 职业与求职管理软件，技术栈为 Next.js、TypeScript、Prisma、SQLite、Electron。
- 优先交付可用的 Windows MVP，保留 Web-first 架构。

## 2. Coding Principles

- **Coding first**：目标明确且已授权的任务直接实施；只读取相关上下文，不额外规划、审计或反复确认。
- **Stay in scope**：只改必要内容，复用现有实现；不做无关重构、格式化或提前优化。
- **Fix what you introduce**：本次改动造成的问题在授权范围内直接修复；无关问题简短报告，不扩项。
- **Parallel friendly**：遵守共享物理文件的单一 Owner，不覆盖其他 Agent 的修改；无关任务不互相阻塞。
- 未获授权不自动开始下一任务。

## 3. Workspace & Safety

- 新建 Worktree 放在主仓库 `.worktrees/<task-name>/`；临时文件放在 `.tmp/<task-name>/`，工具要求固定路径时除外。
- 修改前确认当前仓库、分支和 Git 状态，保护已有 Dirty、暂存内容及其他 Worktree。
- 开发测试使用隔离环境；保护真实数据库、备份、密钥、环境配置和安装版，禁止泄露或提交敏感数据。
- 不改写已执行的 Migration；Schema 修改通过新 Migration。保留 Legacy/Canonical/Agent、权限及安全兼容契约。
- Commit、Merge、Push、Release、部署、真实数据操作和破坏性删除均需各自明确授权；禁止擅自 `git clean`、强制重置或强制推送。
- 只清理自己产生且确认无用的临时文件；不删除未知文件或他人的工作。

## 4. Session Startup & Task Dispatch

- **用户指定任务**：读取对应 Feature、相关代码及当前修改，直接执行，不重新规划整个 MVP。
- **用户问下一步**：读取 `wiki/MVP_FEATURES.json`；必要时参考 `wiki/MVP_IMPLEMENTATION.md`。核对实际代码、Git 状态和阻塞，推荐一项有真实缺口、可独立交付的高优先级任务；未经授权不实施。
- `passes: false` 不等于尚未编码。已实现的功能只安排缺失的验收，不重复开发。
- **并行分配**：确认每项任务的实际缺口、依赖和物理文件 Owner；共享文件指定单一写入者或交接顺序。不要为了凑窗口数量强行拆任务。
- 执行指令只需明确目标、缺口、范围、文件归属和验收标准；通用规则不重复抄写。
- 不默认扫描整个仓库、追溯 Git 历史或运行启动测试。

## 5. Session Handoff

- 仅当未完成任务需要暂停或跨会话交接时，在当前 Worktree 的 `.tmp/<feature-id>/handoff.md` 记录：已完成、待办、修改文件、验证、阻塞。
- 接续时先核对 Handoff 与当前 Git Diff，从实际进度继续；正常完成不创建交接文件。
- 活跃 Handoff 不得提前清理；跨 Worktree 或机器交接前须确保必要信息可用。

## 6. Feature Status & Integration Closure

- 区分**代码实现、Main 集成、功能验收**。普通功能可经必要定向检查后受控集成，再集中进行用户验收。
- `wiki/MVP_FEATURES.json` 由 Main 集成 Owner 维护：成功集成后同步实现状态；验收条件全部满足才能设 `passes: true`，不得降低条件。未验收保持 `false`。
- 已获提交授权时，状态更新优先与功能代码同次提交；`wiki/MVP_IMPLEMENTATION.md` 仅在范围、依赖或策略实质变化时更新。
- 用户询问文档是否更新只是查询，不自动触发写入。
- 更新 `wiki/` 后，须在完成报告中主动说明更新的文件及主要内容。
- 集成后检查相关 Worktree 的独有提交、未提交内容和进程占用。只有确认安全且获清理授权后才移除；Dirty 内容不可凭“已合并”直接丢弃。
- 无法清理的 Worktree 说明原因，不阻塞其他任务；不为收尾另设 Review 或 Gate。

## 7. Impact-Based Validation & Delivery

- 默认**最小充分验证**：按实际风险与受影响消费者选择定向检查，先核对项目已有命令；不默认全量测试、Build、E2E、独立 Review 或多轮 Gate。
- 涉及共享契约、跨模块业务、持久化、并发/异步、认证安全、Migration/备份、Electron 运行时，或影响不清且有实质风险时，按需阅读 `AGENTS_VALIDATION.md`；阅读不自动触发额外测试。
- 用户可见行为按需核对实际路径；持久化使用隔离数据验证保存与重新打开。Mock 或代码存在不等于功能验收。
- 高风险变更保留必要的兼容、失败恢复与安全验证；验证不能替代操作授权。
- 已有证据充分时停止；真实失败只做相关修复或说明阻塞，不为无关问题扩项。
- 完成后简短报告：修改、实际验证、未完成验收或阻塞、Git/Worktree 状态。不生成额外审计报告。
