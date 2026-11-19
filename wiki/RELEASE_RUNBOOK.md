# Vocatrya 发版 Runbook

每次发版（RC 内测版与正式版）的标准流程、门禁位置与失败处理。Windows 安装包由**本地流水线**产出；`.github/workflows/release.yml` 只负责 bump、CHANGELOG、tag 与 GitHub Release 页，不产 exe、不上传 exe（2026-11-19 起不再构建 Docker 镜像，上游 JobSync 的 Docker/Web 部署链路已退役）。

**2026-11-18 起**：发版强制要求仓库内 `release-notes/<version>.md` 双语更新摘要，缺失或缺段时三道门禁各自拦截（见 §2）。应用内「设置 → 关于 → 更新说明」展示当前版本与最新版本摘要，数据通路见 §3。

## 1. release-notes/<version>.md 编写规则

- **文件名与版本串完全一致**，含 RC 后缀：`release-notes/1.2.2-rc.md` ↔ 版本 `1.2.2-rc`。
- 文件结构：首行 `<!-- vocatrya-release-notes -->` 标记，随后 `## zh-CN` 与 `## en` 两个二级分段，段内为要点列表。
- **用户视角的要点摘要**（新增/改进/修复），不是 commit 清单；细粒度历史由 release.yml 自动生成的 CHANGELOG.md 承担。
- 其他 `## ` 标题（如发版追加的 `## Links`）只起分段截断作用，不会渲染进应用内。

## 2. 三道存在性门禁

| 门禁 | 位置 | 拦截点 |
| --- | --- | --- |
| 打包前置检查 | `desktop/scripts/package.mjs` | `npm run build` **之前**：文件缺失或缺 `## zh-CN`/`## en` 段直接 throw，不浪费构建 |
| 发布评估 | `desktop/scripts/release-gate.mjs` | manifest 评估新增 `RELEASE_NOTES_MISSING` 失败项 |
| GitHub 发版 | `.github/workflows/release.yml` prepare 关卡 | 解析版本后、任何构建工作前拦截整条流水线 |

## 3. 应用内消费通路

- 「当前版本」：`GET /api/release-notes` 读安装包随附的 `release-notes/<version>.md`，按 UI locale 提取对应段（缺则回退另一语言）。
  - 安装版：`assemble.mjs` 把 `release-notes/` 拷至 backend 根（backend cwd 即该目录）；dev/浏览器直读仓库 `release-notes/`。
  - 可用 `VOCATRYA_RELEASE_NOTES_DIR` 覆盖目录。
- 「最新版本」：仅当 `isNewerVersion(latest, current)` 成立时展示，摘要取自 GitHub release 正文（即发版时写入的同一文件），并附发布页链接。**老格式 release 正文（commit 自动拼接）没有 locale 分段，只显示版本号与链接**，属预期降级。
- 更新说明卡位于「设置 → 关于」上方；两来源皆无内容时整卡不渲染。

## 4. RC / 内测版流程

RC 版本号不满足 release.yml 的严格 semver 输入（`^[0-9]+\.[0-9]+\.[0-9]+$`），走手工流程：

1. `package.json` bump 至目标 RC 版（如 `1.2.2-rc`）。
2. 写 `release-notes/1.2.2-rc.md`，**与 bump 同次提交**并打 tag `v1.2.2-rc`。
3. `npm run desktop:installer`（即 `package.mjs`）：notes 门禁 → `next build` → 后端装配（standalone + public + static + release-notes + prisma-runtime + fresh-native）→ 打包 Node 运行时与 licenses → 写 `resources/build-info.json` → 禁物扫描 → electron-builder/NSIS → 产出 `.codex-tmp/windows-installer/dist/Vocatrya-Setup-<version>-x64.exe` 与 `SHA256SUMS.txt`，并校验 win-unpacked 布局。
4. `npm run desktop:release:manifest` → `npm run desktop:release:verify` → `npm run desktop:release:gate`（`--policy internal-unsigned`）。
5. 手工分发 exe。

**RC 验收与缺陷流转约束**：

- **构建-提交对应**：验收结论必须标注所测构建对应的代码（tag/commit）。RC 分支后续修复一旦提交，已分发安装包即过期——其上的任何验收证据只覆盖旧代码，不得记为新修复已验收。
- **证据分级**：台账 `passes: true` 只认 Windows Electron 实测（真实交互、真实模型行为、真实持久化核对）。Web 验证、单测、mock、合成夹具、模型口述均不构成验收，如实记 NOT_RUN/BLOCKED；工具行为须核调用记录而非回复文本。
- **缺陷流转**：RC 上验出的缺陷修在当前 RC 分支；修复的桌面复验可并入下一 RC 构建统一实测（如 1.2.2-rc 修复 → 1.2.3-rc 验收）。并入期间台账记「已修复待桌面复验」，`passes` 不因修复提交提前置 true。
- **数据边界**：验证一律用隔离数据根，不碰用户安装版数据目录；含 migration 的版本按风险决定是否拿旧版数据副本实测升级路径，跳过须在台账注明。

## 5. 正式版（x.y.z）流程

1. 确定目标版本号，**先提交 `release-notes/<version>.md`**（此时 `package.json` 仍为旧版，属预期）。
2. Actions → `Release`（workflow_dispatch）输入 bump（patch/minor/major/semver）：
   - **prepare**：解析目标版本 → notes 门禁；
   - **verify**：`npm ci` / `prisma generate` / `tsc --noEmit` / `lint` / `test`；
   - **publish**：`npm version` bump、自动更新 `CHANGELOG.md`、atomic push main + tag、`gh release create`（正文 = notes 文件 + 追加 `## Links`/Full Changelog 链接）。
3. tag 落到 main 后，在**该 tag 对应提交**上本地跑 `npm run desktop:installer`（此时 package.json 已是新版，门禁命中同一 notes 文件）。
4. manifest → verify → gate，产出 exe。
5. 分发；如需挂到 Release 页：`gh release upload v<version> Vocatrya-Setup-<version>-x64.exe`（当前无自动化）。

## 6. 时序与已知窗口

- **notes 必须先于版本生效**：RC 与 bump 同次提交；正式版先于跑 workflow 提交。
- Release 页（含摘要）先于 exe 上线期间，老版本用户会看到「有更新 + 更新摘要」但安装包未分发——分发是手工环节，此窗口天然存在，尽量缩短 workflow 到 exe 上传的间隔。
- **失败处理**：各步 fail-fast；package.mjs 失败直接 throw；verify/gate 输出 `failures` 清单、退出码 1，报告在 `.codex-tmp/windows-release/<version>/`。release.yml 可同参数重跑（publish 前无 git 副作用；tag 已推而 release 步骤失败时，手工 `gh release create <tag> --notes-file release-notes/<version>.md` 补建）。

## 7. 签名与自动更新现状

- `build-info.json` 记录 `codeSigning`/`autoUpdate` = `NOT_IMPLEMENTED`；release-gate 的 `public-signed` 策略当前必败（`PUBLISHER_IDENTITY_UNRESOLVED`），现阶段仅 `internal-unsigned`。
- 应用**无自动更新**；「最新版本」判定依赖 `/api/version` → GitHub `releases/latest`，离线或限流静默降级为"无更新"。

## 8. 维护

发布链路变更（`package.mjs`/`assemble.mjs`/`release.yml`、门禁项、notes 文件格式、分发方式）时同步更新本 Runbook。
