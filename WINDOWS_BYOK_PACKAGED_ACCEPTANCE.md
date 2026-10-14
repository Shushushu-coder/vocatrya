# WINDOWS_BYOK_PACKAGED_ACCEPTANCE

BYOK Windows OS-backed CredentialStore — 正式打包安装环境验收记录。

- 验收范围：本地 Windows 测试安装包的合成凭据端到端验收。
- 不在范围：生产部署、真实用户凭据迁移、真实 Provider API 调用、架构重审。
- 本仓库代码本轮未做任何修改；仅 `.codex-tmp/`（gitignored）下新增验收脚本与报告。
- 原始逐阶段证据：`.codex-tmp/byok-acceptance/report.json`；验收脚本：`harness.mjs`、`dpapi-broker.mjs`、`dbtool.cjs`。

## 1. 被测制品

| 项 | 值 |
|---|---|
| Installer | `.codex-tmp/windows-installer/dist/Vocatrya-Setup-1.2.0-beta.2-x64.exe` |
| SHA-256 | `486a6ed45a5feb904274042d02e420f00b56689ec96915ad20459f0c759cf96c` |
| 大小 | 522,426,920 bytes |
| App version / AppId | `1.2.0-beta.2` / `com.vocatrya.desktop` |
| 构建 commit | `f9ea0652f398e582338865f7dfc0d081d678dfaf` |
| 签名 / 自动更新 | 未签名 NSIS（内部构建，预期）/ NOT_IMPLEMENTED |
| OS | Windows 11 (10.0.26200) x64 |
| Electron | 44.4.3 |
| 打包 Node | v20.20.2（SHA-256 `56c1520e…ab937`，与官方归档一致） |
| Prisma | 6.19.0（54 个 migration） |
| Next.js | 15.5.25 |
| 安装方式 | NSIS `/S` 静默安装至 `%LOCALAPPDATA%\Programs\Vocatrya`（2.0 GB 完整树） |

注意：首次 `/S` 安装在 300 s 观察窗内被外部终止，留下半成品目录；清除后完整重装成功。`installedBytes=2000983751`，backend/`prisma-runtime`/`db-tool.cjs`/bundled `node.exe`/卸载器齐备。

## 2. 安装包内容检查

对 `win-unpacked` 全树及 `resources/app.asar`（44 条目）递归扫描：

- 无 `.env`、`secrets.dat`、真实 SQLite（`.db`/`.sqlite`）、`credential-migration` journal、`.pem`/`.key`、开发凭据 — **0 命中**。
- Broker token 为每次启动由 `createPocSecret()` 生成的随机值（`desktop/main/main.js:131`），只注入 backend 子进程 env（`VOCATRYA_DESKTOP_INTERNAL_TOKEN`），不存在于任何发行制品。
- Renderer 无任何到 broker 的通路：无 IPC channel、无 preload bridge（`credential-broker.js:4-6` 注释即契约；代码核实无 ipcMain 注册）。
- `basic_text` 降级被显式拒绝：`storageState()` 要求 `isEncryptionAvailable()===true && backend!=="basic_text"`（`credential-broker.js:96-114`），否则所有操作 503 `CREDENTIAL_STORE_UNAVAILABLE`。

## 3. DPAPI / App-Bound Encryption / Broker 验收

安装版实测（`abeProbe`）：驱动真实 `Vocatrya.exe` 的 safeStorage 产生的 blob：

- blobLen=75，**`v10` 前缀** — Electron 44 在 Windows 上为 App-Bound Encryption（比裸 DPAPI 更强的应用绑定，仅 Vocatrya.exe 自身可解）。
- 外部 `CryptUnprotectData` 尝试解 safeStorage blob → `FAILED:MethodInvocationException` — **正向证据**：非本应用进程无法开封 OS 信封。
- 作为对照，`CryptProtectData` 熵绑定 blob 长 352。

结论：CredentialStore 在真实打包环境使用 OS 绑定信封（`iv === "os:v1"`），不存在 `basic_text` 或应用层明文降级路径。

## 4. Packaged E2E 实际结果（安装版）

