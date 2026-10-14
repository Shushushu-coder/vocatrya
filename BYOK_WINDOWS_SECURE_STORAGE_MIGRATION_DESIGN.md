# BYOK Windows OS-Protected Secure Storage Migration Design

- 状态：**设计稿，待 Owner 审阅**。本文件仅授权定向设计；未实施迁移、未修改任何生产代码 / Prisma Schema / Migration / 测试实现，未读取或输出任何真实用户 Key。
- 事实基线：`feat/three-route-ai-settings` 工作树（`main`@`f9ea0652` + BYOK P1+P2 未提交交付），所有"现状"描述均直接核对自该工作树源码。
- 受保护边界：`E:/Projects/vocatrya.worktrees/fix-m6-phase-b-readiness`（Phase B 工作树与 Artifact，本轮只读 `git status`）；主仓 `main` 的 `.gitignore` 未提交修改；`phase-b-worktree/`、`M6_HOSTED_*` 工件。

---

## 1. 现状：凭据实现与进程边界（源码核对结论）

### 1.1 数据模型（`prisma/schema.prisma`）

| 表 | 关键列 | 角色 |
|---|---|---|
| `ApiKey` | `id`(uuid), `userId`, `provider`, `encryptedKey`, `iv`, `last4`, `label?`, `lastUsedAt?`; `@@unique(userId, provider)` | BYOK 凭据权威。一用户一 provider 一行。 |
| `AIConnection` | `authType=API_KEY`, `backendKind=LOCAL_BYOK`, `credentialRef=<ApiKey.id>`, `runtimeProfileRef=null`, `accountIdentity=null`, `status` | BYOK 显式连接投影（P2 桥，`src/lib/ai/byok.ts`）。`credentialRef` 经 `isApiKeyCredentialRef` 校验为 uuid，永不含凭据材料。 |
| `AIBusinessAssignment` | `(userId, purpose) → connectionId + model` | 业务分配；BYOK 连接与普通连接同列同锁。 |

### 1.2 加密契约（`src/lib/encryption.ts`）

- AES-256-GCM；密钥 = `PBKDF2(process.env.ENCRYPTION_KEY, salt, 100_000, sha256, 32B)`。
- **v1 格式**（现行）：`iv` 列 = `base64(salt16) + "." + base64(iv12)`；`encryptedKey` = `base64(ciphertext ‖ authTag16)`。
- **legacy 格式**：`iv` 列不含 `"."` → salt 固定为 `LEGACY_SALT = "jobsync-api-key-encryption"`。**既有兼容边界，禁止修改**。
- **`iv === ""`** → 非敏感明文直通（仅 Ollama base URL；`keyConfig.sensitive=false`）。
- `ENCRYPTION_KEY` 未设置时 `encrypt()/decrypt()` 抛错（fail closed）。

### 1.3 `ENCRYPTION_KEY` 真实来源

- **桌面打包版**：Electron main 中 `desktop/main/secrets.js` `loadOrCreateDesktopSecrets` 一次性生成 `base64(32B)`，以 `safeStorage`（Windows 上 = DPAPI，用户范围）加密存于 `%LOCALAPPDATA%\Vocatrya\config\secrets.dat`；每次启动解密后经 `desktop/main/runtime.js` `buildBackendEnvironment` 以**明文环境变量**注入 spawn 出的后端子进程（`env.ENCRYPTION_KEY`）。
- **Web/Docker**：`.env` / `docker-compose.yml` 注入（README 要求部署者自设）。
- **桌面 POC 开发**（无 `VOCATRYA_DESKTOP_DATA_ROOT`）：`buildBackendEnvironment` 不注入并显式 `delete env.ENCRYPTION_KEY` → 当前 POC 桌面里保存 Key 已经失败（"ENCRYPTION_KEY is not set"）。
- **依赖面**：`encrypt/decrypt` 仅被 `apiKey.actions.ts`、`api-key-resolver.ts`、`byok.ts`、`getOllamaBaseUrl` 及测试引用——**ApiKey 是 ENCRYPTION_KEY/AES-GCM 的唯一消费者**；`AUTH_SECRET`（NextAuth）与 hosted session 另有通道，不依赖它。

### 1.4 进程边界（核对自 `desktop/main/*`）

```
Renderer (BrowserWindow, http://127.0.0.1:<port>)
   │  server actions / route handlers (HTTP, loopback)
   ▼
Backend child (Node, Next standalone, 127.0.0.1:<port>)
   │  env: ENCRYPTION_KEY, VOCATRYA_DESKTOP_INTERNAL_TOKEN,
   │       VOCATRYA_DESKTOP_EXEC_URL, VOCATRYA_HOSTED_SESSION_URL
   │  Prisma → %LOCALAPPDATA%\Vocatrya\data\vocatrya.db
   ▲  loopback + Bearer(internalToken)
Electron main (safeStorage/DPAPI, secrets.dat,
   hosted-session broker, execute-server, connection IPC)
```

