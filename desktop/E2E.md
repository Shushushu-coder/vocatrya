# Windows 桌面开发与 E2E

Vocatrya 当前交付形态是 Windows Electron 桌面应用。Next.js 是内部界面与本地后端；浏览器验证用于共享页面逻辑回归。用户未指定宿主时，“打开应用、实测、E2E、验收”默认指隔离的 Windows 桌面端。

## 选择入口

| 命令 | 实际范围 |
| --- | --- |
| `npm run dev` / `npm run dev:webpack` | Web 页面开发服务器，无 Electron 壳 |
| `npm run desktop:poc` | 旧 POC 便捷命令；还会准备固定 POC 库，隔离启动请用下文分步命令 |
| `npm run desktop:dev` | 旧 POC 便捷命令，重组已有 `.next/standalone`，不重建页面；同样准备固定 POC 库 |
| `npm run test:e2e:web -- e2e/signin.spec.ts` | 浏览器回归，需按贡献指南准备隔离迁移库；旧名 `test:e2e` |
| `npm run test:desktop:unit` | Electron 主进程 Vitest 测试；旧名 `test:desktop` |
| `npm run desktop:smoke` | 开发桌面启动/截图冒烟，不能证明用户流程通过 |
| `npm run test:e2e:desktop` | 本文的真实窗口注册、导航、退出重开 E2E；不安装、不发布 |

## 手动源码启动

在全新独立 Worktree 安装依赖，不复制真实 `.env` 或旧数据，然后用 PowerShell 指定全新的目录。分步启动，跳过旧 POC 的固定数据库准备脚本，由 Electron 自己迁移/激活隔离库：

```powershell
$env:VOCATRYA_DESKTOP_DATA_ROOT = Join-Path $PWD ('.tmp/manual-desktop-' + [guid]::NewGuid().ToString('N'))
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
npm run desktop:assemble
if ($LASTEXITCODE -ne 0) { throw 'Assembly failed' }
node node_modules/electron/cli.js .
```

安装版及 `%LOCALAPPDATA%/Vocatrya` 是真实用户环境，不作为自动测试目标。不设置隔离目录的开发启动可能走旧 POC 数据路径，不能代表当前新用户流程。不要把真实 `.env`、数据库或密钥复制进测试目录。

## 自动桌面 E2E

Agent 仅在用户明确启动最终验收、发布前验证或批准提前定位时执行本节命令；普通开发、修复及集成授权不包含 E2E。按 `AGENTS.md` 串行安排构建、装配和桌面测试，停止聊天后仍须核对所属进程是否退出。

前提：Windows、Node/npm、已安装仓库依赖，有可用桌面会话。可在 `.worktrees/<task>/` 独立运行；本入口从明确的源码/构建配置副本执行 Next 生产构建，不读取原 Worktree 的 `.env`、数据库或 `.next`，也不使用 Turbopack。

```powershell
npm run test:e2e:desktop
```

启动器每次重建当前源码，并在本 Worktree 的 `.tmp/desktop-e2e/<unique-run>/` 创建独立应用副本、后端制品、数据库和 Chromium profile。它不复用旧构建、已安装应用、固定调试端口或旧日志，也不使用 `_electron.launch` 的 ready loader。启动环境只传入必要的 OS 变量、合成测试配置和 Node 路径，不继承真实账号/AI 凭据或 `ELECTRON_RUN_AS_NODE`。

分阶段等待本轮后端 HTTP、动态 CDP 端点、同源应用窗口，随后核对：

1. 数据库与后端日志均为 fresh-native（`FRESH_READY / AB_ENABLED / full`）。仅 Migration 成功不足以满足条件。
2. 页面有真实 preload 桥接与可见桌面标题栏。
3. 从中文注册页面创建新测试账号，自动登录。
4. 侧边栏符合当前生产入口，无自动化巡检、无开发者入口；逐项点击并检查目标内容与错误。
5. 新建菜单位于最上方桌面标题栏，顶部不再提供上传入口，Web Header 的备用操作栏隐藏。
6. 通过应用退出 IPC 真正结束进程，以同一隔离数据目录重开，账号/会话与界面仍可读。