隔离用户数据根 `VOCATRYA_DESKTOP_DATA_ROOT=.codex-tmp/byok-acceptance/user-data`，全部合成 Key（尾号 C0DE/F00D/CA11/DEAD，Ollama 为 `http://127.0.0.1:11434`）。

| Gate | 结果 |
|---|---|
| Settings 保存新 BYOK Key | PASS — UI `已验证并保存`；DB 行 `iv="os:v1"`（openai，ABE blob 92B base64）；存储卡显示 `已保存密钥在此设备上由 Windows 保护。` |
| 关闭并重启正式安装版后读取 | PASS — 重启后 explicit verify：OPENAI `CONNECTED`；`os:v1` 信封跨进程重启可解 |
| 合成旧格式数据 | 注入 v1（`salt.iv`）+ legacy 固定盐 + 熵绑定 `os:v1` 外来 blob + plaintext 行 |
| 不可解密行上的显式迁移 | PASS — `0 个已升级，3 个跳过，2 个失败——原有密钥均未改动。`；DB 逐行比对未变；无 journal 落盘 |
| 显式 verify → REAUTH_REQUIRED | PASS — `3 个密钥需要重新输入，0 个暂时无法检查。`；DEEPSEEK/GEMINI/OPENROUTER = `REAUTH_REQUIRED`，OPENAI/OLLAMA = `CONNECTED` |
| 更新行为 | PASS — openai 重新保存仍 `os:v1`（last4 BEEF），无格式漂移 |
| 删除行为 | PASS — openrouter 删除后连接 `DISCONNECTED`，ApiKey 行移除 |
| 备份不含原始 Key | PASS — 默认导出与 `includeSensitiveData` 导出均为 `manifest.json`+`data.json`；无 ApiKey 表/encryptedKey 字段/任何合成材料 |
| 日志脱敏 | PASS — `backend-stderr.log`/`backend-stdout.log`/`migration.log`（3,515B）扫描：无合成 Key、无 DB 密文 blob、无 `VOCATRYA_DESKTOP_INTERNAL_TOKEN`、无 Bearer token |
| 退出无残留 | PASS — `finish`：0 个 Vocatrya 进程残留 |

## 5. 正路径迁移（standalone 打包 backend 层）

安装版 safeStorage 为 App-Bound Encryption，进程外无法代行 seal；`ENCRYPTION_KEY` 封装于 `secrets.dat`。因此 legacy→os 正路径用**同一 packaged `server.js` + `db-tool.cjs` + 受控 ENCRYPTION_KEY**执行，broker 由 `dpapi-broker.mjs` 顶替 Electron broker — **同一 HTTP 契约**（`/credential/status|seal|unseal`、Bearer、错误码），后端为真实 `CryptProtectData`（CurrentUser 域）。被测代码路径与安装版完全一致。

结果（`saAppCipher` + `saInjectLegacy` + `saOsBacked`）：

- app-cipher 模式下保存 2 行 → `iv` 为 `salt.iv` v1 格式；resolve 返回合成明文（旧格式兼容读成立）。
- 注入 1 行 legacy 固定盐 + 1 行垃圾 `os:v1` blob。
- os-backed 模式下显式 verify：`1 个密钥需要重新输入`（垃圾 os:v1 → DECRYPT_FAILED）。
- 显式迁移按钮文案 `将 3 个密钥升级为 Windows 保护` → toast `3 个密钥已改为 Windows 保护。`
- 迁移后 4 行全为 `os:v1`；DPAPI blob 352B；post-migration verify 仅垃圾行 `REAUTH_REQUIRED`，其余 `CONNECTED`。
- Journal：`credential-migration/credential-migration-recovery.jsonl` 3 条，每条含 `apiKeyId,userId,provider,previousIv,previousEncryptedKey,migratedIv,migratedEncryptedKey,recordedAt`；**无任何合成明文**（journalLeak=false）。
- 删除 openrouter → `DISCONNECTED`。

## 6. Fail-closed 验收

| 场景 | 结果 |
|---|---|
| Broker 不可用（backend 指向死端口 `127.0.0.1:9`） | 保存报 `此设备上无法使用 Windows 保护。`，**0 行落库** — 无静默降级到应用层加密 |
| 损坏/外来 `os:v1` blob | 显式 verify → `REAUTH_REQUIRED`（DECRYPT_FAILED，永久态） |
| 不可解密 v1/legacy 行（错误 ENCRYPTION_KEY 语境） | 迁移 CAS 不落盘、行不变、无 journal；verify → `REAUTH_REQUIRED` |
| Broker bind 失败（main.js:443-447） | backend 仍获 DOWN sentinel URL，os-store 操作 fail closed，不回退应用层密钥 |

