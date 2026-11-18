# 托管 AI Beta 边界与桌面补验

工具由 B worker 的准备包整理，复用真实 Hosted/Operator 服务实现并连接本地假上游，所有 listener 仅绑定 `127.0.0.1` 动态端口。不会读取历史 `.private`、session-token、用户库或真实上游凭据，也不解除正式 `COMING_SOON` 发布门。

从仓库根运行，要求独立锁定依赖、Prisma client、Windows Electron runtime。运行数据位于 `.tmp/managed-closure-ready/`；manifest、合成 Key、operator/control 凭据和账本均不提交。Key 仅写任务数据文件，普通日志只输出文件路径与脱敏状态。

## 非桌面边界

```powershell
$fixture = node scripts/managed-closure-ready/fixture.cjs prepare | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'prepare failed' }
$fixtureRun = $fixture.runId
node scripts/managed-closure-ready/fixture.cjs start $fixtureRun
if ($LASTEXITCODE -ne 0) { throw 'start failed' }
try {
  node scripts/managed-closure-ready/fixture.cjs health $fixtureRun
  if ($LASTEXITCODE -ne 0) { throw 'health failed' }
  node scripts/managed-closure-ready/boundary.cjs $fixtureRun
  if ($LASTEXITCODE -ne 0) { throw 'boundary failed' }
} finally {
  node scripts/managed-closure-ready/fixture.cjs stop $fixtureRun
  if ($LASTEXITCODE -ne 0) { throw 'cleanup failed; inspect owned PID' }
}
```

17 步通过实际本地 HTTP/权威账本核对无权益、状态/周期过期、最后额度竞争、幂等重放、并发、operator 续期刷新、周期额度冻结、runtime 禁用、失败 UNKNOWN 及会话过期换 Key。最后一项等待真实至少 60 秒 TTL；`boundary.cjs` 输出每步证据及非零失败状态，不构建或启动 Electron。UNKNOWN grace 的短时间值只属于隔离 fixture。

查看脱敏状态用 `fixture.cjs state <runId>`；`issue <runId> <user> [ttl-seconds]` 只返回 Key 文件路径。`subscription <runId> <user> <status> <plan> <start-ms> <end-ms>`、`runtime <runId> disabled|enabled`、`mode <runId> success|hold|drop|http401|http429|http500|malformed` 是仅对本轮本地服务有效的故障控制。退出仅停止经控制凭据确认的所属 PID。

## 获授权后的桌面入口

桌面必须使用新创建、未跑 HTTP suite 且 nativeRoot 不存在的 fixture。先 prepare/start/health，再执行：

```powershell
$plan = node scripts/managed-closure-ready/managed-desktop.mjs validate $fixtureRun --case=all | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'configuration invalid' }
```

validate 只核查源码/支持文件哈希、私有依赖、loopback 环境与 manifest，不启动构建或桌面。停止服务后的 manifest 不是 READY，重新创建/启动后须重新 validate；端口、Key 与 digest 均不得照抄历史值。

以下重型命令须另获授权，由主协调指定唯一执行者和代码版本，并先确认共享资源已释放。使用上一步实际输出的 digest：

```powershell
node scripts/managed-closure-ready/managed-desktop.mjs execute $fixtureRun --case=all --serial-owner=coordinator --expected-source=$($plan.executionDigest)
```

也可用 `--case=quota|entitlement|lifecycle` 选择范围。启动器复用现有显式源码快照/构建/装配及磁盘保护，显式透传本轮 loopback `desktopEnv`，记录真实 fresh-native/full、构建来源、PID 与退出重开。局部 lock 只能约束本 Worktree，不能取代机器级协调。测试结束须调用 fixture stop；不自动删数据或其他窗口资源。

## 当前版本定向复验

客户端计时补丁（broker 调用 20 秒，Hosted 预算在取得 token 之后）和加强后的脚本已在 Main `7eb308aa`。不要重做这些补丁。历史生产构建 `q5e8GhkT0CKpYa0guG7yq` 的 20/20 不是当前版本证据。DPAPI 读取/退出失败的根因仍未证实，重试成功不能当作根因。正式发布保持 `COMING_SOON`。

非桌面驱动前置（合成，不是可用竞争连接验收）：

