# P2 定向桌面补验

覆盖 JOB-CONNECTIONS、NEXT-ACTIONS、CAREER-INSIGHTS。工具由 A worker 的准备包整理；不改产品代码、验收条件或 Feature passes。

在 Windows 的独立 Worktree 内使用本机 Node、私有项目依赖、Prisma client 和 Electron runtime。依赖不得通过 junction 指向其他窗口的可写 node_modules。所有数据、下载、观察日志和构建快照写入本 Worktree 的 `.tmp/p2-closure-ready/`，不提交运行产物。准备时记录实际 HEAD；切换提交后必须创建新 run，不能复用旧 manifest。

## 非桌面准备

从仓库根执行，run 名称必须全新；首次 validate 在扩展前执行。已有 run 或失败产物保留，重新准备使用新名称。

```powershell
node scripts/p2-closure-ready/package.mjs prepare --run .tmp/p2-closure-ready/runs/new-run
if ($LASTEXITCODE -ne 0) { throw 'prepare failed' }
node scripts/p2-closure-ready/package.mjs validate --run .tmp/p2-closure-ready/runs/new-run
if ($LASTEXITCODE -ne 0) { throw 'validate failed' }
node scripts/p2-closure-ready/desktop-run.mjs prepare --run .tmp/p2-closure-ready/runs/new-run
if ($LASTEXITCODE -ne 0) { throw 'desktop fixtures failed' }
node scripts/p2-closure-ready/desktop-run.mjs validate --run .tmp/p2-closure-ready/runs/new-run
if ($LASTEXITCODE -ne 0) { throw 'preflight failed' }
```

首批 prepare 创建隔离迁移库、fresh-native 激活、双用户、同职位双申请、多简历版本、有效 PDF、非宿主账户时区和唯一待复盘对象。validate 实际检查提交快照、PDF解析、日期边界、读模型无写入与附件权限。固定日期样本用于确定性后端检查；它不是动态时区 UI 验收证据。第二批 prepare 增加真实 Upcoming 前置、未投递过滤对照与 SQLite 写入观察器；Upcoming 有时效，过期时使用新 run。

## 获授权后的桌面入口

仅在主协调窗口明确指定唯一执行者、代码版本并确认其他重型序列已释放后运行；本轮集成授权不包括此命令。

```powershell
node scripts/p2-closure-ready/desktop-run.mjs run-authorized --run .tmp/p2-closure-ready/runs/new-run
```

复用 `desktop/e2e/launcher.mjs` 的显式源码快照、磁盘保护、生产构建、装配及进程回收。使用准备数据根启动真实 Windows Electron fresh-native/full，通过 UI 执行关联、换绑/解绑、编辑后历史不漂移、实际下载、归档恢复、下钻、复盘草稿及完成、退出重开。

P2 单次执行 claim 防止重复使用已变更的场景数据。后端仅在生成的隔离 server 入口插入观察器，记录插桩前后哈希；观察器拒绝非 loopback 出站连接。零 AI/写入结论限于该插桩实例和观察窗口，不能外推为未插桩生产应用的全局证明。SQLite 触发器观察真实业务写入；Reminder tick 单独归因，无法唯一识别编译后的 action 时失败，不猜测 PASS。每步 evidence 写入 run/checks，缺失步骤仍为 NOT_RUN。

## 验证与限制

集成前临时版本已通过 3 文件/74 项定向测试、prepare/validate、语法及启动前检查。迁入受控路径后另行在全新 run 验证。桌面驱动、生产构建及装配尚未运行。

备份往返、完整运行家族矩阵、规则失败静默、实际页面错误边界及动态时区 UI 场景仍未覆盖。准备就绪不等于三项 Feature 验收通过。流程边界见 `desktop/E2E.md`；共享 Feature 状态由 Main 集成 Owner 维护。