- `safeStorage` **只在 Electron main 可用**。后端是普通 Node 子进程，不能直接调 `safeStorage`；Renderer 也不能（contextIsolation、sandbox、无 nodeIntegration）。
- 既有 backend→main 通道均为 **127.0.0.1 随机端口 + `timingSafeEqual` Bearer**：`hosted-session.js`（`GET /session`，safeStorage 加密 token 落 `hosted-sessions/<sha256(userId)>.dat`）与 `execute-server.js`（`/internal/ai-connections/execute[-stream]`、`runtime-state`，512KB body cap、JSON-only、稳定错误码、永不回显内部错误）。
- Renderer→main 仅有 preload 桥（`vocatryaRuntime`/`vocatryaAi`），票证 + connectionId，凭据/路径/env 永不越桥。

### 1.5 调用链（BYOK P1+P2 实际形态）

- **保存**：`ByokConnectionsCard` → `POST /api/settings/api-keys/verify`（provider 侧验证，明文经 loopback 到后端）→ `saveApiKey`（server action）→ `encrypt()` → `apiKey.upsert` → `upsertByokConnectionForApiKey`（AIConnection CONNECTED）。
- **列表**：`getUserApiKeys`（仅元数据 + `iv===""` 时回显明文 URL）；`listAssignableAiConnections` → `ensureByokConnectionsForUser`（读路径自愈：存量 ApiKey → 补建连接；孤儿连接 → DISCONNECTED）。
- **解析（显式 BYOK 连接）**：`executeAIConnectionText[Stream]` → BYOK 分支 → `executeByokConnectionText[Stream]` → `resolveByokCredential` → 严格 owner+provider+credentialRef 命中 → `decrypt()`；失败一律 `BYOK_CREDENTIAL_UNAVAILABLE`，**无 env/default 回退**。
- **解析（legacy）**：`getModel` → `resolveApiKey` → DB 行解密 → provider env var → `defaultCredential`（仅 Ollama `http://127.0.0.1:11434`）。`getOllamaBaseUrl` 同用 `decrypt`。
- **删除**：`deleteApiKey` → `deleteMany` → `markByokConnectionDisconnected`（连接保留下线，审计可追）。
- **`/api/ai/<provider>/models`**（openai/deepseek/openrouter/gemini）：`resolveApiKey` → provider models 端点（验证/列模型 UX）。

### 1.6 备份/恢复

- 用户级 ZIP 导出：`ApiKey` 在 `INTENTIONALLY_EXCLUDED_PRISMA_MODELS`——**凭据永不进备份**；`AIConnection` 元数据可导出，`normalizeAIConnection` 将 `ACCOUNT_LOGIN/MANAGED/API_KEY` 的 `CONNECTED` 行恢复为 `REAUTH_REQUIRED`。导入完全不动 `ApiKey`。
- 桌面迁移前内部备份：`database-backup.js` `VACUUM INTO` 整库复制到 `backups/`（本地，含 ApiKey 密文行）。任何格式下这都是密文；换 OS-bound blob 后其跨机可用性进一步归零，方向只会更严。
- 诊断/日志边界：`db-runner.js` `sanitizeChildOutput` 已脱敏 `ENCRYPTION_KEY=` 等；execute-server/connection 诊断只记 code。

---

## 2. 设计目标与威胁模型

### 2.1 目标

把"用户 BYOK Key 的静态保护"从**通用应用级密钥（`ENCRYPTION_KEY` env）+ AES-GCM** 升级为 **Windows OS-backed protection（Electron `safeStorage` → DPAPI）**，且：不加 Prisma Schema/Migration、不改 `credentialRef` 契约、不动 `LEGACY_SALT`、保留三路由隔离与锁定语义、旧行在显式迁移前继续可用。

### 2.2 Windows 安全边界（诚实声明）

- **DPAPI（CryptProtectData）是用户范围，不是应用范围**：同一 Windows 用户上下文中的任意进程理论上都能对自己的 blob 调 `CryptUnprotectData`。safeStorage 不能抵御"同用户权限下的恶意进程"，本设计不夸大这一点。
- 实际收益：① DB/备份中的密文**绑定到该 OS 用户**——复制到其它 Windows 用户、其它机器、重装系统后不可解（fail closed 的方向正确）；② 撤掉后端 env 中的长寿命通用密钥（`ENCRYPTION_KEY` 作为子进程 env 对同用户进程可读，是今天最大的暴露面）；③ 与 `secrets.dat`、hosted session 已有的 DPAPI 先例对齐；④ 在启用了 TPM/新 master-key 策略的系统上自动受益。
- 残余风险（必须写明）：持有 `VOCATRYA_DESKTOP_INTERNAL_TOKEN` 的同用户进程可把 credential broker 当解密 oracle——token 每次启动轮换、仅存后端 env，与该威胁模型下 DPAPI 本身同级，接受为已知限制；环路不鉴权调用者身份以外的因素。

