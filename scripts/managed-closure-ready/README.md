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

## 已有证据与交付边界

临时准备包已通过 Hosted 6 文件/120 项、客户端 5 文件/83 项、服务类型检查、HTTP 17 步及桌面配置检查；迁入受控路径后重新验证准备入口。没有执行生产构建、装配或 Windows Electron。

桌面脚本仍待实跑；实际备份导出检查、竞争账号/BYOK 配置下的无回退组合尚未覆盖。假上游只证明本地边界，不能冒充真实模型或正式公网服务验收。

Owner 已批准“Key + 无 Key 联系客服，不做支付闭环”。Key 是会话凭证，默认 24 小时、最长 7 天，换 Key 不充值；当前周期额度冻结；订阅没有 PAUSED；普通上游错误可进入 UNKNOWN 并保留 reservation。正式套餐周期/额度/模型、客服续费及发 Key 规则仍待裁定。正式发布门、公网 endpoint 和部署需单独授权，AI-MANAGED 保持 PARTIAL / passes:false。
