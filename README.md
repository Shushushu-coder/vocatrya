<p align="center">
  <img src="./public/images/vocatrya-app-icon.svg" alt="Vocatrya logo" width="96">
</p>

<h1 align="center">Vocatrya</h1>

<p align="center">
  <strong>面向中国求职市场的 local-first Windows 桌面职业与求职管理软件<br>
  A local-first career &amp; job-search manager for Windows desktop, built for the Chinese job market</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Shushushu-coder/vocatrya" alt="License"></a>
  <a href="https://github.com/Shushushu-coder/vocatrya/stargazers"><img src="https://img.shields.io/github/stars/Shushushu-coder/vocatrya?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

---

<a id="中文"></a>
## 中文

> **上游声明：**
> Vocatrya 是基于 [JobSync](https://github.com/Gsync/jobsync)（由 [Gsync](https://github.com/Gsync) 以 MIT 许可证创建）衍生的开源项目。原始版权声明与许可证保留在 [LICENSE](./LICENSE) 中。

Vocatrya 是一款免费、开源的求职管理助手：跟踪职位申请、管理与导出简历，内置 AI 助手可以评阅简历、匹配职位、撰写求职信，或从你粘贴的招聘启事中直接录入职位——所有数据自托管在你自己的机器上，完全由你掌控。AI 功能可以完全通过 Ollama 在本地运行，也可以使用你选择的云服务提供商；内置的 MCP 服务器让 Claude Desktop 等 AI Agent 可以直接在对话中帮你录入职位和面试题。

Vocatrya 当前主要交付形态是 **Windows Electron 桌面应用**，Next.js 提供内部界面和本地后端。浏览器路径保留用于 Web 开发和兼容验证，不代表当前桌面产品的完整体验。

### 核心功能

- **申请跟踪：** 详细记录每一次职位申请，包括公司信息、职位名称、申请日期与当前状态。
- **数据看板：** 通过交互式看板直观了解求职进展，包括申请活跃度、成功率与待办任务。
- **简历管理：** 存储并管理多份简历，导出为专业排版 PDF（Simple 或 Professional 模板），并可交给 AI 评阅、与职位描述做匹配。支持从 PDF 或 Word（.docx）导入既有简历——AI 自动提取并结构化你的联系方式、工作经历、教育与证书，逐段确认后保存。
- **职位自动发现：** 配置自动化任务定时跟踪招聘板上的公司，AI 将新职位与你的简历匹配，把最合适的机会推送给你。详见下文[职位自动发现](#职位自动发现)。
- **任务与活动管理：** 管理任务、记录与任务关联的活动及耗时。
- **联系人管理：** 记录求职过程中的人脉——猎头、招聘经理、面试官、内推人、证明人——包括你们的关系与最近联系时间。同一联系人可以关联到多个职位并标注各自角色，按角色筛选即可一键找到所有证明人。
- **公司主页：** 每家公司有独立详情页，包含其职位、在职或与你共事过的人，以及官网、招聘页和招聘板链接。关注公司加入 watchlist；有招聘板的已关注公司在创建自动化任务时单独成组。
- **面试题库：** 建立按技能标签组织的面试题与答案库，下次面试前你的准备材料都在一处。
- **数据备份与恢复：** 在 **设置 > 数据** 中把所有职位、简历、任务、活动、联系人和题库连同已上传的简历文件打包为一个 zip 导出，可导入到任何 Vocatrya 实例。备份绝不包含 API Key、MCP Token 或密码；每次导入前自动保存快照，可一键撤销。
- **AI 助手：** 常驻在页面侧边的聊天面板，可以评阅简历、给当前职位打分匹配度、写定制求职信、或从你粘贴的招聘启事中录入职位——保存任何内容前都会先征求你的确认。详见下文 [AI 助手](#ai-助手应用内对话)。
- **AI Agent 集成（MCP）：** 通过内置 MCP 服务器接入 Claude Desktop 等 AI Agent，经你确认后直接在对话中录入职位申请与题库条目。职位描述足够完整时，Agent 还可以对照你的默认简历做匹配并把得分存入系统。

### 快速开始

Windows 桌面源码启动与验收请先阅读 [桌面开发与 E2E](desktop/E2E.md)。以下步骤仅适用于 **Web 兼容运行**（开发用）。

```sh
git clone https://github.com/Shushushu-coder/vocatrya.git
cd vocatrya
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

打开 [http://localhost:3737](http://localhost:3737) 并创建账号。AI 服务商的 API Key 可在登录后于 **设置** 中配置。完整开发环境搭建见 [CONTRIBUTING.md](CONTRIBUTING.md)。

#### 配置（可选）

环境变量写在 `.env` 中（参考 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `TZ` | 你的时区（如 `Asia/Shanghai`）。**在远程服务器上必须设置**，否则活动时间会偏移。 |
| `AUTH_SECRET` | Web 运行必需。用 `openssl rand -base64 32` 生成。 |
| `ENCRYPTION_KEY` | 加密你在设置中保存的 API Key。**添加任何 Key 之前先自己生成**（`openssl rand -base64 32`），之后不要更改——换了值所有已存 Key 都无法恢复。 |
| `NEXTAUTH_URL` | 你访问 Vocatrya 的地址，默认 `http://localhost:3737`。 |
| `MCP_ENABLED` | 设为 `false` 可关闭 [MCP 服务器](#mcp-服务器ai-agent-集成)。 |

### 功能详解

#### AI 助手（应用内对话）

Vocatrya 的所有 AI 功能集中在一个地方：一个停靠在应用侧边、不抢占页面的聊天面板——助手工作时，你所在的页面保持可见可用。

从头部的 **AI Assistant** 按钮打开，或让应用替你打开：简历页的 **Review**、职位页的 **Match with AI** 和 **Cover Letter** 按钮都会把对应请求直接送入面板。

你可以让它做这些事：

- **简历评阅** — 对任意一份简历做完整评阅，给出评分和文字反馈，结果保存在简历上随时可以回看。
- **职位匹配** — 评估你的某份简历与当前查看职位的匹配程度，给出匹配分、建议和说明，保存在职位上。先打开职位页，助手给的就是当前页面的职位。
- **求职信** — 根据你的简历和职位描述（以及此前匹配的建议）为当前职位写定制求职信，保存到你的文档。再问一次会得到一封新信，不会覆盖旧的。
- **从招聘启事录入职位** — 把招聘启事粘贴进对话让它添加职位。它会提取公司、职位名、地点、薪资、标签等字段，先显示在确认卡片上让你过目——职位描述按你粘贴的原文保存，不做摘要；你按确认之前不会写入数据库。

评阅、匹配和求职信与过去专用面板产出的是同一套分析——对话是新的入口，不是缩水版。

助手能看到的范围被刻意收窄：它只读你的简历和你当前正在看的这一个职位，不能列出或搜索你的职位，也看不到任务和活动。粘贴的招聘启事按不可信文本处理，启事里夹带的指令无法让助手操作你的数据。

使用面板前先在 **设置 > AI 设置** 选择一个模型——需要支持工具调用（tool calling）的模型；没配置时它会告诉你而不是硬猜。已实测可用的模型见[支持的 AI 服务商](#支持的-ai-服务商)，其中包括完全本地的选项。

#### PDF 简历导出

在简历页直接将任意简历导出为专业排版 PDF。可选两种版式：简洁的 **Simple** 模板和更精致的 **Professional** 模板。若已有 PDF 附件，会提示你选择替换还是仅下载。

#### 简历导入

从 PDF 或 Word（.docx）文件导入既有简历。AI 提取结构化数据——联系方式、摘要、技能、工作经历、教育背景、证书——并按卡片逐段呈现，你可以在保存前逐段接受或跳过。

#### 职位自动发现

配置自动化任务按计划搜索新职位，并与你的简历做 AI 匹配，让合适的机会主动来找你。

- **Greenhouse** — 在内置目录中按公司名（或粘贴招聘板 URL）跟踪指定公司。每次运行拉取这些公司 Greenhouse 招聘板上的全部已发布职位，先按你的目标职位、技能与简历做快速本地相关性评分，只对头部候选运行 AI 匹配以控制成本。无需 API Key。
- **Lever** — 与 Greenhouse 相同的公司跟踪流程，内置 1,160+ 公司目录（或粘贴招聘板 URL）。自动为每家公司解析正确的区域 API（`lever.co` 或 `eu.lever.co`），并完整保留职位上的远程/混合/现场信息。无需 API Key。
- **Ashby** — 相同的公司跟踪流程，内置 1,860+ 公司目录（或粘贴招聘板 URL）。无需 API Key。

更多招聘板来源正在路上。发现的职位进入待审队列——接受即转入你的职位跟踪，其余可忽略。

#### MCP 服务器（AI Agent 集成）

Vocatrya 内置 MCP 服务器，让 AI Agent（Claude Desktop、Hermes、OpenClaw 等）经你确认后直接录入职位申请和题库条目。

##### 使用场景

正在别处浏览招聘信息或面试题，不想打断手头流程去手动记录？直接让已连接的 AI Agent 帮忙，例如：

- *"把这个职位加到我的 Vocatrya（复制/粘贴完整职位信息，或直接给链接）：Senior Backend Engineer at Acme Corp，职位类型、地点、职位描述……"*
- *"刚才面试被问到这个问题——加进我的题库：'How would you design a rate limiter?'，我的回答是：……"*

Agent 会按名称解析或创建公司、职位、地点和标签，并报告哪些是匹配已有、哪些是新建——数据自动去重，你不用切回应用。

当添加的职位包含足够完整的描述、且你已设置**默认简历**（Profile）时，Agent 还会对照该简历分析匹配度并保存匹配分——无需回到应用。结果与应用内 AI 匹配一样展示在职位上，含评分、建议与说明。

##### 1. 生成 Token

1. 登录 Vocatrya，进入 **设置 > MCP Access**。
2. 点击 **Generate**，命名（例如将要连接的客户端 "Claude Desktop"），选择有效期。
3. 复制弹出的 Token 与配置片段——完整 Token 只显示一次。

##### 2. 接入 MCP 客户端

<details>
<summary><strong>Claude Desktop</strong></summary>

1. 打开 Claude Desktop → **Settings > Developer > Edit Config**，会在默认编辑器中打开 `claude_desktop_config.json`。
2. 把弹窗中 "Claude Desktop (via mcp-remote)" 片段粘贴到 `mcpServers`，例如：

```json
{
  "mcpServers": {
    "vocatrya": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://<your-vocatrya-url>/api/mcp",
        "--header",
        "Authorization: Bearer <your-token>"
      ]
    }
  }
}
```

3. 保存并完全重启 Claude Desktop（退出进程，不是只关窗口）。

> **注意：** Claude Desktop 只原生支持本地（stdio）MCP 服务器，因此需要 `mcp-remote` 作为到 Vocatrya 远程端点的桥接。

</details>

<details>
<summary><strong>其他客户端（OpenClaw、Hermes 等）</strong></summary>

原生支持 `streamable-http` 的客户端可以直接连接，无需 `mcp-remote`：

```json
{
  "mcpServers": {
    "vocatrya": {
      "type": "streamable-http",
      "url": "http://<your-vocatrya-url>/api/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

</details>

> **在家庭网络自托管？** 如果你的 Vocatrya 地址是局域网 `http://`（非 `localhost` 或 HTTPS），需要在 `mcp-remote` 参数中加 `--allow-http`——它默认拒绝非 HTTPS 地址。检测到非 localhost 的 HTTP 地址时，设置页会自动加上该参数。

### 开发说明

- **源码桌面启动：** Windows 安装依赖后，按 [桌面开发与 E2E](desktop/E2E.md) 在独立 Worktree 设置隔离数据目录、构建并启动开发桌面壳。这是源码开发路径，不会安装或发布应用。
- **测试入口：** `npm run test:e2e:desktop` 验证真实 Electron 窗口；`npm run test:e2e:web` 仅验证浏览器页面。新用户桌面使用 fresh-native 模式，自动化巡检等 Legacy 入口不属于该模式；桌面的新建、上传操作位于最顶部标题栏。

### 贡献

欢迎贡献代码！请先阅读[贡献指南](./CONTRIBUTING.md)。本项目遵循[行为准则](./CODE_OF_CONDUCT.md)——参与即表示你同意遵守其规范。

#### 致谢与上游

- **基础项目：** [JobSync](https://github.com/Gsync/jobsync) — 由 [Gsync](https://github.com/Gsync) 创建（MIT 许可证，Copyright © 2024 gsync）
- <a href="https://github.com/facebook/react">React</a>
- <a href="https://github.com/vercel/next.js">Next</a>
- <a href="https://github.com/shadcn-ui/ui">Shadcn</a>
- <a href="https://github.com/prisma/prisma">Prisma</a>
- <a href="https://github.com/tailwindlabs/tailwindcss">Tailwind</a>
- <a href="https://github.com/ueberdosis/tiptap">Tiptap</a>
- <a href="https://github.com/plouc/nivo">Nivo</a>
- <a href="https://github.com/sqlite/sqlite">Sqlite</a>
- <a href="https://github.com/vercel/ai">Vercel AI-SDK</a>
- <a href="https://github.com/ollama/ollama">Ollama</a>

#### 支持的 AI 服务商

所有云服务商的 API Key 在登录后于 **设置 > AI 设置** 中配置。Ollama 为默认服务商。

> **注意：** 所选模型必须支持**结构化输出**与**工具调用**才能正常使用 AI 功能——AI 助手面板通过调用工具工作，不支持工具的模型只会回复文字而不会执行任何操作。

**已实测可用模型：** AI 助手已端到端测试过 Ollama 的 `qwen3.5:9b`（完全本地）、`deepseek-v4-flash` 和 OpenAI `gpt-4.1`。其他支持工具调用的模型应该也能用，但以上是跑过全部助手功能的。

<details>
<summary><strong>Ollama（本地）</strong></summary>

配合 [Ollama](https://ollama.com) 在你自己的机器上运行 AI 模型。

- 确保 Ollama 已安装并在同一系统运行
- AI 设置页会基于你已下载的模型列出可选模型
- **建议：** 将 Ollama 上下文长度从默认 4k 提高到 16k——可避免自动职位匹配截断较长的简历/职位描述提示词。AI 助手、简历评阅、职位匹配和求职信功能不受影响：它们每次调用都会向 Ollama 请求所需上下文大小，提高默认值不会改变它们；也不要调得太高——过大的默认值只会明显拖慢响应而没有收益
- 无需 API Key——完全在你的硬件上运行
- 如果 Vocatrya 部署在家庭服务器上，可在本机 Ollama 设置中对外开放访问，并确保设置页 API Key 区域的 Ollama Base URL 指向本机 IP

</details>

<details>
<summary><strong>OpenAI</strong></summary>

- 在 [platform.openai.com/api-keys](https://platform.openai.com/api-keys) 获取 API Key
- 在 **设置 > AI 设置** 中填入
- 选择 **OpenAI** 作为服务商并选择模型
- 可用模型列表从 OpenAI API 动态获取

</details>

<details>
<summary><strong>DeepSeek</strong></summary>

- 在 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 获取 API Key
- 在 **设置 > AI 设置** 中填入
- 选择 **DeepSeek** 作为服务商并选择模型

</details>

<details>
<summary><strong>Google Gemini</strong></summary>

- 在 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 获取 API Key
- 在 **设置 > AI 设置** 中填入
- 选择 **Gemini** 作为服务商并选择模型

</details>

<details>
<summary><strong>OpenRouter</strong></summary>

通过一个 API 接入多家服务商的多种模型。

- 在 [openrouter.ai/keys](https://openrouter.ai/keys) 获取 API Key
- 在 **设置 > AI 设置** 中填入
- 选择 **OpenRouter** 作为服务商并选择模型

</details>

#### 备注

- 如果你是从旧版本升级且已登录，请尝试退出后重新登录。

### 支持项目

如果 Vocatrya 对你的求职有帮助，欢迎在 GitHub 上给它一个 Star！这能帮助更多人发现项目，也是我们持续开发的动力。

每一个 Star 都很重要——感谢支持！

---

<a id="english"></a>
## English

> **Upstream Attribution:**
> Vocatrya is an open-source project derived from [JobSync](https://github.com/Gsync/jobsync) (created by [Gsync](https://github.com/Gsync) under the MIT License). The original copyright notice and license are preserved in [LICENSE](./LICENSE).

Vocatrya is a free, open-source companion for your job search: track applications, manage and export resumes, and ask a built-in AI assistant to review a resume, match it against a job, write a cover letter, or add a job from a posting you paste in — all self-hosted on your own machine, so your data stays under your control. AI features can run entirely locally via Ollama or through your choice of cloud provider, and Vocatrya's built-in MCP server lets AI agents like Claude Desktop add jobs and interview questions straight from your chat.

The primary shipping form today is a **Windows Electron desktop app**; Next.js provides the internal UI and local backend. The browser path is kept for web development and compatibility checks — it is not the full desktop product experience.

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#ai-assistant-in-app-chat">AI Assistant</a> ·
  <a href="#mcp-server-ai-agent-integration">MCP Setup</a>
</p>

### Key Features

- **Application Tracker:** Keep a detailed record of all your job applications, including company details, job titles, application dates, and current status.

- **Monitoring Dashboard:** Visualize your job search progress with an interactive dashboard that provides insights into your application activities, success rates, and upcoming tasks.

- **Resume Management:** Store and manage your resumes, export them as professionally formatted PDFs (Simple or Professional template), and use them with AI to get reviews and match with job descriptions. Import existing resumes from PDF or Word (.docx) files — AI extracts and structures your contact info, experience, education, and certifications so you can review and save each section individually.

- **Automated Job Discovery:** Schedule automations that track companies via job board APIs, then AI-match each listing against your resume and surface the best fits for review. See [Features in Detail](#automated-job-discovery) below.

- **Task & Activity Management:** Manage tasks, track activities linked with tasks including time tracking.

- **Contacts:** Keep the people behind your job hunt — recruiters, hiring managers, interviewers, referrers and references — with how you know them and when you last spoke. Link a contact to any number of jobs with a role on each link, so the same recruiter can sit on three applications, and filter by role to find your references in one click.

- **Company Pages:** Every company gets a details page with its jobs, the people who work there or worked with you there, and links to its website, careers page and job board. Watch a company to put it on your watchlist; watched companies with a job board appear in their own Watched group when you pick companies for an automation.

- **Question Bank:** Build a library of interview questions with your answers, tagged by skill, so your preparation is in one place when the next interview comes up.

- **Data Backup & Restore:** Download every job, resume, task, activity, contact and question — plus your uploaded resume files — as one zip from **Settings > Data**, and import it back on any Vocatrya instance. Backups never contain API keys, MCP tokens or passwords, and every import first saves a snapshot so you can undo it.

- **AI Assistant:** A chat panel that stays docked beside whatever page you're on. Ask it to review a resume, score how well it matches the job you're viewing, write a tailored cover letter, or add a job straight from a posting you paste in — it asks for your confirmation before saving anything. See [Features in Detail](#ai-assistant-in-app-chat) below.

- **AI Agent Integration (MCP):** Connect AI agents like Claude Desktop via a built-in MCP server to add job applications and Question Bank entries directly from your chat, with your approval. When a job description is substantial enough, the agent can also analyze it against your default resume and save a job match score right from the chat.

### Quick Start

For the Windows desktop source build and acceptance flow, see [Desktop Development & E2E](desktop/E2E.md). The steps below are for the **web-compatible run** (development only).

```sh
git clone https://github.com/Shushushu-coder/vocatrya.git
cd vocatrya
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

Open [http://localhost:3737](http://localhost:3737) and create your account. API keys for AI providers can be configured in **Settings** after signing in. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup.

#### Configuration (Optional)

Environment variables can be set in `.env` (see `.env.example`):

| Variable | Description |
|---|---|
| `TZ` | Your timezone (e.g. `America/Edmonton`). **Set this on remote servers** to avoid activity time shifts. |
| `AUTH_SECRET` | Required for web runs. Generate with `openssl rand -base64 32`. |
| `ENCRYPTION_KEY` | Encrypts the API keys you save in Settings. **Set your own** (`openssl rand -base64 32`) before adding any keys, and never change it afterwards — a new value makes every stored API key unrecoverable. |
| `NEXTAUTH_URL` | The address you open Vocatrya at. Defaults to `http://localhost:3737`. |
| `MCP_ENABLED` | Set to `false` to turn off the [MCP server](#mcp-server-ai-agent-integration). |

### Features in Detail

#### AI Assistant (In-App Chat)

All of Vocatrya's AI features live in one place: a chat panel that docks to the side of the app instead of taking it over, so the page you were on stays visible and usable while the assistant works.

Open it from the **AI Assistant** button in the header, or let the app open it for you — the **Review** button on a resume and the **Match with AI** and **Cover Letter** buttons on a job all start the matching request in the panel.

What you can ask for:

- **Resume review** — a full review of any of your resumes, with scores and written feedback, saved to the resume so you can come back to it.
- **Job match** — how well one of your resumes fits the job you're currently viewing, with a match score, a recommendation, and a write-up, saved to the job. Open the job first; the assistant scores the job on the page.
- **Cover letter** — a tailored letter for the job you're viewing, written from your resume and the job description (and any guidance from an earlier match), saved to your documents. Ask again and you get a new letter rather than losing the old one.
- **Add a job from a posting** — paste a job posting into the chat and ask it to add the job. It picks out the company, title, location, salary, tags and the rest, and shows you all of it on a confirmation card before anything is written. The description is saved exactly as you pasted it, not as a summary. Nothing reaches your database until you press Confirm.

The reviews, matches and letters are the same analyses the dedicated panels used to produce — the chat is a new way in, not a lighter-weight version.

The assistant is deliberately narrow about what it can see: it reads your resumes and the single job you're looking at, and nothing else. It can't list or search your jobs, and it can't see tasks or activities. Pasted postings are also treated as untrusted text, so instructions hidden inside a posting can't make the assistant act on your data.

Pick a model under **Settings > AI Settings** before using the panel — it needs one that supports tool calling, and it will tell you rather than guessing if none is set. See [known-good models](#supported-ai-model-providers) for the ones that have been tested, including a fully local option.

#### PDF Resume Export

Export any resume as a professionally formatted PDF directly from the resume page. Choose between two layouts — a clean **Simple** template and a more polished **Professional** template. If a PDF attachment already exists, you'll be prompted to replace it or keep the download only.

#### Resume Import

Import an existing resume from a PDF or Word (.docx) file. AI extracts structured data — contact info, summary, skills, work experience, education, and certifications — and presents each section as a review card. You can accept or skip individual sections before saving them to your resume.

#### Automated Job Discovery

Set up automations that search for new jobs on a schedule and AI-match them against your resume, so relevant openings come to you.

- **Greenhouse** — track specific companies by name from a built-in directory (or by pasting a board URL). Each run pulls every published role from those companies' Greenhouse boards, ranks them against your target titles, skills, and resume with a fast local relevance score, and runs the AI match on only the top candidates to keep costs bounded. No API key required.

- **Lever** — same company-tracking workflow as Greenhouse, backed by a built-in directory of 1,160+ companies (or paste a board URL). Automatically resolves the right regional API (`lever.co` or `eu.lever.co`) per company and carries full remote/hybrid/onsite signal from the listing. No API key required.

- **Ashby** — same company-tracking workflow, backed by a built-in directory of 1,860+ companies (or paste a board URL). No API key required.

More job board sources are on the way. Discovered jobs are surfaced for review — accept the ones you like to promote them into your job tracker, or dismiss the rest.

#### MCP Server (AI Agent Integration)

Vocatrya exposes an MCP server so AI agents (Claude Desktop, Hermes, OpenClaw, etc.) can add job applications and Question Bank entries directly, with your approval.

##### Use Case

Browsing a job posting or reading an interview question elsewhere and don't want to break your flow to log it manually? Just ask your connected AI agent, for example:

- *"Add this job to Vocatrya (copy/paste the complete job details or try providing a link): Senior Backend Engineer at Acme Corp, JobType, location, Job description... "*
- *"I just got asked this in an interview — add it to my Question Bank: 'How would you design a rate limiter?' with my answer: ..."*

The agent resolves or creates the company, title, location, and tags by name, and reports back what it matched versus created — so your data stays de-duplicated without you having to switch to the app.

When you add a job with a substantial description and you've set a **default resume** (Profile), the agent also analyzes the fit against that resume and saves a job match score — no round trip to the app needed. The result shows up on the job just like an in-app AI match, scores, recommendation, and write-up included.

##### 1. Generate a token

1. Sign in to Vocatrya and go to **Settings > MCP Access**.
2. Click **Generate**, give it a name (e.g. the client you'll connect, like "Claude Desktop"), and pick an expiry.
3. Copy the token and config snippets shown — the full token is only displayed once.

##### 2. Add it to your MCP client

<details>
<summary><strong>Claude Desktop</strong></summary>

1. Open Claude Desktop → **Settings > Developer > Edit Config**. This opens `claude_desktop_config.json` in your default editor.
2. Paste the "Claude Desktop (via mcp-remote)" snippet from the reveal dialog into `mcpServers`, e.g.:

```json
{
  "mcpServers": {
    "vocatrya": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://<your-vocatrya-url>/api/mcp",
        "--header",
        "Authorization: Bearer <your-token>"
      ]
    }
  }
}
```

3. Save and fully restart Claude Desktop (quit, not just close the window).

> **Note:** Claude Desktop only supports local (stdio) MCP servers directly, so `mcp-remote` is required as a bridge to Vocatrya's remote endpoint.

</details>

<details>
<summary><strong>Other clients (OpenClaw, Hermes, etc.)</strong></summary>

Clients that support `streamable-http` natively can connect directly without `mcp-remote`:

```json
{
  "mcpServers": {
    "vocatrya": {
      "type": "streamable-http",
      "url": "http://<your-vocatrya-url>/api/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

</details>

> **Self-hosting on a home network?** If your Vocatrya URL is a plain `http://` LAN address (not `localhost` or HTTPS), add `--allow-http` to the `mcp-remote` args — it refuses non-HTTPS URLs by default. The Settings page adds this flag automatically when it detects a non-localhost HTTP URL.

### Development Notes

- **Desktop from source:** after installing dependencies on Windows, follow [Desktop Development & E2E](desktop/E2E.md) to set up an isolated data directory in a separate worktree, build, and launch the dev desktop shell. This is the source-development path — it does not install or publish the app.
- **Test entry points:** `npm run test:e2e:desktop` drives a real Electron window; `npm run test:e2e:web` only exercises the browser pages. New desktop users run in fresh-native mode; legacy entry points used by automated sweeps are not part of that mode. In the desktop shell, create/upload actions live in the top title bar.

### Contributing

We welcome contributions! Please read our [Contributing Guidelines](./CONTRIBUTING.md) to get started. This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) — by participating, you agree to uphold its standards.

#### Credits & Upstream

- **Base Project:** [JobSync](https://github.com/Gsync/jobsync) — created by [Gsync](https://github.com/Gsync) (MIT License, Copyright © 2024 gsync)
- <a href="https://github.com/facebook/react">React</a>
- <a href="https://github.com/vercel/next.js">Next</a>
- <a href="https://github.com/shadcn-ui/ui">Shadcn</a>
- <a href="https://github.com/prisma/prisma">Prisma</a>
- <a href="https://github.com/tailwindlabs/tailwindcss">Tailwind</a>
- <a href="https://github.com/ueberdosis/tiptap">Tiptap</a>
- <a href="https://github.com/plouc/nivo">Nivo</a>
- <a href="https://github.com/sqlite/sqlite">Sqlite</a>
- <a href="https://github.com/vercel/ai">Vercel AI-SDK</a>
- <a href="https://github.com/ollama/ollama">Ollama</a>

#### Supported AI Model Providers

API keys for all cloud providers can be configured in **Settings > AI Settings** after signing in. Ollama is selected as the default provider.

> **Note:** Selected models must support **structured output** and **tool calling** for AI features to work correctly — the AI Assistant panel works by calling tools, so a model without tool support will reply with text instead of doing anything.

**Known-good models.** The AI Assistant has been tested end to end with `qwen3.5:9b` on Ollama (fully local), `deepseek-v4-flash`, and OpenAI `gpt-4.1`. Other tool-calling models should work, but these are the ones exercised against the full set of assistant features.

<details>
<summary><strong>Ollama (Local)</strong></summary>

Works with [Ollama](https://ollama.com) to run AI models locally on your machine.

- Make sure Ollama is installed and running on the same system
- AI settings will show a list of available models based on what you have downloaded in Ollama
- **Recommended:** Increase the Ollama context length from the default 4k to 16k — this helps automated job matching avoid truncating longer resume/job description prompts. The AI Assistant, resume review, job match and cover letter features aren't affected: they ask Ollama for the context size they need on every call, so raising this setting won't change them. Don't raise it much further either — a very large default costs you noticeably slower responses for no benefit
- No API key required — runs entirely on your hardware
- If you are running Vocatrya on a homelab server, you can expose ollama to network from Ollama settings on your local machine. Also make sure your ollama base url is pointed to your local system IP under API keys section of settings.

</details>

<details>
<summary><strong>OpenAI</strong></summary>

- Get your API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Add your API key in **Settings > AI Settings**
- Select **OpenAI** as the provider and choose your preferred model
- Available models are fetched dynamically from the OpenAI API

</details>

<details>
<summary><strong>DeepSeek</strong></summary>

- Get your API key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
- Add your API key in **Settings > AI Settings**
- Select **DeepSeek** as the provider and choose your preferred model

</details>

<details>
<summary><strong>Google Gemini</strong></summary>

- Get your API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Add your API key in **Settings > AI Settings**
- Select **Gemini** as the provider and choose your preferred model

</details>

<details>
<summary><strong>OpenRouter</strong></summary>

Access a wide range of AI models from multiple providers through a single API.

- Get your API key at [openrouter.ai/keys](https://openrouter.ai/keys)
- Add your API key in **Settings > AI Settings**
- Select **OpenRouter** as the provider and choose from available models

</details>

#### Note

- If you are updating from an old version and already logged in, please try logging out and login again.

### Support the Project

If Vocatrya has been helpful in your job search, consider giving it a star on GitHub! It helps others discover the project and motivates continued development.

Every star means a lot — thank you for your support!