---

## 3. 推荐架构：CredentialStore 抽象 + OS Envelope + Credential Broker

### 3.1 三个组件

```
┌─ Electron main ──────────────────────────────────────────┐
│ credential-broker.js  (新, loopback 127.0.0.1:<ephemeral>) │
│   GET  /credential/status  → {ok, available, backend}      │
│   POST /credential/seal    {plaintext} → {blob:b64}        │
│   POST /credential/unseal  {blob:b64}  → {plaintext}       │
│   Bearer = VOCATRYA_DESKTOP_INTERNAL_TOKEN                 │
│   gate: safeStorage.isEncryptionAvailable()                │
│         && getSelectedStorageBackend() !== "basic_text"    │
└──────────────────────────────────────────────────────────┘
        ▲ VOCATRYA_CREDENTIAL_URL (env, 注入后端; 加入 runtime.js 不继承名单)
┌─ Backend ────────────────────────────────────────────────┐
│ src/lib/ai/credential-store.ts (新)                       │
│   resolveApiKeySecret(row{encryptedKey,iv}) → plaintext    │
│     iv===""      → 明文直通                                │
│     iv="os:v1"   → broker.unseal(base64 blob)              │
│     else         → encryption.decrypt()  (v1/LEGACY_SALT)  │
│   sealApiKeySecret(plaintext) → {encryptedKey, iv}         │
│     broker 可用   → {blob, "os:v1"}                        │
│     broker 不可用 → 桌面: fail;  web/docker: encrypt() v1   │
│   credentialStoreStatus() → {kind, available, backend}     │
│ src/lib/ai/credential-migration.ts (新, 显式迁移任务)       │
└──────────────────────────────────────────────────────────┘
        ▼ ApiKey.encryptedKey / ApiKey.iv（列语义不变，iv 兼作格式判别）
   SQLite vocatrya.db
```

### 3.2 存储格式契约（`iv` 列作为格式判别，无新列）

| `iv` 值 | 含义 | 读路径 | 写路径 |
|---|---|---|---|
| `""` | 非敏感明文（Ollama URL 等） | 直通 | 不变 |
| 不含 `.`，非 `os:*` | **legacy**：`LEGACY_SALT` PBKDF2+AES-GCM | `decrypt()` | 不再产生 |
| `base64(salt).base64(iv)` | **v1**：per-record salt PBKDF2+AES-GCM | `decrypt()` | 仅 web/docker/dev 继续产生 |
| `os:v1` | **os-bound**：`encryptedKey` = base64(safeStorage.encryptString(key)) | broker `unseal` | 桌面（safeStorage 可用）唯一新写格式 |

`os:v1` 含 `:`，与 legacy/v1 的判别互不冲突；`encryption.ts` **完全不改**（保留为 v1/legacy 兼容层）。版本号 `v1` 预留未来 `os:v2`（如换信封结构）空间。

### 3.3 方案 A 决策：blob 放 DB 还是独立 OS store

**推荐 A1（in-DB envelope）**：safeStorage blob 仍存 `ApiKey.encryptedKey`，物理上 DB 继续是唯一凭据权威；main 只做"加密 oracle"（seal/unseal），不拥有凭据语义。

| 维度 | A1：blob 在 ApiKey 行 | A2：main 侧独立文件 store（仿 hosted-session `.dat`） |
|---|---|---|
| Schema/Migration | **无** | 需 credentialRef→store key 约定，或新列 |
| 迁移原子性 | 单行 `UPDATE`（CAS）即完成/即回滚 | 文件写 + 行更新两阶段，孤儿文件清理逻辑 |
| `credentialRef` 契约 | 不变（仍 ApiKey.id uuid） | 不变，但行与文件需对账 |
| 备份语义 | ApiKey 已排除；行级 CAS 天然适配 | 需额外保证 store 目录不进备份/导出 |
| 删除/自愈 | 现有 `deleteApiKey`/`ensureByokConnectionsForUser` 零改动 | 需跨进程删除协调与孤儿清扫 |
| 安全增益 | 与 A2 相同（同为 DPAPI blob，同一本地 ACL 边界） | "SQLite 里没有密文"是审美收益，无实际威胁模型差异——DB 文件与 `.dat` 文件同目录同级保护 |