## 7. Windows ACL 与文件证据

- **真实默认根 `%LOCALAPPDATA%\Vocatrya`**（短暂启动探针，探测后删除）：`HP(F)`、`SYSTEM(F)`、`Administrators(F)`、本机 `CodexSandboxUsers(RX)` — 用户作用域，无 Everyone/Authenticated-Users 写权限。`config\secrets.dat` 同。
- 隔离测试根在 `E:\Projects` 下继承 `Authenticated Users(M)`/`Users(RX)` — 测试目录自选位置所致，非应用行为；应用不设自定义 ACL，文件继承父目录（标准 Windows 行为）。journal 落盘位置与 DB 同目录（`credential-migration.ts:111-115` 设计：同 ACL 边界），代码另设 `0o700`/`0o600` POSIX mode（Windows 下以继承 ACL 为准，真实默认根下即用户作用域）。
- Journal 为 append-only；`restoreFromJournal` 为 CAS 有界恢复——仅当行仍是本次迁移值才回写，用户后续保存永远不会被 journal 覆盖 → 保留/清理机制不会造成凭据丢失。

## 8. 旧版本回滚边界

- `os:v1` 行被旧版本（无 `isOsEnvelopeIv` 分派）读取时走 `decrypt(encryptedKey,"os:v1")`：`iv.includes(".")` 为 false → 按 legacy 固定盐路径解 → `createDecipheriv`/GCM 抛错 → 凭据读取失败浮出，用户需重新输入 Key。**没有任何路径会把 `os:` 行静默改回应用层加密或明文**——迁移只单向 v1→os，逆向不存在。
- 新构建对未知 `os:*` revision 同样 fail closed（`credential-store.ts:302-305` DECRYPT_FAILED），不猜测格式。
- `REAUTH_REQUIRED` 即明确的重新认证提示语义；本轮不删除旧格式读取路径、不移除 `ENCRYPTION_KEY`/`secrets.dat`。

## 9. 两项既有 desktop 失败的最终分类

`test:desktop`（`desktop/vitest.config.mjs`）连续两轮全绿（20/20）：

- **release-verification（17/17 PASS）**：失败原因为**前置制品缺失**——测试校验已存在的安装包（含 Authenticode `NOT_SIGNED` 断言）；先于 `desktop:installer` 运行必然失败。制品就位后全部通过。**非代码缺陷**；属测试编排顺序约束。未签名是内部构建的预期策略（`internal-unsigned` policy），非公开发布签名失败。
- **backup-integration（3/3 PASS）**：`VACUUM INTO`/WAL/空格与 Unicode 路径/原子发布全部通过；EPIPE/临时文件占用未复现。分类为 **Windows 瞬态文件句柄竞争（防病毒/索引器类环境抖动）**；安装版真实备份导出亦正常。非代码缺陷，亦不构成本轮阻塞。

## 10. Diff Review（限定范围）

本轮验收未修改任何仓库代码：仅新增/编辑 `.codex-tmp/byok-acceptance/`（gitignored）下的验收脚本，并对注入的合成 provider 标识做了一处数据层修正（`anthropic`→`gemini` 映射，DB 层，非代码）。`git status` 中的 `M`/`??` 条目均为既有的三路 AI Settings + BYOK 未提交工作，与本轮无关。无需针对本轮的独立代码复审；上述既有改动以前序评审结论为准。

## 11. 结论

所有验收 Gate 均基于**真实安装包、真实安装、真实 Windows/Electron 环境**的直接证据通过；迁移正路径使用同一 packaged backend 与同一 broker 契约、真实 `CryptProtectData` 完成。无正式发布阻塞（未签名为内部构建既定策略）。

```
BYOK_PACKAGED_WINDOWS_E2E=PASS
THREE_ROUTE_AI_SETTINGS=READY_FOR_FINAL_OWNER_ACCEPTANCE
```
