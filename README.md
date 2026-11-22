<p align="center">
  <img src="./public/images/vocatrya-app-icon.svg" alt="Vocatrya logo" width="96">
</p>

<h1 align="center">Vocatrya</h1>

<p align="center">
  <strong>面向中国求职市场的 local-first Windows 桌面职业与求职管理软件</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Shushushu-coder/vocatrya" alt="License"></a>
  <a href="https://github.com/Shushushu-coder/vocatrya/stargazers"><img src="https://img.shields.io/github/stars/Shushushu-coder/vocatrya?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  中文 · <a href="./README.en.md">English</a>
</p>

---

Vocatrya 是免费开源的职业与求职管理软件，主要交付为 **Windows Electron 桌面应用**。围绕“准备 → 行动 → 复盘”，将职业资料、简历版本、职位机会、实际投递与面试记录组织在一起。

业务数据保存在本机 SQLite 数据库及文件目录中。外部 AI 和扩展会接收相关输入；local-first 不代表 AI 离线运行。Next.js 提供内部界面和本地后端，浏览器入口用于开发与兼容验证。

### 当前桌面功能

- **职业资料与简历：** 整理职业素材、导入简历，在素材库与编辑预览工作台中组合、拖拽排序和隐藏内容，创建岗位简历版本，导出 PDF 或可编辑 DOCX。
- **职位与投递：** 分别记录职位机会与每次实际申请，保存投递时使用的简历版本，关联公司、联系人、面试轮次与复盘，保留历史投递事实。
- **面试与复盘：** 管理面试题、面试轮次与真实面试复盘，将准备材料关联到职位。
- **概览与下一步：** 查看职位、实际投递、面试和 Offer 等统计；下一步建议由已有业务数据按规则生成，不自动发起 AI 调用或执行任务。
- **任务：** 管理求职待办、任务分类与截止日期。
- **三个 AI 助手：** Voca Insight（求职分析师）、Voca Pilot（全局助手）、Voca Reflect（复盘教练）协助分析求职进展、处理日常问题和复盘经历；选择建议不会自动发送消息。实际工具随角色、连接和运行模式变化。
- **归档与备份：** 长期保留并随时恢复已归档的职位和 AI 对话；在设置中导出、导入业务备份。备份不包含连接凭据，恢复后需重新连接服务。

还可设置界面语言、外观、显示时区及桌面托盘行为。职业资料中的证件、证明人等敏感信息受独立保护，不默认发送给 AI。

当前处于 RC 迭代阶段，部分增量功能仍待完成桌面验收。版本变更见 [更新摘要](release-notes/)。

### AI 连接与模型

可以通过受支持的官方账号运行时连接 AI，也可以自行接入模型 API（BYOK）。可用模型与能力取决于连接状态、运行时版本及账号权限；自接 API 的凭据和费用由用户与对应服务商管理。Vocatrya 托管 API 尚未推出。

添加连接后，按需要分配默认模型或具体业务用途；模型选择以连接实际提供的目录为准。流式、结构化输出与工具调用要求因用途而异，不以品牌或固定模型名单承诺全部能力。

普通对话由 Vocatrya 编排业务工具。Codex 原生会话是需要显式选择的独立模式，受兼容版本与能力门控限制；账号登录不代表已经继承官方客户端的搜索、工具、MCP 或 Skills。

写入确认取决于工具、权限模式与目标操作；具体执行结果以应用记录与回执为准。角色切换不会自动发送消息或执行建议。

### 扩展与当前边界

- **Notion：** 已有连接及受控读写实现，仍有异常与凭据边界待验收；可用操作受连接授权、助手角色和审批规则约束。
- **配套网申工具：** 已有浏览器扩展及资料配对同步的部分实现，目前暂停继续推进。填写表单不等于已投递，最终提交仍由用户完成。
- **网页面试练习：** 独立入口转向网页工具，目标服务尚未接入；不影响职位关联的面试轮次、题库和真实面试复盘。
- **网页读取：** 限用户在会话中明确提供的网址，不等同于自主搜索或浏览器操作。

### 桌面使用与源码开发

Windows 桌面源码构建、隔离数据目录与启动步骤见 [桌面开发与 E2E](desktop/E2E.md)。开发测试应使用独立 Worktree 和全新数据目录，不复制真实配置或用户数据库。

浏览器路径仅用于 Next.js 页面开发和兼容回归，环境配置见 [贡献指南](CONTRIBUTING.md)。`npm run dev` 不启动 Electron；`npm run test:e2e:web` 只覆盖浏览器，`npm run test:e2e:desktop` 才驱动 Windows Electron。运行前请核对桌面文档中的前提与测试范围。

### 贡献与支持

欢迎提交问题与改进，参与前请阅读 [贡献指南](CONTRIBUTING.md) 和 [行为准则](CODE_OF_CONDUCT.md)。欢迎在 [GitHub](https://github.com/Shushushu-coder/vocatrya) 上给项目一个 Star。

感谢上游 JobSync，以及 React、Next.js、Prisma、Electron、Tailwind CSS、shadcn/ui、Tiptap、Nivo 和 Vercel AI SDK 等开源项目。

> **上游声明：** Vocatrya 衍生自 [JobSync](https://github.com/Gsync/jobsync)（[Gsync](https://github.com/Gsync)，MIT）。原始版权声明与许可证保留在 [LICENSE](LICENSE) 中。