A2 的唯一实质差异是"密文离开 SQLite"。鉴于 ApiKey 已被 ZIP 备份排除、桌面内部备份整库复制本就携带密文，A2 引入双写协调而换不到新的安全性质。**故选 A1**；A2 作为备选记录在案。

### 3.4 IPC/进程边界设计（问题 D）

- **不新增任何 preload/Renderer 凭据通道**。明文 Key 的唯一跨边界路径保持现状：Renderer 输入框 → loopback HTTPS-less HTTP → 后端 server action。`vocatrya*` 桥继续永不携带凭据（与连接 IPC 现有约束一致）。
- 后端↔main 走新 broker：与 `hosted-session` broker 完全同型——`127.0.0.1`、启动时随机端口、`timingSafeEqual` Bearer、每启动一次轮换的 `internalToken`、body 上限（建议 `seal` 明文 ≤ 8KB，blob ≤ 32KB）、JSON-only、稳定 `code` 字段（`CREDENTIAL_STORE_UNAVAILABLE`/`CREDENTIAL_DECRYPT_FAILED`/`INVALID_PAYLOAD`/`UNAUTHORIZED`/`NOT_FOUND`），响应永不回显明文或内部异常。
- `unseal` 失败区分两类：`UNAVAILABLE`（safeStorage 不可用/broker 未起——环境性）与 `DECRYPT_FAILED`（blob 在本 OS 用户下不可解——永久性，=换用户/换机/损坏）。两类在业务侧都映射 `BYOK_CREDENTIAL_UNAVAILABLE`；仅"显式验证/迁移检查"路径利用区分决定是否置 `REAUTH_REQUIRED`。
- main.js 启动序：broker 与 hostedSessionBroker 同期绑定（`app.whenReady` 内、backend spawn 前），URL 经 `env.VOCATRYA_CREDENTIAL_URL` 注入；bind 失败仅降级 BYOK 写/读 os: 行（明确报错），不阻断启动（对齐 execute-server 的 degradable 先例）。

### 3.5 各问题结论（A–H 汇总）

- **A**：见 §3.3，A1。
- **B**：`AIConnection.credentialRef` 恒为 `ApiKey.id` uuid，`isApiKeyCredentialRef`/`classifyAIConnection`/自愈逻辑零改动。
- **C**：`ApiKey` 保持凭据权威；`encryptedKey`/`iv` 列语义复用为信封，无结构调整。
- **D**：§3.4——后端↔main loopback broker；Renderer/IPC 不碰凭据。
- **E**：**不需要**新 Schema 或 Migration。`iv` 判别已可区分三种格式；`os:v1` 走同列。理由：改动面最小、可逐行 CAS 迁移、Phase B/发布窗口零风险。
- **F**：fail closed 决策表见 §6。
- **G**：新录入走 §4 写策略；旧行由 `resolveApiKeySecret` 透明解密直到显式迁移；迁移不在任何 read path 隐式发生。
- **H**：见 §7 平台策略。

---

## 4. 写路径与读路径改造

### 4.1 写路径（`saveApiKey`）

```
sensitive=false → 明文 + iv=""（不变）
sensitive=true  →
  broker 可用（VOCATRYA_CREDENTIAL_URL 且 status.available）
      → seal(key) → {encryptedKey=blob, iv="os:v1"}
  broker 不可用且是桌面后端（同 env 判断：URL 已注入但 status 失败，
      或运行在 desktop 形态）
      → fail CREDENTIAL_STORE_UNAVAILABLE（正式 Windows 构建
        禁止静默降级为应用级密钥/明文）
  broker 不存在（web/docker/next dev）
      → encrypt() v1（现有契约，自部署形态不变）
```

- "桌面后端"判定：`VOCATRYA_CREDENTIAL_URL` 是否被注入（main 始终注入 URL；`status` 报告真实可用性）。URL 在而 status 失败 → 桌面但 OS store 坏 → fail closed；URL 不在 → web/自托管 → v1。POC 桌面 dev：main 同样起 broker（safeStorage 在解包模式可用），URL 注入 → os:v1，顺带修复 POC 当前"无 ENCRYPTION_KEY 无法存 Key"的现状。
- `upsertByokConnectionForApiKey`、`last4`、`verify` 路由不变；保存成功后既有连接 CONNECTED 语义不变。

### 4.2 读路径

