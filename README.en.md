<p align="center">
  <img src="./public/images/vocatrya-app-icon.svg" alt="Vocatrya logo" width="96">
</p>

<h1 align="center">Vocatrya</h1>

<p align="center">
  <strong>A local-first career and job-search manager for Windows desktop, built for the Chinese job market</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Shushushu-coder/vocatrya" alt="License"></a>
  <a href="https://github.com/Shushushu-coder/vocatrya/stargazers"><img src="https://img.shields.io/github/stars/Shushushu-coder/vocatrya?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="./README.md">中文</a> · English
</p>

---

Vocatrya is a free, open-source career and job-search manager for the Chinese job market, delivered primarily as a **Windows Electron desktop app**. It connects career materials, resume versions, opportunities, applications, and interviews around a Prepare → Act → Reflect journey.

Business data lives in local SQLite and file directories. External AI services and extensions receive relevant inputs; local-first does not mean offline AI. Next.js supplies the internal UI and local backend; browser access supports development and compatibility checks.

### Current Desktop Features

- **Career materials and resumes:** Organize career evidence, import resumes, combine materials in the library and editor with live preview, drag to reorder or hide content, create role-specific versions, and export PDF or editable DOCX files.
- **Jobs and applications:** Track opportunities and individual applications separately, preserve the submitted resume version and historical application facts, and link companies, contacts, interview rounds, and debriefs.
- **Interviews and reflection:** Manage questions, rounds, and real interview debriefs alongside target jobs.
- **Overview and next steps:** See job, application, interview, and offer statistics. Rule-based next steps use existing business data without automatically calling AI or executing tasks.
- **Tasks:** Manage tasks, categories, and due dates.
- **Three AI assistants:** Voca Insight (job-search analyst), Voca Pilot (general assistant), and Voca Reflect (reflection coach) help analyze your search, answer everyday questions, and reflect on your experience. Choosing a suggestion does not send a message. Tools vary by role, connection, and runtime mode.
- **Archive and backup:** Keep archived jobs and AI conversations long term and restore them at any time. Export and import business backups in Settings; connection credentials are excluded, so reconnect services after restoring.

Settings also cover language, appearance, display timezone, and desktop tray behavior. Sensitive career information such as identity documents and references receives separate protection and is not sent to AI by default.

The app is in RC iteration; some incremental features still require desktop acceptance. See [release notes](release-notes/) for version changes.

### AI Connections and Models

Connect AI through a supported official account runtime or bring your own model API (BYOK). Available models and capabilities depend on connection status, runtime version, and account permissions. BYOK credentials and charges are managed between you and your provider. The Vocatrya-managed API is coming soon.

After adding a connection, assign default or purpose-specific models from its actual catalog. Streaming, structured output, and tool requirements vary by purpose; a brand or fixed model list does not establish support for every capability.

Vocatrya orchestrates business tools for ordinary chat. Codex native sessions are a separate, explicitly selected mode with compatibility and capability gates. Account login does not automatically inherit search, tools, MCP, or Skills from an official client.

Write approval depends on the tool, permission mode, and operation; check application records and execution receipts for results. Switching roles does not automatically send messages or execute suggestions.

### Extensions and Current Boundaries

- **Notion:** Connection and controlled read/write implementations exist; some error and credential boundaries still require acceptance. Operations depend on connection authorization, assistant role, and approval rules.
- **Companion application-form tools:** Browser extension and profile pairing/sync implementations are partial, with further work currently paused. Filling a form is not a submitted application; users perform the final submission.
- **Web interview practice:** The standalone entry moves to a web tool whose destination service is not yet connected. This does not remove job-linked interview rounds, questions, or real interview debriefs.
- **Webpage reading:** Limited to URLs explicitly supplied in the conversation; it is not autonomous search or browser control.

### Desktop Use and Source Development

See [Desktop Development & E2E](desktop/E2E.md) for source builds, isolated data directories, and launch instructions. Use a separate worktree and fresh data for development tests without copying real configuration or user databases.

Browser access is for Next.js page development and compatibility checks; see [CONTRIBUTING.md](CONTRIBUTING.md) for configuration. `npm run dev` does not start Electron. `npm run test:e2e:web` covers browsers, while `npm run test:e2e:desktop` drives Windows Electron. Check the desktop guide for prerequisites and test scope before running.

### Contributing and Support

Read the [Contributing Guidelines](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md). Issues and improvements are welcome, as are stars on [GitHub](https://github.com/Shushushu-coder/vocatrya).

Thanks to upstream JobSync and open-source projects including React, Next.js, Prisma, Electron, Tailwind CSS, shadcn/ui, Tiptap, Nivo, and the Vercel AI SDK.

> **Upstream attribution:** Vocatrya derives from [JobSync](https://github.com/Gsync/jobsync) by [Gsync](https://github.com/Gsync), under MIT. The original copyright notice and license remain in [LICENSE](LICENSE).
