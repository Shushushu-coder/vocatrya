# Vocatrya

仓库开发规则见 [AGENTS.md](./AGENTS.md)；本文件仅补充工具使用约定。

- 本仓库已建 CodeGraph 索引（`.codegraph/`，派生产物不提交）：定位符号、查调用方/被调方、评估改动影响面（`impact`）或牵连测试（`affected`）等有增益时，优先 `codegraph explore`/`node` 或对应 MCP 工具，再按需 grep/read 核实；大批量变更后 `codegraph sync` 保持同步。Worktree 内需要索引时，复制主检出 `.codegraph/` 到该 Worktree 再 `codegraph sync`，不要跨 Worktree 共享同一 DB。