- `resolveByokCredential`、`resolveApiKey`、`getOllamaBaseUrl`、`/api/ai/<provider>/models` 全部统一走 `resolveApiKeySecret(row)` 的格式分发；**legacy 路径的 env/defaultCredential 回退语义原样保留**（显式决定：保留——它是 BYOK 路由内部历史语义，收紧属于另一个独立决策，Owner 可另行授权）。
- `os:v1` 行在 broker 缺失（web/docker 打开桌面 DB）时：`resolveByokCredential` → `BYOK_CREDENTIAL_UNAVAILABLE`；`resolveApiKey` → 落 env 回退（既有语义）。
- `getUserApiKeys` 不解密，无改动。

### 4.3 三路由隔离保持不变

- Managed：平台 Key 仍只在 hosted 进程；桌面只有 hosted session broker——**不进入** credential broker，Broker 不接受 `MANAGED`/session 语义，`/credential/*` 只对 BYOK 包络。
- Account Login：`CODEX_HOME`/`runtimeProfileRef`/Persistent Pool/票证/`execute-server` 零接触；`classifyAIConnection` 严格性不动。
- BYOK：显式连接失败仍 `BYOK_CREDENTIAL_UNAVAILABLE`，不回退 env/默认/Codex/Managed；`AIBusinessAssignment` 与锁列语义不变。`providerMetadata` 禁钥校验不变。
- 不变量新增一条：credential broker 响应永不进入 `providerMetadata`、日志、Hosted 请求、`/api/ai/*` 响应体。

---

## 5. 旧凭据迁移方案（设计，不执行）

### 5.1 迁移单元与前提

- **单元**：单行 `ApiKey`（`iv` 非 `""` 且非 `os:*` 即待迁移；`iv=""` 明文行跳过；`os:v1` 跳过）。
- **前提（缺一即跳过该行）**：① `decrypt()` 能解出原文（ENCRYPTION_KEY 在位、密文完好）；② broker `status` 可用；③ seal→unseal 往返校验一致。
- **识别与归属**：迁移扫描按 `userId` 分批；逐行记 `{apiKeyId, provider}` 到内存清单（**永不记明文、last4 已有列除外**）；产出摘要 `{migrated:[], skipped:[], failed:[{id,reasonCode}]}`，reasonCode ∈ `DECRYPT_LEGACY_FAILED|STORE_UNAVAILABLE|ROUNDTRIP_MISMATCH|WRITE_CONFLICT`。

### 5.2 单行迁移算法（全在串行步骤内，CAS 保证原子性）

```
1. row = SELECT id,userId,provider,encryptedKey,iv FROM ApiKey WHERE id=:id
2. plain = decrypt(row.encryptedKey, row.iv)          // 失败 → skipped(failed)，行不动
3. blob  = broker.seal(plain)                          // 失败 → skipped，行不动
4. assert broker.unseal(blob) === plain                // 写前验证；不一致 → failed, 行不动
5. UPDATE ApiKey SET encryptedKey=:blob, iv='os:v1'
     WHERE id=:id AND encryptedKey=:oldEnc AND iv=:oldIv
   // CAS：命中并发重存/删除则 0 行 → WRITE_CONFLICT，行以新值为准，不覆写
6. 重读该行 → resolveApiKeySecret(row') === plain       // 写后验证
   失败 → 尝试把行改回旧值（同 CAS）；仍失败 → failed 记录 + 告警状态
   （此时行已是有效 os:v1 或已回滚为有效 v1——不可能留半迁移态）
7. plain/blob 变量清零；仅计数与 id 进摘要
```

**崩溃安全**：任意一步中断 → 行要么原样（1–5 前）、要么是已验证的新格式（5 提交后）；绝无半迁移行。重跑幂等（`os:v1` 跳过）。**原凭据在新存储验证成功前不会被删除**——由"同一行 CAS 覆写 + 写后重读验证"满足；旧密文消失的唯一时刻是验证通过后的同一 UPDATE，不可分割。

### 5.3 触发方式

- **主路径**：Settings → BYOK 卡"升级为本机系统保护"显式动作 → `migrateByokCredentialsToOsStore` server action → 后台逐行迁移 → 汇报摘要。非破坏性、可重复点击（幂等）。
- **可选（Owner 决定）**：打包版每次启动后端就绪后跑一次同一任务的自动 pass（同样是独立维护任务，**不是** read path 隐式迁移）；默认不开启，待 Owner 授权。
- `AIConnection` 不受影响：`credentialRef` 不变，`CONNECTED`/`DISCONNECTED` 语义不变——**部分迁移不可能造成错误 CONNECTED**：迁移期间行始终可解析（旧格式照读或新格式已验证）；连接状态只随 ApiKey 行存在性变化（既有自愈逻辑）。

### 5.4 旧格式保留期与清理