终端输出提交、源码摘要、宿主、模式、代理策略和阶段结果；失败保留日志，已取得窗口或开始 tracing 时还会保留截图/trace，成功不另建验收报告。运行目录保留便于定位，不自动删除 Worktree。进程清理只针对本轮启动的 PID，正常退出优先，失败时才强制结束本轮进程树；中断构建也只清理本轮构建进程树。

磁盘保护分四层，均不构成绝对磁盘配额：

- 启动前：要求 `.tmp/desktop-e2e` 所在卷剩余空间 ≥15 GiB（按运行目录实际所在卷测量，不用当前目录卷代替），且保留的运行目录数必须低于上限 3（仅按 UUID 命名的启动器目录计数，不误计其他数据）。
- 阶段边界：源码快照、Next.js 生产构建、后端组装各阶段边界再要求剩余 ≥8 GiB 才进入下一阶段。
- 异步构建期间：Next.js 生产构建运行时启动约 2 秒间隔的低频监测，仍按运行目录所在卷测量；剩余低于 8 GiB 时报告 `INSUFFICIENT_DISK_SPACE`（stage=build），仅终止本轮构建进程树并以有界等待回收，不进入后端组装、不启动 Electron。磁盘测量失败按同样方式安全停止。监测为单发，构建正常完成、失败或中断时都会释放。
- 同步后端组装期间：`assembleDesktopBackend` 使用同步复制，Node.js 主线程上的监测定时器无法在单次同步调用期间执行，组装中途耗尽仍是残余窗口，目前仅由组装前后的边界检查兜底；改造成异步复制或独立监测进程属于未实施的架构扩展。

触发时报告 `RUN_DIR_LIMIT` 或 `INSUFFICIENT_DISK_SPACE`（含 Run ID、阶段、剩余空间、门槛、目标卷、已占用目录清单和进程清理状态），不自动重试、不自动删除历史运行目录或日志证据，仅按上述机制清理本轮进程。主流程错误与清理错误分开报告：清理超时等失败标记 `CLEANUP_FAILURE`，不覆盖已报告的 `PRIMARY_FAILURE`；仅清理失败同样判整体失败并以非零状态退出。

## 失败定位与代理

“后端 Ready”“CDP 可连接”“窗口内容可操作”是三个条件。启动器任一步失败均报告桌面 E2E 失败，不自动改跑浏览器并计为桌面通过。每轮日志放在独立目录；不可读取上一轮 Ready 或用后端就绪推断调试端口就绪。

启动器也检查 `/dashboard` 冷启动重定向是否离开允许的后端 origin。`127.0.0.1` 与 `localhost` 是不同 origin；后端可访问但重定向被桌面导航规则拒绝时，应报告实际不匹配，不能关闭导航检查或把独立浏览器成功当成桌面通过。

默认保留系统代理行为。确需隔离代理因素时，显式运行：

```powershell
npm run test:e2e:desktop -- --direct
```

`--direct` 是单独标记的 Chromium 直连诊断，不修改系统代理，也不能证明绕过 TUN；诊断通过不能替代默认环境通过。`ERR_FAILED`、`Target closed` 本身不足以判定代理或单实例锁是根因，需对照本轮日志与进程退出状态。

## 报告边界

按影响选择最小充分检查，不要求每次改动执行完整 E2E。报告明确宿主（Web/Electron）、模式（fresh-native/Legacy）、源码/构建来源，以及是否真正退出重开。只有浏览器通过时写“Web 验证通过，Windows Electron 未执行/阻塞”。本入口不覆盖安装器、系统自启、所有业务 CRUD、真实 AI 服务或 Legacy 兼容性；这些按实际改动另选定向检查。