```powershell
node scripts/managed-closure-ready/no-fallback-preflight.cjs
```

通过时标准输出和 `.tmp/managed-closure-ready/preflight-no-fallback/result.json` 的 `evidenceClass` 为 `SYNTHETIC_DRIVER_PREFLIGHT`，`usableAccountOrByokAcceptance` 为 `BLOCKED`。

桌面由主协调指定的唯一执行者在本 Worktree 运行。每条 execute 单独 prepare/start/health 一个未跑过 HTTP suite、且 `nativeRoot` 不存在的 fixture。数据目录是该 fixture 的 `nativeRoot`（`.tmp/managed-closure-ready/runs/<runId>/native`）。validate 输出的 `executionDigest` 只对应当次磁盘上的源码与支持文件；产品源码或本目录脚本变化后必须重新 validate，不能复用旧构建或旧 digest。

```powershell
node scripts/managed-closure-ready/managed-desktop.mjs validate $fixtureRun --case=quota
node scripts/managed-closure-ready/managed-desktop.mjs execute $fixtureRun --case=quota --serial-owner=coordinator --expected-source=$($plan.executionDigest)
```

`--case=quota` 覆盖额度成功、额度拒绝，以及竞争来源无回退。另一条全新 fixture 用 `--case=lifecycle` 覆盖冷读取、会话到期、换 Key、备份扫描和退出重开。`--case=entitlement` 只在需要复看无权益/过期提示时另开 fixture。不要用这两条命令声称公网网关或真实模型已验收。

未设置 `VOCATRYA_MANAGED_COMPETING_CONFIG` 时，`competing-sources-no-fallback` 记为 `BLOCKED`，原因 `USABLE_ACCOUNT_OR_BYOK_NOT_CONFIGURED`。其余步骤无失败时进程退出码为 2。这不是产品断言失败；退出码 1 才是。该 BLOCKED 不证明可用账号/BYOK 已通过。执行者自行提供的配置文件不入库、不写入证据，形如 `{"acceptance":"USABLE_COMPETING_CONNECTION","byok":{"callable":true,"apiKey":"..."},"account":{"callable":true,"runtimeProfileRef":"..."}}`。账号运行时不会被主动探测，证据里的 `accountRuntimeProbed` 保持 false。

## 仍待 Owner 裁定

正式套餐的周期、额度上限和包含的产品模型尚未裁定。客服续费、补发或更换 Key 的操作规则尚未裁定。已定范围仍是 Key 加无 Key 联系客服，不做支付闭环；本入口不修改这些规则。

## 已有证据与交付边界

临时准备包已通过 Hosted 6 文件/120 项、客户端 5 文件/83 项、服务类型检查、HTTP 17 步及桌面配置检查；迁入受控路径后重新验证准备入口。没有执行生产构建、装配或 Windows Electron。

2026-11-12 任务 B 的历史生产构建 `q5e8GhkT0CKpYa0guG7yq` 已运行 Windows Electron fresh-native/full，原脚本记录 20/20，含正常退出 IPC 和同目录重开；HTTP 边界 17/17。证据在 `.worktrees/managed-ai-closure/.tmp/managed-closure-ready/`，确切源码、产物和覆盖边界见 Wiki。

合并复核修正了三处边界：Hosted 超时从取得凭据后计时；备份须扫描所有解压条目（`scan-archive.cjs`），不能仅扫描 DEFLATE 压缩字节；无回退场景须实际提交、收到期望错误码并匹配 backend 观察记录。既有 ZIP 解压复核通过；客户端计时修复和加强后的桌面脚本仍未重跑当前版本 Electron，不能把原 20/20 当作当前版本证据。当前脚本在没有执行者提供的可用凭据时把该步记为 BLOCKED，不再用不可调用的合成引用获得通过。假上游不代表真实模型或正式公网服务验收。

Owner 已批准“Key + 无 Key 联系客服，不做支付闭环”。Key 是会话凭证，默认 24 小时、最长 7 天，换 Key 不充值；当前周期额度冻结；订阅没有 PAUSED；普通上游错误可进入 UNKNOWN 并保留 reservation。正式套餐周期/额度/模型、客服续费及发 Key 规则仍待裁定。正式发布门、公网 endpoint 和部署需单独授权，AI-MANAGED 保持 PARTIAL / passes:false。