- `decrypt()`/v1/LEGACY_SALT 读支持**永久保留**（兼容边界；web/docker 仍在产生 v1）。
- `ENCRYPTION_KEY` 注入后端的移除属于独立批次（§9）：需满足"该库零非 `os:`/`""` 行"或保留期满 + Owner 批准——它是对未迁移行的**不可逆**操作。
- 清理条件建议：迁移摘要 `failed=0` 且用户确认功能正常后，下一 release 可考虑停止注入；`LEGACY_SALT` 分支永不删除。

### 5.5 回滚

- **行级**：迁移前不需要备份行——CAS 保证失败即原样；DB 级回滚由既有 `pre-migration-*.db` 备份兜底（恢复=还原整个 DB 文件 + 用户重新录入 OS-bound Key 即可）。
- **格式级**：不提供"降级 os:v1 → v1"的产品操作（避免静默弱化）；灾难恢复路径 = 用户在 UI 重新保存一次 Key（`saveApiKey` 按当前策略写新格式）。

---

## 6. Fail-Closed 决策表（问题 F）

| 场景 | 行为 |
|---|---|
| safeStorage 不可用 / `basic_text` | `seal/unseal/status` 全失败；桌面新存 Key 显式失败 `CREDENTIAL_STORE_UNAVAILABLE`；`os:` 行解析失败；**不降级** |
| broker 未启动/URL 未注入（web/docker） | 写：v1 AES（既有契约）；`os:` 行读失败 |
| Windows 用户变更 / DB 跨机复制 / 系统重装 | `unseal` → `DECRYPT_FAILED` → `BYOK_CREDENTIAL_UNAVAILABLE`；显式验证路径可置 `REAUTH_REQUIRED`；用户重新录入 |
| blob 损坏/非 base64 | `DECRYPT_FAILED`，同上 |
| 备份恢复（ZIP） | ApiKey 不进备份 → BYOK 连接恢复为 `REAUTH_REQUIRED` → 自愈为 DISCONNECTED 或用户重存（既有语义） |
| 桌面内部 DB 备份含 `os:` 行，恢复到异机/异用户 | 同上 DECRYPT_FAILED → REAUTH；同机同用户则可解 |
| 迁移中断 | §5.2：行保持旧格式或完整新格式；连接状态不受影响 |
| 显式 BYOK 连接凭据缺失 | `BYOK_CREDENTIAL_UNAVAILABLE`（现有）；绝无 env/default/跨路由回退 |
| Renderer 直接构造凭据请求 | 无 IPC 通道；broker 只认 internalToken Bearer |

---

## 7. 平台与开发模式策略（问题 H）

| 形态 | ENCRYPTION_KEY | broker | 写格式 | 说明 |
|---|---|---|---|---|
| Windows 打包版 | 过渡期仍注入（迁移窗口需要读 v1/legacy） | 启用 | `os:v1` 强制；broker 坏→存失败 | 禁止明文/应用密钥降级 |
| Windows 桌面 POC dev | 不注入（现状） | 启用（safeStorage 解包亦可用） | `os:v1` | 顺带修复 POC 无法存 Key |
| `next dev` / Web / Docker | `.env` 注入 | 不存在 | v1 | 自托管契约不变，非降级 |
| 其它桌面 OS | 本项目打包仅 Windows x64（`resolveDesktopDataRoot`/`resolveMigrationRuntime` 均硬约束）；若未来出 macOS/Linux 桌面，`safeStorage` 后端为 keychain/libsecret，`basic_text` 仍 fail closed | — | — | 设计天然可推广，但不属本期 |

---

## 8. Schema / Migration 结论（问题 E）

**不需要** Prisma schema 变更或 migration。`iv` 判别 + `encryptedKey` 复用即可承载三种格式；`credentialRef` 契约不变。可选增强（`ApiKey.credentialFormat` 显式列）被否决：与 `iv` 判别重复、引入无必要的 destructive-adjacent 变更。

---

## 9. 需要 Owner 再次授权的不可逆/敏感操作

1. **执行真实迁移**（任何对生产/真实用户 `ApiKey` 行的写）。本轮仅设计。
2. **停止向桌面后端注入 `ENCRYPTION_KEY`**（`buildBackendEnvironment` 去掉 `encryptionKey` 注入）——对未迁移旧行不可逆。
3. **删除/清理任何 legacy/v1 凭据行或 `LEGACY_SALT` 兼容分支**（本设计已明确禁止后者）。
4. **开启启动自动迁移 pass**（§5.3 可选项）。
5. **把 `os:v1` 行标记 `REAUTH_REQUIRED` 的自动状态写**（建议在显式验证路径才写，read/exec path 不写——确认此策略也算授权项）。
6. 任何真实 Provider API 调用验证迁移（测试一律合成凭据）。

---

## 10. 需要修改/新增的具体文件清单

