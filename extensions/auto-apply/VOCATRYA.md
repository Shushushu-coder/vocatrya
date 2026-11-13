# Vocatrya 自动网申配套插件

本目录是 Vocatrya「自动网申」功能的配套浏览器扩展，基于 MIT 开源项目
[OpenJobAutofill](https://github.com/Br1an67/OpenJobAutofill) 维护。
支持两条资料通路：**应用↔插件配对后按需同步**（推荐），以及
**手动导出/导入**（备用，始终可用）。

## 固定的上游版本

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/Br1an67/OpenJobAutofill |
| 固定提交 | `005eda98841b3671ead615ebfde5922f0dfd7c36` |
| 提交信息 | Improve CN site autofill with AI-first matching（2026-05-13，Br1an67） |
| manifest 版本 | `1.0.3`（`manifest_version: 3`，Vocatrya 连接层为本地增量） |
| 许可证 | MIT，见 `LICENSE`（Copyright (c) 2026 Br1an67），复制时保留版权与许可声明 |
| 取回日期 | 2026-11-13 |

`manifest.json`、`src/`、`icons/`、`LICENSE`、`README.md`、`README.en.md`、
`sample-profile.json` 在固定提交基础上仅叠加了 Vocatrya 连接层改动
（manifest 版本号、options/popup 连接卡片、background 连接消息处理）；
其余与上游逐字节一致。未随附：

- `assets/`：README 演示截图（约 3.3 MB），不属于扩展运行文件；
- `.gitignore`：上游仓库开发用忽略规则，对本目录无意义。

## 连接式同步（推荐）

1. Chrome / Edge 打开 `chrome://extensions`（Edge 为 `edge://extensions`），
   开启「开发者模式」，「加载已解压的扩展程序」选择本目录。
2. 在 Vocatrya「扩展工具 → 自动网申」详情页勾选允许插件读取的资料板块，
   点击「生成配对码」并复制（10 分钟内有效、只能使用一次）。
3. 打开插件选项页「Vocatrya 连接」卡片，粘贴配对码并点击「配对并连接」；
   浏览器会请求访问该回环地址的权限（`http://127.0.0.1:<动态端口>`），
   允许后即完成配对。
4. 点击「同步资料」或在弹层中点击「同步资料」，插件把应用内资料同步到
   本机 `profileV2`（整份替换）。资料变化后再次点击即可刷新；连接卡片
   与弹层会显示上次同步时间、资料版本、过期与失败状态。
5. 在 Vocatrya 详情页「连接状态」可查看全部已配对插件并撤销；在插件
   选项页点击「断开连接」同样立即失效该令牌。撤销/断开后旧令牌不能
   继续读取，插件内已同步副本保留在本机并标记为过期。

### 连接协议

- 配对 URI：`vocatrya-auto-apply://pair?v=1&app=<origin>&code=<code>`，
  由应用生成、仅显示一次；插件端校验 `app` 必须是回环地址
  （127.0.0.1 / localhost / [::1]）。
- 接口（均要求 `x-vocatrya-client: auto-apply-extension` 头）：
  - `POST /api/extensions/auto-apply/connect/exchange`：配对码一次性
    兑换访问令牌，返回 `{ connectionId, accessToken, allowedSections,
    appName, appVersion }`；
  - `GET /api/extensions/auto-apply/connect/profile?sections=…`：
    Bearer 令牌按需拉取资料，返回 `profileV2` 与透明化报告
    （ambiguous / unsupported / sensitiveExcluded）；
  - `GET /api/extensions/auto-apply/connect/status`：轻量存活/资料
    更新时间检查，用于「资料有更新」提示；
  - `POST /api/extensions/auto-apply/connect/disconnect`：插件以自身
    令牌撤销连接。
- 服务端只存配对码与令牌的 SHA-256 哈希；明文仅存在用户剪贴板与
  插件 `chrome.storage.local`，不进入日志、导出文件或网页内容脚本。
- 令牌绑定创建配对的账号：一个令牌只能读取所属用户的授权板块，
  `sections` 参数只能收窄配对时授权的集合。
- 同步是整份替换插件内资料，不做增量合并。

## 安装与手动导入（备用）

1. 按上文方式加载扩展。
2. 在 Vocatrya「扩展工具 → 自动网申」详情页选择要导出的资料板块并导出
   JSON 文件。
3. 打开插件选项页，点击「导入资料备份」，选择导出的 JSON，然后
   「保存资料」。
4. 资料更新后在 Vocatrya 重新导出，并在插件中重新导入；导入是整份替换
   插件内资料，不保留旧副本。

## 数据边界

- Vocatrya 只提供**用户明确选择**的非敏感资料板块；证件类型与号码、紧急
  联系人、家庭成员、证明人联系方式、附件与文件、账号与凭据一律不提供，
  同步与手动导出共用同一份白名单与转换报告。
- 导出文件与上游备份格式兼容（`format: "OpenJobAutofillProfileBackup"`，
  `version: 1`），并在顶层 `source` 字段标识来源、上游固定版本与导出时间；
  该字段被上游导入器忽略，不影响导入。连接式同步直接返回 `profileV2`，
  不经过备份文件。
- 插件端 AI 字段识别是**可选项**：Vocatrya 不接入、也不向插件写入任何
  模型凭据；插件本地规则填写路径默认可用。
- 插件不会自动点击提交；最终提交始终由用户在招聘网页手动完成。填写
  记录不会在 Vocatrya 侧生成「已投递」事实。
- 连接式同步需要 Vocatrya 应用运行且授权有效；应用未运行时插件沿用
  上次同步副本并明确标注。手动导出/导入始终可用作备用方式。
- 访问令牌保存在插件 `chrome.storage.local`（service worker 私有），
  不注入任何网页 content script；配对码/令牌不写入日志或导出文件。

## 应用侧接口（供扩展工具列表页 A 使用）

- 状态接口：`src/lib/extensions/autoApply/status.ts` 导出
  `getAutoApplyExtensionStatus(db, userId)`，返回
  `{ available, exportableItemCount, lastSourceUpdatedAt, connections,
  detailPath, plugin }`。`connections` 含 `{ active, lastSyncAt }`；
  `available` 为 false 时附 `reason`（如 `career_read_disabled`），
  卡片应按真实状态展示，不要虚构「已连接」。
- 详情页路由：`/dashboard/extensions/auto-apply`（本任务交付；列表页与
  共享导航/文案归 A）。
- 文案清单：详情页使用的功能内文案见
  `src/components/extensions/auto-apply/autoApplyCopy.ts`（zh-CN / en 两份，
  键名一致）；并入共享翻译文件时按该文件键值迁移。
