# Vocatrya 自动网申配套插件

本目录是 Vocatrya「自动网申」功能的配套浏览器扩展，基于 MIT 开源项目
[OpenJobAutofill](https://github.com/Br1an67/OpenJobAutofill) 维护。
当前阶段仅支持 **手动导出/导入** 路径；连接式（应用↔插件配对、按需同步）
尚未交付。

## 固定的上游版本

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/Br1an67/OpenJobAutofill |
| 固定提交 | `005eda98841b3671ead615ebfde5922f0dfd7c36` |
| 提交信息 | Improve CN site autofill with AI-first matching（2026-05-13，Br1an67） |
| manifest 版本 | `1.0.2`（`manifest_version: 3`） |
| 许可证 | MIT，见 `LICENSE`（Copyright (c) 2026 Br1an67），复制时保留版权与许可声明 |
| 取回日期 | 2026-11-13 |

`manifest.json`、`src/`、`icons/`、`LICENSE`、`README.md`、`README.en.md`、
`sample-profile.json` 与该提交逐字节一致（SHA-256 已核对）。未随附：

- `assets/`：README 演示截图（约 3.3 MB），不属于扩展运行文件；
- `.gitignore`：上游仓库开发用忽略规则，对本目录无意义。

## 安装与手动导入

1. Chrome / Edge 打开 `chrome://extensions`（Edge 为 `edge://extensions`），
   开启「开发者模式」。
2. 「加载已解压的扩展程序」，选择本目录（`extensions/auto-apply/`，即
   `manifest.json` 所在目录）。
3. 在 Vocatrya「扩展工具 → 自动网申」详情页选择要导出的资料板块并导出
   JSON 文件。
4. 打开插件选项页（扩展详情 → 扩展程序选项，或工具栏图标 → 设置），点击
   「导入资料备份」，选择上一步导出的 JSON，然后「保存资料」。
5. 资料更新后在 Vocatrya 重新导出，并在插件中重新导入；导入是整份替换
   插件内资料，不保留旧副本。

## 数据边界（本阶段）

- Vocatrya 只导出**用户明确选择**的非敏感资料板块；证件类型与号码、紧急
  联系人、家庭成员、证明人联系方式、附件与文件、账号与凭据一律不导出。
- 导出文件与上游备份格式兼容（`format: "OpenJobAutofillProfileBackup"`，
  `version: 1`），并在顶层 `source` 字段标识来源、上游固定版本与导出时间；
  该字段被上游导入器忽略，不影响导入。
- 插件端 AI 字段识别是**可选项**：Vocatrya 不接入、也不向插件写入任何
  模型凭据；插件本地规则填写路径默认可用。
- 插件不会自动点击提交；最终提交始终由用户在招聘网页手动完成。填写
  记录不会在 Vocatrya 侧生成「已投递」事实。
- 手动导入完成后插件可脱离 Vocatrya 运行；这不等于连接式目标已交付。

## 应用侧接口（供扩展工具列表页 A 使用）

- 状态接口：`src/lib/extensions/autoApply/status.ts` 导出
  `getAutoApplyExtensionStatus(db, userId)`，返回
  `{ available, exportableItemCount, lastSourceUpdatedAt, detailPath, plugin }`。
  `available` 为 false 时附 `reason`（如 `career_read_disabled`），卡片应
  按真实状态展示，不要虚构「已连接」。
- 详情页路由：`/dashboard/extensions/auto-apply`（本任务交付；列表页与
  共享导航/文案归 A）。
- 文案清单：详情页使用的功能内文案见
  `src/components/extensions/auto-apply/autoApplyCopy.ts`（zh-CN / en 两份，
  键名一致）；并入共享翻译文件时按该文件键值迁移。