**新增（desktop main）**
- `desktop/main/credential-broker.js` — §3.1 loopback broker（status/seal/unseal，Bearer，body cap，稳定 code）。
- `desktop/main/credential-broker.test.mjs` — vitest mjs（仿 `hosted-session.test.mjs` mock safeStorage）。

**修改（desktop main）**
- `desktop/main/main.js` — `app.whenReady` 内起 broker；`env.VOCATRYA_CREDENTIAL_URL` 注入 backend env（两条 spawn 路径都加）。
- `desktop/main/runtime.js` — `VOCATRYA_CREDENTIAL_URL` 列入 `SENSITIVE_ENV_KEYS`（禁继承，同 `VOCATRYA_DESKTOP_EXEC_URL` 语义）。

**新增（backend）**
- `src/lib/ai/credential-store.ts` — `resolveApiKeySecret`/`sealApiKeySecret`/`credentialStoreStatus` + loopback URL 严格校验（仿 `DesktopHostedSessionProvider`：protocol=http、hostname=127.0.0.1、无 userinfo/query/hash）。
- `src/lib/ai/credential-migration.ts` — §5.2 单行算法 + 批量扫描 + 摘要。
- `src/actions/credentialMigration.actions.ts`（或并入 `apiKey.actions.ts`）— 显式迁移入口。
- `__tests__/credentialStore.spec.ts`、`__tests__/credentialMigration.spec.ts` — 合成凭据 spec。
- `desktop/main/credential-broker.test.mjs`（同上 desktop 侧）。

**修改（backend）**
- `src/lib/ai/byok.ts` — `resolveByokCredential` 内部换 `resolveApiKeySecret`。
- `src/lib/api-key-resolver.ts` — DB 行分支换 `resolveApiKeySecret`；env/default 回退保留。
- `src/actions/apiKey.actions.ts` — `saveApiKey` 写路径按 §4.1 分发；`getOllamaBaseUrl` 换 `resolveApiKeySecret`。
- `src/lib/ai/connections.ts` — 视需要补 `CREDENTIAL_STORE_UNAVAILABLE`/`CREDENTIAL_DECRYPT_FAILED` 进业务错误码（或复用 `BYOK_CREDENTIAL_UNAVAILABLE`，最终由实施批次定）。
- `src/components/settings/ByokConnectionsCard.tsx` — 迁移入口/状态展示 + reauth 提示（可独立小批次）。
- `src/i18n/messages/en.json`、`zh-CN.json` — 迁移/错误/reauth 文案。

**明确不动**
- `src/lib/encryption.ts`（LEGACY_SALT 与 v1 兼容层原样保留）；`prisma/schema.prisma` 与全部 migrations；`desktop/main/secrets.js`、`hosted-session.js`、`runtime/*`（execute-server/connection-service/pool 零接触）；`src/lib/backup/*`（覆盖与 REAUTH 语义已正确）；`src/lib/ai/managed-*`、Codex runtime 适配器；Phase B 工作树全部内容；main 仓 `.gitignore`。

---

## 11. 测试矩阵（全部合成凭据，禁真 Key）

桌面侧（`desktop/main/*.test.mjs`，vitest + mock safeStorage 对象，仿 `hosted-session.test.mjs`）：

| # | 用例 | 断言 |
|---|---|---|
| D1 | seal→unseal 往返 | 还原相等；落盘/线上无明文 |
| D2 | 重启等价（新 store 实例读旧 blob） | 可解（同 mock 即模拟同 OS 用户） |
| D3 | `isEncryptionAvailable=false` / `getSelectedStorageBackend()='basic_text'` | 三个操作全 throw，无写盘 |
| D4 | 损坏 blob / 非 base64 / 超长 body | `DECRYPT_FAILED`/`INVALID_PAYLOAD`，无内部泄漏 |
| D5 | 无 Bearer/错 Bearer/非 loopback 语义 | 401，无凭据回显 |
| D6 | 并发 seal/unseal | 无交错损坏 |

后端侧（`__tests__/*.spec.ts`，vitest + prisma fixture + fetchImpl/broker mock）：

| # | 用例 | 断言 |
|---|---|---|
| B1 | 首次保存（broker 可用） | `iv='os:v1'`，`encryptedKey` 是 base64 blob；last4 正确；连接 CONNECTED |
| B2 | 更新同 provider Key | 行被 CAS 覆写为 `os:v1`；`credentialRef` 仍指向该行；CONNECTED |
| B3 | 删除 Key | 行删；连接 DISCONNECTED；后续 resolve `BYOK_CREDENTIAL_UNAVAILABLE` |
| B4 | `os:` 行读取（重启等价） | `resolveByokCredential` 返回明文；`lastUsedAt` 更新 |
| B5 | broker 缺失时 `os:` 行 | `BYOK_CREDENTIAL_UNAVAILABLE`；legacy 路径落 env 回退 |
| B6 | **异用户/异机模拟**：unseal 返回 DECRYPT_FAILED | 执行 fail closed；显式 verify 可置 `REAUTH_REQUIRED`；read/exec 不写状态 |
| B7 | 迁移：v1 行 → os:v1 | 迁移后解析一致；`iv='os:v1'`；连接状态不变 |
| B8 | 迁移：legacy(LEGACY_SALT) 行 → os:v1 | 同上（构造 `iv` 无 `.` 的行） |
| B9 | 迁移中断模拟（seal 后 UPDATE 前抛错） | 行保持 v1；再跑迁移成功（幂等） |
| B10 | 迁移失败恢复：unseal 验证不一致/写冲突 | 行原样；摘要 `failed/skipped` 正确；连接不错标 CONNECTED |
| B11 | safeStorage 不可用 | `saveApiKey` 显式失败；已有 `os:` 行 `BYOK_CREDENTIAL_UNAVAILABLE`；v1 行仍可解（过渡期） |
| B12 | 备份恢复语义 | 导出不含 ApiKey；导入后 BYOK 连接 `REAUTH_REQUIRED`→自愈 |
| B13 | 泄漏红线 | `getUserApiKeys` 不回显 `os:`/v1 明文；日志/错误/toast/`/api/ai/*` 响应/providerMetadata/Hosted 请求体不含 Key；IPC 无凭据通道（静态断言 preload 无新增暴露） |
| B14 | Codex Account Login & Persistent Pool 零回归 | 现有 `aiConnection*`/`codex-persistent-runtime` spec 全绿 |
| B15 | Managed 不受影响 | `managedAiCore`/`AiAssignmentsCard.managed` spec 全绿；BYOK Key 永不进 hosted 请求 |
| B16 | 三路由错误域 | BYOK 失败仅 `BYOK_*`/业务码；不冒 `MANAGED_*`/`*_RUNTIME` |
| B17 | zh-CN/en | 迁移/reauth/错误文案双语言键齐全（i18n spec） |
| B18 | `resolveApiKey` legacy 契约 | env 回退、Ollama default、明文 `iv=""` 行不变 |

e2e/手测（打包版，合成 Key）：保存→重启→业务调用成功；改 Windows 用户登录→`REAUTH_REQUIRED`/`BYOK_CREDENTIAL_UNAVAILABLE`→重录恢复；还原 DB 到异机→fail closed。

---

## 12. 一次性实施批次建议（待 Owner 批准后才执行）

- **批次 1（desktop broker）**：`credential-broker.js` + test + `main.js`/`runtime.js` 接线。无生产行为变化（尚无消费方）。
- **批次 2（backend CredentialStore）**：`credential-store.ts` + 读路径分发（`byok.ts`/`api-key-resolver.ts`/`getOllamaBaseUrl`/`apiKey.actions` 写策略）+ spec。此后桌面新写即 `os:v1`。
- **批次 3（迁移）**：`credential-migration.ts` + action + BYOK 卡 UI + i18n + spec。用户显式触发。
- **批次 4（收尾，Owner 门禁）**：`ENCRYPTION_KEY` 注入移除 + 启动自动迁移 pass（如批准）+ 文档/README 更新。

建议每批次独立可合入、独立回归；批次 3 合并前批次 2 须已发布并稳定一个窗口期。

---

## 13. 与现有交付的衔接

- BYOK P1+P2（本工作树未提交）不需返工：`byok.ts`/`byok-execution.ts`/`connections.ts` 的契约全部被本设计复用；唯一触点是 `resolveByokCredential` 内部的解密调用换成 `resolveApiKeySecret`。
- `THREE_ROUTE_AI_SETTINGS_MAPPING.md` 中"BYOK 收敛进 AIConnection（方案 A）"已落地为 `LOCAL_BYOK`/`API_KEY`/`credentialRef→ApiKey.id`，本设计在其上叠加存储层升级，不引入第四条路由。
- Phase B（`fix/m6-phase-b-readiness`）与 hosted 侧完全无交集；`scan-managed-secrets` 打包扫描对 `credential-broker.js` 仍应通过（其只含 safeStorage 调用，无 hosted key 标记）。

---

设计完成，等待 Owner 审阅与单项授权。

BYOK_SECURE_STORAGE_DESIGN=READY_FOR_OWNER_REVIEW
IMPLEMENTATION=NOT_AUTHORIZED
CREDENTIAL_MIGRATION=NOT_AUTHORIZED
