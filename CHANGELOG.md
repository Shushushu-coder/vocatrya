# Changelog

## [1.2.3](https://github.com/Shushushu-coder/vocatrya/compare/v1.2.0-beta.1...v1.2.3) (2026-11-23)


### Features

* replace Devin version-string gates with per-version capability cache
* make the dictation service Gemini-only (N-2)
* remove the legacy interview AI settings panel (N-1)
* show startup splash while backend initializes
* save resume evidence drafts to career profile
* merge condition-type error notices in a top-left host
* D4 card E task card and job entry
* D4 card C cold start, grounding and task session
* D4 card B handoff notes and context budget row
* read_webpage tool for user-supplied URLs (read-only)
* D4 card A task ledger (AgentTask/Handoff/Event)
* three-tab extensions page with built-in skills and coming-soon import
* discover all Codex installs and select per purpose
* host resume evidence skill in Pilot (draft-only)
* verify Codex CLI 0.170.0 for native sessions
* gate Codex native sessions on a verified-version list
* NOTION_OBJECT_NOT_FOUND and Retry-After for rate limits
* resume evidence skill v1 (draft-only, not yet hosted)
* route prep-continue to extensions entry in desktop shell
* show curated bilingual release notes above About
* move Codex native entry into the model chip and dedupe connect buttons
* add unverified Antigravity account login
* whole-window zoom with rebindable zoom shortcuts
* edit page text directly and confirm page deletes once
* report native session failures and apply Codex CLI updates
* single roster source for role guidance and refusal prompts
* add persistent Codex native text conversations
* split AI services into account and managed tabs
* add agent preferences and chat history maintenance
* graphite dark mode palette
* compact service list for unconnected AI services
* reorderable business grid in AI assignments
* add move-to-new-computer migration guide to Data & Privacy
* sync build facts to About and converge version residues (UI-RC-ABOUT D5)
* mount dictation button in unified composer toolbar
* AWU slice C — API dictation (AWU-DICTATION)
* force-disconnect escape hatch for unreachable app origin
* AWU slice B — local files into the conversation
* AWU slice A — unified composer with toolbar model/context controls
* resolve About version from the running app version
* pair autofill plugin with local career profiles
* persist custom ordering and pinned jobs
* move task and question filters into content
* refine career journey overview
* move resume navigation and show nickname avatars
* integrate extension tools, autofill export and Notion connection
* multi-agent roles for the agent panel (Insight/Pilot/Reflect)
* wire R6 next-action and M9 insight to awaiting-reflection read model
* integrate job-connections i18n keys and feature status
* archived-job read-only reflection entry + delete cascade warning
* integrate interview-debrief i18n keys and feature status
* wire P-A reflection completion, source links, read model and UI
* job connections aggregation view (JOB-CONNECTIONS)
* checkpoint schema and DTO groundwork for P-A
* integrate overview/insights i18n and account-zone applied7d
* implement journey overview and next-actions rules
* implement career insights metrics contract (M1-M8, G1/G6)
* add offline Chinese font fallback
* unify brand marks and company logo fallbacks
* restore jobs and conversations with AI isolation
* complete isolated managed execution and entitlement checks
* add modular resume builder and editable DOCX export
* finalize resume import selection and P1 closure
* retire activity tracking and preserve task categories
* regenerate completed answers with durable write guards
* add independent copy actions for agent fenced code blocks
* integrate input preferences, answer copying and runtime update checks
* persist user time zone with safe preference saves
* autosave career material fields and retain tab drafts
* add process event table and quick scheduling actions
* add profile group and selected application summary copying
* integrate career tabs, user-facing messages and inline data creation
* add additive schema columns and backup v4
* add DateTime v1 foundation
* complete desktop lifecycle v1
* persist general language preference
* add locale persistence action
* add atomic user settings patch
* integrate wave 1 batch A
* adaptive overview for provably empty accounts (Dashboard V2.1)
* move global actions into the desktop titlebar
* split home into overview and analytics board (Dashboard V2)
* share one write-before-guard database isolation contract
* explicit ApplicationAttempt picker for new process steps
* Windows desktop lifecycle — tray, close-to-tray, login items, minimized launch
* add salary column to jobs CSV export
* bind process steps to an explicit ApplicationAttempt
* unify list states and family-aware tag counts
* refine workspace shell and navigation
* show Coming Soon and make no Hosted request while Managed AI is not launched
* integrate streaming usage settlement
* add operator console and audited controls
* add three-route AI settings with OS-backed credential store
* wire managed business execution with durable invocation identity
* add managed usage authority
* add managed hosted runtime
* add managed AI core contracts
* add canonical resume import
* add canonical job creation tool
* clean up fresh-native full surfaces
* enable fresh-native runtime defaults
* auto-activate fresh-native databases
* export immutable variants to stored PDFs
* reuse Codex app-server runtime
* add async career dialogue memory
* bound career dialogue context
* add fast path for simple career dialogue
* integrate A1.5 identity and agent presence
* redesign career assistant workspace
* add multi-conversation chat persistence
* enable verified Codex streaming
* productize AI interview flow

### Bug Fixes

* apply resume migration fixtures on a dedicated SQLite connection
* prevent Prisma SQLite worker starvation during release tests
* allow bounded SQLite lock waits in concurrent handoff verification
* verify Windows releases on the target operating system
* make release verification portable across CI hosts
* allow release typecheck an 8 GiB Node heap
* wire OAuth recovery URLs through connection service dependencies
* show a light logo on the light startup screen
* wait for replacement navigation to finish during startup
* restore resume evidence draft generation and repair feedback
* verify source revision when building isolated snapshots
* retain authorization recovery during account reconnect
* expire abandoned authorization flows without clearing newer logins
* rename logo asset to bust image cache
* use approved app icon as logo
* wait for complete Codex authorization URL
* surface Codex authorization URL as login recovery entry
* specify evidence draft fields and return validation feedback
* retain canonical match approval in every permission mode
* keep passive Antigravity auth checks noninteractive
* repair agy 1.5.14 exec surface and verify real login E2E
* correct Codex binary verification, task selection persistence, and Notion receipt display
* verify Antigravity/Grok logins via ACP probe on drifted versions
* add Antigravity icon for AI connection card
* keep the full Codex model catalog
* batch Notion page deletes and accept Devin 3000.14.30821 streaming
* verify checkout revision before snapshotting
* regenerate stopped turns from persisted user tail
* include release-notes in the source snapshot
* allow regenerate right after a stopped turn
* resolve ?tab= outside the client module
* re-arm OAuth callback expiry when a restarted flow reuses the listener
* scope choice options to the field's own popup
* repo audit — timeline draft remount, lint scope, stale tests
* restore typecheck after update/delete page tools
* carry attachments and context on suggest_role transfer
* align Pilot limitations and capability counts with handoff contract
* keep turns running on panel close, auto-replay CAS conflicts, add suggest_role handoff
* stop AI assignment settings from waiting on runtime probes
* prevent duplicate interview feedback generation
* acceptance defects for agent preferences
* scope new repeat blocks and record verified extension paths
* correct ATS repeat matching and restore sync controls
* verify ATS control commits and prevent submit actions
* stabilize desktop audio transcription
* tighten migration-guide copy after review
* harden AI assignments, split services columns, isolate Notion OAuth result, atomic panel expand
* bind autofill repeat blocks to nth profile item
* dedupe autofill field ids and count real filled elements
* remove reminder click navigation and close revised acceptance
* separate managed credential and Hosted deadlines and harden acceptance evidence
* preserve hosted credentials and await desktop process-tree cleanup
* clarify managed AI errors and preserve sessions on broker failures
* keep explicit context clears across desktop restarts
* isolate hosted sessions under development data roots
* preserve unresolved draft context across role snapshots
* distinguish malformed and rejected access keys
* isolate role transitions and preserve active drafts
* prevent narrow company table headers from wrapping
* improve title leading and table readability
* reject archived interview reflection sources before dispatch
* Fix strict match screening schema and record account acceptance
* Fix resume builder editing, lifecycle and durable preview preferences
* Fix restored conversation references and preserve archive isolation
* accept empty runtime streams for DOCX export
* isolate BYOK credentials and classify execution deadlines
* move help and feedback above navigation
* remove global upload entry and import deep links
* simplify editing controls and use copy icons
* persist input preferences across backend port changes
* hydrate input preferences safely and restore evidence field navigation
* improve desktop entry points and AI chat configuration
* Fix material test narrowing and reuse task date boundaries per query
* retain emergency contact drafts on rejected saves
* preserve creation drafts on failure
* clean replaced backup rows and preserve sensitive rollback data
* localize career job access errors and cover acceptance paths
* preserve emergency contact values during editing
* include read-only records in tab copy and record integration status
* gate titlebar action portals on the real Electron shell
* grant the linked-worktree exemption only on two-way git registration
* protect primary checkout prisma in process db isolation
* harden process database isolation
* clean owned job opportunities before library rows
* make draft attempt step creation atomic
* release main-window IPC when the window closes before first load
* make draft applied switch reversible, plain salary input, localized sources
* stabilize AddJob and AddEducation suites
* close R4 integration verification gaps
* invalidate stale job-list responses by committed query generation
* align migration tests with Node 24
* degrade blocked jobs reads explicitly
* adapt settings layout to narrow containers
* unify applied facts across R1 R2 modules
* align dictionary statistics with AB read family
* align application facts and first submission dates
* stop persisting TBD placeholder for empty answers
* align company statistics with AB read family
* unify dialog overlays and reflection layout
* fail safely instead of hanging silent installs on old-uninstaller errors
* preserve the secret store when Windows rename returns EXDEV
* revise beta2 hosted endpoint
* preserve resume invocation identity on ambiguous failure
* support OpenRouter interview model input
* restore codex persistent pool consumption
* harden conversation concurrency
* harden resume and application history
* stabilize codex structured execution
* support Chinese text validation
* settle nested generation streams
* preserve explicit docker runtime overrides
* align career reads with canonical runtime data
* close legacy write guard gaps
* preserve dialog after list refresh
* classify derived conversation summary cache
* align Codex runtime network environment
* certify Codex 0.160.0 runtime capabilities
* support A+B job context in assistant
* refresh my jobs after add
* polish add job modal and locale labels
* integrate missing product acceptance fixes
* restore deterministic test user setup
* restore assistant panel fixed positioning
* keep assistant chat transport off the server module graph
* rollback failed assistant conversation creation
* stabilize my jobs state and ui

### Other Changes

* prepare bilingual release notes for 1.2.3
* improve README readability and align AI naming with product
* fix Pilot role bold formatting in Chinese README
* rewrite README journey and add desktop screenshots
* share the next-auth and server-only mocks
* type the pending reconnect response
* separate and refine bilingual readmes
* align README with current desktop product
* drop Ollama provider references
* point header logo at renamed icon asset
* bilingual rewrite with logo header
* unpublish internal agent docs and legacy screenshots
* record core acceptance evidence and remaining blockers
* ignore root-level scratch exports
* record RC task integration and pending desktop acceptance
* cover batch proposals cancellation and uncertain receipts
* align microphone comments with Gemini-only service
* drop the interview AI settings panel spec (N-1)
* require asking user which AI account to use before real model calls in acceptance
* record 2026-11-20 desktop acceptance results and Feishu MCP proposal
* record stopped-turn fix integration and pending acceptance
* freeze 1.2.3-rc and record pre-acceptance results
* mark 1.2.3-rc additions integrated and scope F2/F3 checks
* record D4 integration and extend 1.2.3-rc acceptance scope
* restore AWU ledger formatting, keep only cleared dictation questions
* record task UI, interaction and resume-evidence save decisions
* add merged extensions tabs and read_webpage to 1.2.3-rc checklist
* add consolidated 1.2.3-rc desktop acceptance checklist
* record user Notion acceptance on 1.2.2-rc (a43a25b0)
* record 2026-11-19 extension decisions and refresh stale status
* record per-purpose Codex install selection
* resume evidence hosted by Pilot, auto-apply evidence lost, Codex 0.170.0 verified
* tracked backup-excludes-binding scenario for Codex native backup
* record D3 autoroute and D4 long-task decisions, S1-S4 outcomes
* assert backup export excludes native binding and executionPath
* exclude .claude/ agent worktrees from vitest and eslint
* mark native-session and resume-evidence contracts approved in index
* replace hand-picked waves with cutoff-based migration replay
* retire upstream Docker/web-deploy chain and stale artifacts
* bump version to 1.2.3-rc (in progress, not released)
* draft 1.2.3-rc notes (not released yet)
* drop dead interruptedTurn field
* constrain RC acceptance evidence, record carry-on-transfer and 1.2.3-rc revalidation
* record suggest_role handoff landing, auto-route upgrade, chat regression fixes
* extend codegraph rule with worktree index sync
* add release runbook and point agents at it
* mark stale-test fixes as landed in a8c358db
* refresh stale assertions for resume bridge and audio page
* record interview feedback fix integration and verification
* clarify acceptance evidence and remaining verification gaps
* record current-version managed desktop reverify and native evidence check
* set managed assignment inside lifecycle case setup
* adapt desktop driver to tabbed AI services and authoritative denial code
* honest no-fallback evidence and exit code for desktop reverify
* propose scoped native session adapter contract
* define resume evidence draft contract
* record ATS fixes and bounded browser verification
* record integrated AI service tabs and verification
* record agent harness and extension UI decisions
* record SET-DESKTOP real Windows auto-start acceptance
* Record harness integration and qualified acceptance evidence
* Keep preparation sessions accessible in desktop and fix snapshot inputs
* Persist Notion approvals and recover detached write execution
* Add interview prep goals with session binding, handoff and backup support
* Add recoverable deep-match tasks and job matching UI
* add multi-agent onboarding proposal with frozen decisions
* prepare 1.2.1-rc
* record EXT-NOTION acceptance plan and environment pre-checks
* record Xiaohongshu Chinese ATS autofill field test
* record S13 force-disconnect integration
* record AWU B/C integration, autofill polish and slice A acceptance
* record AWU slice A integration and autofill acceptances
* repoint wiki evidence paths to retained worktree closure dirs
* close P2 acceptance and record About version integration
* extend p2 closure driver with continuation and restore coverage
* record RC acceptance and autofill connection integration
* prepare workspace upgrade decisions
* record 1.2.0-rc UI adjustment decisions
* record agent workspace upgrade proposal
* record partial task C acceptance and remaining coverage
* define reusable desktop validation and targeted retry rules
* record extension tools decisions and update wiki index
* correct desktop acceptance drivers and record Main failures
* record acceptance preparation and remaining coverage
* add managed AI loopback and desktop acceptance tools
* add reproducible P2 desktop acceptance preparation
* record P2/REM-V1 acceptance results, flip three P2 features to passes
* test+docs: align fresh-full specs with shipped surfaces, record P2/D acceptance
* isolate desktop visual launch builds
* record R6/M9 awaiting-reflection wiring in feature ledger
* record insights and overview-actions integration
* record brand batch1 acceptance
* reconcile frozen-contract status markers across wiki
* freeze four P2 contract proposals after owner decision
* preserve acceptance evidence references after worktree cleanup
* preserve superseded p2-overview-contract worktree snapshot
* preserve superseded p2-job-interview-contract worktree snapshot
* preserve superseded p2-multi-agent-contract worktree snapshot
* preserve superseded resume-preview-persistence-fix worktree snapshot
* preserve superseded mvp-integrate-124 worktree snapshot
* preserve superseded account-match-schema-fix worktree snapshot
* propose career insights metrics contract
* reconcile journey, debrief and agent contract proposals
* Record acceptance evidence and troubleshooting rules in AGENTS.md
* Remove the About & Help support surface from the main shell
* Add managed subscription recharge page and loopback operator channel
* Record canonical match_job Electron acceptance for AGENT-CAPABILITIES
* Record P1 match_job implementation and P2 contract proposals
* Implement canonical match_job with durable tool execution
* Revise P2 overview and next-actions contract proposal
* Add P2 job-interview joint contract proposal
* Record approved match job decisions without enabling implementation
* Commit pending runtime update check work
* Add P2 overview actions contract proposal
* Commit pending archive contract proposal changes
* Commit pending resume import selection work
* Commit pending desktop E2E harness docs
* Commit pending W7 resume acceptance test
* Commit pending input preferences work
* Commit pending desktop E2E harness docs
* Commit pending agent answer copy work
* Commit pending emergency edit tab persistence test
* Commit pending desktop E2E workflow and docs
* close P1 BYOK acceptance
* Update P1 integration and acceptance status
* Document canonical match_job contract
* Harden BYOK provider verification
* Record AI closure integration and remaining acceptance boundaries
* Keep managed session status accurate during failures and concurrent redemption
* Preserve BYOK reauthentication state and actionable credential errors
* Transport account AI prompts outside Windows command lines
* Document P2 career journey product baseline and feature ledger
* Add hosted session redemption and reliable managed AI disconnect
* close integration checks and synchronize feature status
* freeze archive policy and resume builder scope
* clarify validation window ownership
* record P1 integration and pending acceptance
* define resume workbench contract and approved product choices
* separate MVP status and updated P1 delivery contracts
* record targeted Electron acceptance and remaining manual checks
* split task dispatch guide into on-demand AGENTS_PROMPTS.md
* Enable MATCH_ANALYSIS assignment on fresh-native and mark REM-V1/RM-MATCH implemented
* Add settings About page with version, environment and diagnostics copy
* Add fresh-native fast screening match entry, execution and history
* Add AI reflection draft generation and CAREER_REFLECTION assignment
* Add audio input settings with mic selection, level meter and record test
* Add rebindable window shortcuts and global show/hide hotkey
* Add persistent reminders with Windows notification delivery and preferences
* Drop titlebar brand and group navigation controls on the left
* Regroup dictionary and resume variants under Career Management settings
* Move Library dictionary management into settings under Bulk Edit
* Remove Ollama, OpenAI and Gemini BYOK options from settings
* Clarify desktop validation rules and add wiki navigation
* Constrain chat bubbles and preserve plain JD line breaks in job editors
* Certify Codex 0.164.0 streaming and structured execution after live probes
* Dismiss AI preflight errors and distinguish unavailable resume import
* Collapse question answers behind an accessible toggle
* Align job mutation surfaces with runtime policy and record compatibility acceptance
* Record serial desktop acceptance results and remaining release checks
* Show saved salary in job lists and stabilize desktop acceptance navigation
* Integrate resume service lifecycle regression and record acceptance limits
* Add isolated desktop test tooling and require explicit E2E authorization
* Preserve desktop loopback origin for dashboard sign-in redirects
* Record approved skill link contract and main integration evidence
* Verify tag deletion races and live skill copy names
* Link career skills to owned tags and preserve references in backup v6
* Record integrated job dictionary and AI settings delivery
* Refresh job edit defaults when deadline context changes
* Add dictionary maintenance and protect canonical references on rename
* Carry job deadline precision through forms exports and agent paths
* Add localized job deadline export heading
* Show unavailable AI assignment purposes honestly
* Record MVP decisions and integrated process task and career work
* Extend career records and protect sensitive attachments with backup v5
* Carry process time precision and account timezone through upcoming reminders
* Preserve task due precision and sort mixed due values before pagination
* Complete career profile field and privacy translations
* ignore Playwright CLI artifacts
* record job and backup integration verification
* propose career schema contracts and implementation ownership
* mark resume attempt binding acceptance passed
* propose datetime consumer contracts and ownership
* record material autosave and emergency editing integration
* track agent guidance and ignore temporary files
* Add independent application rounds and paged transfer selection
* Connect desktop lifecycle preferences to general settings
* Add per-field autosave for career profile personal information
* sync MVP implementation status and preserve validation guidance
* retire wiki publishing and record MVP implementation scope
* wait for durable archive writes and select the real status filter
* isolate stability checks and honor AB runtime contracts
* accept data-family edit and archive contracts
* Isolate desktop test migration runtimes and signature fixture
* give the git-registration regressions explicit timeouts
* cover the shared database isolation contract end to end
* make the cleanup rejection fixture route-agnostic
* use stable cleanup rejection fixture
* replace DATABASE_URL substring guard with isolation contract
* propagate cleanup teardown failures to test results
* stabilize shared login, combobox, and save completion fixtures
* cover application attempt selection e2e
* await saved jobs URL before filter history checks
* isolate my jobs acceptance fixtures
* align jobs csv e2e with salary export
* isolate R3 authentication and database fixtures
* ignore local .private credentials directory
* refine dashboard jobs and basic data pages
* establish shared visual and interaction foundation
* derive packaged migration counts from names and pin the beta.1 baseline
* add beta2 managed endpoint revision report
* prepare 1.2.0-beta.2
* restore managed runtime regressions
* fix Prisma migration fixture bootstrap
* stabilize parallel Prisma fixtures
* align create job mock contract
* simplify compatibility facades
* isolate local and desktop Vitest discovery
* remove unused Radix progress dependency
* remove proven-dead source
* reduce packaged Prisma runtime
* align beta acceptance expectations
* harden t2 acceptance harness
* add manual migration verification
* align acceptance checks with current UI
* align activity delete confirmation assertion
* refine A1.5 app icon container
* align Add Job locale acceptance with A+B capabilities
* align My Jobs acceptance fixture with read family
* type the seeded transcript assertion
* cover restoring a prior assistant conversation


> 1.2 起的版本（含 RC）以 [`release-notes/`](release-notes/) 双语摘要为准；本文件仅由正式版 release.yml 自动追加，以下 1.1.x 及更早条目继承自上游 JobSync。

## [1.1.20](https://github.com/Gsync/jobsync/compare/v1.1.19...v1.1.20) (2026-09-14)


### Features

* add validation for last-contacted date and update documentation
* link company details from the Library table and job header; add the companies help page
* add the company Contacts tab; AddContact company prefill and ContactsTable hideCompanyColumn
* add the company details page with header, summary card and Jobs tab; extract BoardCell, make the empty-state action optional and keep query params in useTabQueryParam
* add getCompanyDetails and share the contact include and score helper
* hide match score for unanalyzed jobs and update related components
* add a Companies contacts count, contact-aware delete guards and the contacts help page
* add job-contact link actions and the job-details Contacts tab
* add the standing contact role, the Contacts Library tab and the Add Contact form
* add contact CRUD actions, the role-filtered list query and the contact form schema
* add contact-role actions, the Library Roles tab and two creatable ComboBox cases
* reshape the Contact model, add ContactRole and JobContact, and seed default roles
* tag discovered jobs with the resume skills their posting mentions, and raise the wiki section word cap
* add a Match button to unscored jobs, show the company logo on job details
* add the watched-boards group and batch add to the wizard picker, plus its spec and wiki entries
* add watchlist and board-browse scopes to the Companies tab
* add website, careers and industry fields and scope the delete guard by owner
* add reference-list filter/sort params and a watchlist scope to getCompanyList
* add the watch server actions, barrel re-exports and their spec

### Bug Fixes

* upgrade next and eslint-config-next to 15.5.25
* download attached resume files under their original upload name
* confine resume file paths; move file uploads out of server actions; guard backup export/import and resume import sinks
* check ownership of job and contact reference ids; download resume files by resume id
* update bullet character in style sets to ensure consistency across components
* clear end date when switching job status to current
* always show the recent-activity start button and shrink the agent chat composer
* gate the Match and Cover Letter actions on chat busy, and reload the jobs list when a match score lands
* match locations on whole terms so "US" stops matching "Australia"
* make the match threshold a save gate, add a minimum prerank score, and update the wizard copy, wiki and specs

### Other Changes

* update features section
* add link to resume in JobSummaryCard component
* add Activities and Tasks documentation
* update backup functionality to include contact roles and references
* update e2e tests for company management
* add e2e tests for contacts
* update evals package dependencies and scripts in package.json and package-lock.json
* Add buttons to start and resume activity in BreakModal
* lazy-load the contact dialog pickers and drop the duplicate roles fetch
* split JobDetails into job-details/ with URL-backed tabs


## [1.1.19](https://github.com/Gsync/jobsync/compare/v1.1.18...v1.1.19) (2026-09-06)


### Features

* seed the Ashby company directory, resolve Ashby board tokens and offer Ashby in the wizard
* add the Ashby fetch adapter and mapper, and register Ashby across the model, schema, ATS registry and board URLs
* remove the JSearch job board and the RapidAPI provider it powered
* add Offer Accepted/Declined statuses and make the status badge a picker
* make Salary Range optional free text, surface it on job details, widen the preset bands
* cap the weekly Activities chart to top-3 + Other, matching the donut
* add the OKF help bundle, its CI guard and GitHub wiki publishing
* wire OTEL_* passthroughs into the Jenkins deploy path
* trace automation runs end to end and move server logs to log.*
* add GenAI spans at the five LLM call sites and fix float encoding
* add log records and fan automation-logger entries out to OTLP
* add zero-dependency OTLP span exporter and context propagation
* log measured prompt-prefix sizes per turn

### Bug Fixes

* focus the search input when the ATS company and targeting pickers open
* drop the Greenhouse keyword floor to 1, log true floor counts, relabel unset titles
* conditionally render caution message for editing company name
* stop the activity donut overlapping its total and flickering on panel toggle
* keep the chip-only user turn, stop swallowing stream errors, and route chat logs to OTLP
* change filter option label from "None" to "All (Except Dismissed)"

### Other Changes

* add Ashby to automated job discovery and link the help wiki
* patch the app's fast-uri, qs, xmldom and humanfs, and bump evals' brace-expansion overrides
* add the automations help page, link it from the index and drop Remote from the locations placeholder
* move the shared ranking pipeline, HTML helpers and ATS_* constants out of greenhouse/, updating components and specs
* split the detail page, wizard, ATS step, jobs list and scraper runner into modules
* add the MCP Access help page, its index entry and an "mcp" feature
* spike span parenting through the agent chat stream boundary
* replace hand-rolled auth guards with requireUser() across 12 action files


## [1.1.18](https://github.com/Gsync/jobsync/compare/v1.1.17...v1.1.18) (2026-08-23)


### Features

* implement version check and update notifications
* update JobsActivityCard to label slices directly on the chart and add arcLabelLines function
* add jobs trend calculation and minor adjustments
* merge the Jobs and Activities cards into one donut card
* add getDefaultContactInfo, the export dialog and panel, both trigger surfaces and the filename suffix
* add contact-parts helper, letter template, PDF generator and export guard
* add CoverLetterExportSettings model, storage key and buildLetterStyles
* add customizable export settings (font, size, margins, spacing) with token-based style builders
* wire the preview + settings panes into ExportPdfDialog and add a fit page/width preview control
* add PdfPreviewPane canvas renderer and ExportSettingsPanel template picker
* add useResumePdfPreview hook with debounced, cached blob generation
* add ResumeExportSettings model, canExportResume predicate, prepared-blob export path, and dev:webpack script
* restructure job actions into separate modules for better organization and maintainability refactor(activity, profile): move requireUser to shared module for reuse across action directories

### Bug Fixes

* update Jobs heading and adjust activity count assertion in tests

### Other Changes

* add GitHub Actions workflow for automated releases
* move preview pane, settings rows, preview/settings hooks and dialog shell into the shared layer
* extract shared pdfExport model, style tokens, HTML converter and download helpers
* replace direct resume ownership check with assertResumeOwnership for improved code clarity
* replace getCurrentUser with requireUser for authentication consistency across automation actions
* simplify TasksContainer by removing filter change callback; introduce TasksToolbar for enhanced UI and functionality
* JobsContainer to use custom hooks for filters and job list management; introduce JobsToolbar for improved UI organization
* split actions into separate modules for better organization and maintainability
* automation.actions, reduce file size, use barrel, make it readable
* Refactor task actions into separate modules for better organization and maintainability; add company actions for CRUD operations; implement dashboard actions for activity and job statistics; introduce shared utility functions for date handling.
* restructure actions into separate modules for better organization and maintainability
* resumeContainer file, use barrel, reduce file size, make it readable
* import actions from specific files, reduce file length, make it more readable


## [1.1.17](https://github.com/Gsync/jobsync/compare/v1.1.16...v1.1.17) (2026-08-16)


### Features

*  add Data settings panel with backup export, guarded import and snapshot rollback
*  add backup preflight, import, snapshot list and rollback routes
*  add destructive backup import with pre-import snapshot, wipe, ordered inserts and post-commit sync
*  add backup import transforms — id map, FK rewrite, path sanitization and emptiness policy
*  add backup export with ownership-scoped payload assembly and download route
*  add backup foundations — jszip, size caps, model spec table, zod schemas and capped zip reader
*  add activity break UI — banner Break button, break modal, ring timer (Phase 3)
*  add client-side activity break state to ActivityContext (Phase 2)
*  add server-side activity break lifecycle (Phase 1)
*  replace activity time inputs with a TimePicker, fix start/end validation, and add specs
*  add ExportPdfDialog component showing template previews

### Bug Fixes

*  patch npm audit vulnerabilities in root and evals lockfiles
*  add whitespace-nowrap class to table headers and cells for better layout
*  persist tasks activity filter in URL, sticky sidebar, hide empty types, portal tooltip content
*  verify the session user exists, guard backup import and sign out stale dashboard sessions
*  ensure proper handling of BACKUP_SNAPSHOT_MAX_TOTAL_BYTES in pruneSnapshots tests

### Other Changes

*  add real-database round-trip, rollback coverage and e2e for data backup; align settings card title size
* enhance activity management tests to include pause and resume functionality with breaks
*  remove release script as part of project refactoring
*  update CardTitle font size for consistency across components
*  update layout classes in Dashboard and Header for improved responsiveness
*  update CardHeader and layout classes for improved responsiveness
*  dedupe no-resumes/pick-a-resume JSX in AgentResultCard renderers


## [1.1.16](https://github.com/Gsync/jobsync/compare/v1.1.15...v1.1.16) (2026-08-09)


### Features

*  send the chat model a per-turn page-context block, extract the page vocabulary, update the eval harness and trim dashboard padding
*  drive cover letter generation from the agent chat on the job page
*  render cover letter streaming and results in the chat
*  add generate_cover_letter as a nested-generation agent chat tool
*  add cover letter tool schema, result type and nested-tool registry
*  drive job matching from the agent chat on the job page
*  render match_job streaming, results and picker in the chat
*  add match_job as a nested-generation agent chat tool
*  add match_job constants, input schema and result type
*  add ownership-scoped job lookup for the agent chat
*  update ReviewDetails to use AgentReviewScoreCard and improve layout
*  render the streaming and finished review in the transcript
*  route chat reviews through review_resume and shrink the prompt
*  add review_resume tool with a nested review generation
*  add card view toggle to the jobs page
*  add MyJobsGrid card layout for the jobs page
*  add JobCard component for the jobs card view
*  add jobs view mode type, storage key, and toggle control
*  enhance HTML entity decoding in text processing and resume conversion
*  refactor AgentChat components for improved layout and message handling
*  enhance AgentChat components with preflight status indicators and improved error messaging
*  enhance AgentChat functionality with panel expansion and sidebar integration
*  implement last-used location and source persistence in AddJob component
*  update job and question form schemas to allow default values for job description and answer
*  integrate SidebarContext into agent chat and dashboard components
*  score card and auto-save for chat resume reviews
*  read and review resumes in the agent chat
*  render assistant chat prose as markdown
*  move account menu from header into sidebar footer
*  dock agent chat panel beside page content
*  agent chat panel, trigger and transcript
*  agent chat provider and composer
*  agent chat UI foundation and tool cards
*  agent chat add_job tool and /api/ai/chat route
*  agent chat server helpers
*  agent chat foundations and model eval suite
*  add job source search functionality to job listing

### Bug Fixes

*  update @modelcontextprotocol/sdk to version 1.30.0
*  stop the add_job prompt explaining app internals, name jobDescription at the point of action, validate tool input in the evals and run them at the route's temperature
*  always carry jobDescription on add_job, end the turn only once it settles, lower the paste threshold, and correct the eval harness's tool-call shape
*  refresh the jobs list on the add_job write, and answer the add-job suggestion without a turn
*  harden the agent chat's add_job flow, jobs list and empty state
*  OpenAI models return schema error Issue #99, enhance error handling in resume import
*  hold a send while a turn is in flight instead of opening a second one
*  bound agent chat history by tokens and stub pastes client-side
*  make the agent chat safe to extend past three tools
*  harden the resume Review button's chat clear
*  enhance chat functionality to handle approval pending state in ResumeContainer
*  enable the Ollama thinking channel for the chat tool loop
*  build the MCP review directive from the shared user prompt
* fix settings layout issues when ai chat panel expanded
*  remove title from resume text conversion output
*  simplify category formatting in convertResumeToText function
* fix failing e2e tests
*  remove elapsed-time display and silence attachment img lint warnings
*  show in-panel processing feedback in agent chat
*  use theme tokens in sidebar and header utilities
*  apply the Inter font that was already being loaded
*  use v4 parenthesis syntax for CSS variable references
*  update aria-label for user menu trigger and enhance task visibility checks
*  remove unnecessary capitalization from select items and form controls

### Other Changes

*  update README to include AI Assistant features and improve job description handling
*  retire the dedicated cover letter sheet, route and stream util
*  add generate_cover_letter selection rows to the agent chat eval suite
*  extract the nested generation plumbing shared by two tools
*  add match_job selection rows to the agent chat eval suite
*  retire the dedicated job match sheet, route and stream util
*  generalize the review stream part for a second nested tool
* Update AgentChatTrigger to toggle icon based on chat state
*  remove startTime prop from ActivityBanner and use elapsedTime for display
*  retire the dedicated resume review sheet and route
*  retarget the agent-chat evals at review_resume selection
*  delete the client-side review save heuristic
*  build the chat response with createUIMessageStream
*  prove transient writes from inside a tool execute flush early
*  extract shared JobStatusBadge and JobActionsMenu from jobs table
*  eval coverage for get_resume and chat resume reviews
*  remove unused shiki/code-block/tool ai-elements scaffold
* Improve activity banner style
*  prune stale package.json overrides
*  replace utilities removed in Tailwind v4
*  rename shadow-sm to shadow-xs and rounded to rounded-sm
*  rename outline-none to outline-hidden for Tailwind v4
*  restore v3 button cursor and placeholder colour under v4
*  migrate Tailwind CSS to v4 with CSS-first config
*  migrate toast system from Radix to Sonner
* add reload button to reload job listings
* update sidebar and header links to point to the dashboard
* minor dashboard ui adjustment
* add functions for handling task descriptions and excerpts


## [1.1.15](https://github.com/Gsync/jobsync/compare/v1.1.14...v1.1.15) (2026-07-30)


### Features

*  pair name and email/phone fields on one row
*  add Jenkins pipeline for CI/CD process
*  enhance RecentCardToggle layout and increase displayed jobs/activities limit
*  add generate action to job details
*  add generation sheet
*  add client stream util
*  save generated letter and link it to the job
*  add streaming generation endpoint
*  add generation prompts
*  extract keywords and tailoring tips from match data
*  add title builder helper
*  add 'Create a copy' action to resume menu
*  add copy resume dialog
*  add copyResume server action
*  suggest a title for resume copies
*  add resume copy title helpers
*  add MCP tool-routing regression tests
*  add add_jobs_batch and save_match_results_batch tools
*  add upsert-by-URL routing to add_job
*  add find_job and update_job tools
*  add updateJobFromNames patch helper
*  label matches scored from incomplete descriptions as provisional
*  gate match directive on description completeness
*  classify and persist job description completeness
*  document job status enum in add_job tool schema
*  implement local storage for tab selection in RecentCardToggle and WeeklyBarChartToggle components
*  refactor to use year selection on activity calender
*  add Save & Start functionality and update task creation flow
*  add automation and question shortcut on dashboard
*  create a reusable QuestionTagBadge component and update usages in QuestionCard and QuestionsSidebar refactor(Sidebar): adjust sidebar layout and spacing for improved responsiveness refactor(TasksSidebar): modify layout for better alignment in task sidebar
*  add collapsible dashboard sidebar with persisted state
*  add edit and delete buttons for job management
*  implement duration guard for stopping activities and discard short ones
*  replace Load More buttons with infinite scroll
*  add backend search to Companies, Job Titles, and Skills lists
*  add review_resume + save_resume_review tools

### Bug Fixes

*  add error handling for company logo image fallback
*  improve update logic to prevent duplicate companies and handle unchanged labels
*  exclude nested node_modules from the vitest run
*  scope section writes to the owned resume
*  reconcile the per-user running activity across sessions
*  refetch tasks with group-aware ordering on group-by change
*  reduce timeout duration for AddJob component tests
*  harden cover-letter/resume-import prompts and MCP schema wording
*  pin exact JSON key names in resume-import prompt
*  move promptfoo out of root package.json into evals/
*  patch dev-scope and remaining runtime advisories via overrides
*  patch runtime-scope high advisories via overrides
*  bump next-auth to 5.0.0-beta.32 for critical advisories
*  scope ComboBox Enter-key highlight check to its own cmdk list
*  update label visibility logic for collapsed sidebar
*  smooth sidebar collapse/expand transition
*  handle Enter key for creatable combobox
* fix failings tests
*  point combined config at renamed resume-import fixture
*  enhance tag description in McpUpdateJobInputShape
*  handle keydown events with undefined key property
*  give auto-discovered "new" job status its own badge color
*  update mockUpdate function signature for consistency
*  automation schedule conflict
*  update activity-start tests for stay-on-tasks behavior

### Other Changes

* Update readme with screenshots
*  update project description, enhance feature details, and improve formatting
*  add edit coverage for contact info, summary, and education
*  cover contact info actions and form schema
*  run prompt regressions against local Ollama alongside DeepSeek
*  add cover-letter prompt regression tests
*  improve layout and styling for various components
* update button selectors for job actions and add resume skills/certifications tests
* refactor JobsAppliedCard layout for improved button display
*  update next and eslint-config-next to version 15.5.21
* Enhance various components with DialogDescription for improved user guidance and update test cases for better data handling
*  consolidate success/error toasts into shared helpers
*  update activity test to ensure short activities are discarded and not displayed
*  replace dropdown menu with direct edit/delete buttons in QuestionCard and update sidebar layout
*  update job title selection to use userEvent and verify options count
*  ensure spinner is displayed during save operation
*  verify job title combobox has more than one option
* Bump mcp rate limit
*  consolidate entity resolution behind shared canonical resolver
*  add activity and automation e2e tests
*  add unit tests for API authentication and key resolution


## [1.1.14](https://github.com/Gsync/jobsync/compare/v1.1.13...v1.1.14) (2026-07-13)


### Features

*  add Dashboard e2e tests; add testids to toggle groups
*  update Node.js version to 20.20.2 in Dockerfile
*  add Question Bank e2e tests; fix stale tag chip on edit
*  persist resume review results and show saved review on resume page
*  Improve JobDetails layout
*  confirm dialog to switch activities instead of error toast
*  allow restarting an activity from a task; scope activity-type link check
*  add partial unique indexes to prevent duplicate automation runs and discovered jobs
*  add MCP add_job e2e tests and update README with access note
*  enhance DiscoveredJobDetail component with CircularScore and improved layout
*  add MCP save_match_result tool and job-match directive for add_job
*  Enhance job-related tests and components to include total job counts and improve validation handling
*  Enhance job-related actions and tables to include total job counts
*  Add Lever ATS provider behind shared ats/ registry
*  Update job model and related components to handle optional Location and JobSource fields, fix add job mcp tool issue

### Bug Fixes

*  give profile e2e assertions headroom under parallel load

### Other Changes

* Update readme
*  improve activities table layout, stay on tasks after activity start
* Add job match and resume import evaluation prompts and assertions
* Refactor e2e tests, address flakiness
* Refactor code structure for improved readability and maintainability
*  extract shared ResponsiveCardHeader and SearchInput components


## [1.1.13](https://github.com/Gsync/jobsync/compare/v1.1.12...v1.1.13) (2026-07-06)


### Features

*  Add Windows PowerShell deployment script and enhance deploy.sh with app reachability check
*  Enhance DiscoveredJobsList with StatusBadge and CircularScore components for improved UI
*  Address github dependabot security alerts
*  Implement reusable StatusBadge component and centralize badge colors for improved UI consistency
*  Refactor Greenhouse company loading and improve resume templates with location formatting
*  Rename labels for clarity in admin, questions, automations
*  Enhance Greenhouse integration with company toggle functionality and improved UI
*  Add Greenhouse configuration display with toggle functionality
*  Add tests for MyJobsTable component including job rendering and actions
*  Enhance job filtering and display by adding discovery status handling
*  Add automation deletion and editing functionality with confirmation dialogs
*  Implement status filtering for discovered jobs and add related tests
*  Add topK and saveUnanalyzed configuration for Greenhouse automation
*  Implement job deduplication logic and URL normalization in scraper utilities
*  Enhance Ollama integration with user-specific settings and error handling
*  Implement resume section validation and messaging for default resume actions
*  Add default resume functionality
*  Actions menu to job details page
*  Improve automation run performance and enhance concurrency handling in automation runs
*  Enhance Greenhouse search functionality and add more companies
*  Implement infinite scroll for jobs and runs in automation detail page
*  Add Queston mcp tool
*  add resizable panel functionality and improve UI components
*  improve job details UI
*  improve ai review sheets UI
*  implement automation run cancellation and logging improvements
*  Add delete functionality for automation runs & better UX
*  Add support for additional contact info fields including URLs and labels
*  Add links to resumes in AutomationDetailPage and MatchDetails components
*  Enhance job scoring and automation management with new features and improvements
*  Add greenhouse job boards automation support
*  update activity handling to use startTime instead of endTime and enhance job display in MyJobsTable
*  add skills to resume import
*  add skills section to resume with CRUD operations
*  add MCP support - Add job tool call
*  implement scroll handling in AiResumeReviewSection for improved user experience
*  enhance resume import functionality with improved context handling and validation
*  implement syncSchedulerState function to manage scheduler based on active automations refactor: rename prompt function for clarity in resume review prompt generation refactor: replace hardcoded MAX_AUTOMATIONS_PER_USER with APP_CONSTANTS in automation actions refactor: optimize connection status check in AiResumeReviewSection component
*  add support for multiple resume layouts with simple and professional templates
*  implement resume import functionality with text extraction and structured data parsing

### Bug Fixes

*  Unresolved jobType from job discovery automation
*  MCP issues related to homelab & missing details
*  Automation job title mismatch issue & tests
*  Filter out resume with 2 sections or less
*  Resume import issues
*  update expiration date handling and improve layout in resume components
*  import functionality issue with abort controller and auto-import model handling
*  automation page issues
* Fix import resume issues

### Other Changes

* Update readme
* Add alert for JSearch deprecation in AutomationWizard component
* Refactor job creation logic to return job ID and improve deletion process
*  Enhance job creation e2e tests with additional scenarios and cleanup logic
*  Add unit test coverage for MCP tools and resume import feature
*  update job match analysis to use new scoring and parsing structure
* Refactor resume review feature to support markdown output and streaming
*  improve code readability by formatting and restructuring conditional statements in CreateResume and ResumeContainer components
*  update task display text from "My Tasks" to "Tasks" for consistency
*  replace hardcoded values with APP_CONSTANTS for improved maintainability and consistency
*  enhance type safety in resume-related components and update TypeScript configuration
*  update error logging for Ollama connection checks and tags fetching
*  resume import functionality to use new prompt structure and text generation method
*  add unit tests for resume import and text extraction functionalities
*  remove RecordsPerPageSelector from various components and use APP_CONSTANTS.RECORDS_PER_PAGE directly
* update readme


## [1.1.12](https://github.com/Gsync/jobsync/compare/v1.1.11...v1.1.12) (2026-06-05)


### Features

*  Add new job directly from dashboard
*  attach pdf generated resume & fix failing tests
*  add PDF export functionality for resumes

### Bug Fixes

*  add default values for contact info, education, experience, and summary sections
*  address security vulnerability
*  update resume validation logic and add tests for AiResumeReviewSection
*  update loading state in AiResumeReviewSection and enhance ResumeContainer layout with dropdown menu
*  failing job actions tests
*  revalidate dashboard path after activity and job actions
*  Date format overlap on chart of smaller screens
*  update next.js version to 15.5.18

### Other Changes

* check resume content sections before exporting
* Update readme
* Optimize performance, reduce unnecessary fetch


## [1.1.11](https://github.com/Gsync/jobsync/compare/v1.1.10...v1.1.11) (2026-05-05)


### Features

*  Impove weekly jobs chart
*  Switch pagination to infinite scroll
*  Add certification section to resume profile
*  Add rejected number of jobs column to companies table
*  Show/hide password input
*  Make secondary sidebar collapsable
*  Clickable number of jobs for sources
*  Clickable number of jobs for locations
*  Clickable number of jobs for job titles
*  Clickable number of jobs applied for companies

### Bug Fixes

* Fix: Profile e2e tests
* Fix: Activities card title truncate issue
* Fix: Gemini key error

### Other Changes

*  Migrate to vitest
* Refactor: Replace rechart with svg radial chart
*  Upgrade nextjs to 15.5.15
*  Upgrade jest
*  Override picomatch
*  Override lodash
* Add view jobs link under actions
* Add unit tests


## [1.1.10](https://github.com/Gsync/jobsync/compare/v1.1.9...v1.1.10) (2026-03-31)


### Bug Fixes

* Fix: Missing user validations
* Fix: Replace dangerouslySetInnerHTML with TipTapContentViewer
* Fix: Hydration issue

### Other Changes

* Address mock jobs data issue
* Add recommended security headers
* Refactor: API Key encryption
* Add auth to API routes
* Add auth to export route
* Address failing unit tests


## [1.1.9](https://github.com/Gsync/jobsync/compare/v1.1.8...v1.1.9) (2026-03-30)


### Other Changes

*  1.1.8


## [1.1.8](https://github.com/Gsync/jobsync/compare/v1.1.8...v1.1.8) (2026-03-30)



## [1.1.7](https://github.com/Gsync/jobsync/compare/v1.1.8...v1.1.7) (2026-03-30)



## [1.1.8](https://github.com/Gsync/jobsync/compare/v1.1.7...v1.1.8) (2026-03-30)



## [1.1.7](https://github.com/Gsync/jobsync/compare/v1.1.6...v1.1.7) (2026-03-30)



## [1.1.6](https://github.com/Gsync/jobsync/compare/v1.1.4...v1.1.6) (2026-03-30)


### Features

*  Add openrouter ai models support
*  Save ai job match details
*  Add google gemini provider support
*  Add cover letter
*  Add activity types tab on admin page
*  Improve calender label, add hrs activity

### Bug Fixes

*  Healthcheck
*  AI settings lint error
* Fix: Present date issue during ai resume review
*  stop job match streaming error
*  Auto load ollama model & lint errors
*  Openai models list and response
*  Add handlebar security patch
* Fix failing unit tests
*  Combo box search/filter logic
*  foreign key constraint error, & sort skill by jobs

### Other Changes

* Update release
* Add unit tests for openrouter
* Update readme
* Add warning for delayed ai response
* Add jobs mock data & allow local icons for companies
*  Cleanup unused code
* Refactor: AI models provider registry
*  Add unit tests for cover letter
* Minor label adjustment
*  Bump next to 15.5.14
* Address deprecation: Migrate lint from next to eslint
* Sort activity types list in sidebar
* Add unit tests for activity types
* Change docker internal port


## [1.1.4](https://github.com/Gsync/jobsync/compare/v1.1.3...v1.1.4) (2026-03-06)


### Features

*  Add question bank feature
*  add skill tags to jobs
*  add notes to job applications

### Bug Fixes

*  edit note issue

### Other Changes

* Update release file
* Update readme
* Add questions field column to tags table
*  Write unit tests for question bank feature
*  add contributing guidelines and code of conduct
* Show total hours of weekly activities on dashboard
*  write unit tests for skill tags feature
*  write unit tests for add note


## [1.1.3](https://github.com/Gsync/jobsync/compare/v1.1.2...v1.1.3) (2026-02-28)



## [1.1.2](https://github.com/Gsync/jobsync/compare/v1.1.0...v1.1.2) (2026-02-28)


### Bug Fixes

*  display user email in profile dropdown instead of static text

### Other Changes

*  replace release-please workflow with local release script
*  release 1.1.1


## [1.1.1](https://github.com/Gsync/jobsync/compare/v1.1.0...v1.1.1) (2026-02-28)


### Bug Fixes

* **ui:** display user email in profile dropdown instead of static text ([2fee6ee](https://github.com/Gsync/jobsync/commit/2fee6eeb8b041db26a20d72f1b24485fec51f030))
* **ui:** display user email in profile dropdown instead of static text ([bc39aa5](https://github.com/Gsync/jobsync/commit/bc39aa5bbda8dfa91fcb8e404b9cc68c2eec5674))

## [1.1.0](https://github.com/Gsync/jobsync/compare/v1.0.0...v1.1.0) (2026-02-28)


### Features

* add release automation ([6fd8247](https://github.com/Gsync/jobsync/commit/6fd8247f836208d61eddae935c4cbd63fac36cde))


### Bug Fixes

* Add job draft date in job details ([f6c2bb6](https://github.com/Gsync/jobsync/commit/f6c2bb65f14364f1292ecccf66c4f2999ba5cfc6))
* Admin tab switch ([8c57052](https://github.com/Gsync/jobsync/commit/8c5705297c643a13c9d00da34a45d7d85f785f23))
* bullet and order styling of editor content ([423b0f4](https://github.com/Gsync/jobsync/commit/423b0f43d0cfff76e1522864bd1b5177773692fb))
* button hydration error ([d7e97a0](https://github.com/Gsync/jobsync/commit/d7e97a014e2d41ccdb1cd77d6baa0b6975576f4b))
* Combobox filter issue ([1ab477e](https://github.com/Gsync/jobsync/commit/1ab477eb6e64f0aab7da360fcc936897217583e5))
* Combobox undefined error ([fdaa9fe](https://github.com/Gsync/jobsync/commit/fdaa9fe72c35695136871a8e92fb5311af52a476))
* configure release-please to target dev branch ([9ca7db0](https://github.com/Gsync/jobsync/commit/9ca7db003a5fb2d0ef4484a223aa7511eb84c08b))
* Create company bug when adding experience ([c992077](https://github.com/Gsync/jobsync/commit/c99207744f8f038ad490d10dba581dba8c13d960))
* DatePicker bug in Safari browser ([0f24106](https://github.com/Gsync/jobsync/commit/0f24106ebe5fabbd65336e2de128a623d3406099))
* Dialog scroll ([93f8e7d](https://github.com/Gsync/jobsync/commit/93f8e7dbec477b14c924ea0f819283c9a1f142f0))
* Edit company ([d7a15e2](https://github.com/Gsync/jobsync/commit/d7a15e293345e8097a43e9e4128b1e5a07ff024b))
* Error accessing ollama api endpoint in docker ([83aa24a](https://github.com/Gsync/jobsync/commit/83aa24a5ec8f503c1f2c758e4fb5ec5d2506bcc4))
* Failing Tasks playwright tests ([4c2cecf](https://github.com/Gsync/jobsync/commit/4c2cecf95c77106b7f6fafd2ded8ca4c16822d9c))
* hydration error, minor refactor ([6d2db31](https://github.com/Gsync/jobsync/commit/6d2db31ebde9ee6afc426f8ece397145becfe731))
* job status undefined issue ([91d3097](https://github.com/Gsync/jobsync/commit/91d309762d87f863ffd481b6c720b91ee8e21c5a))
* jobsApplied based on applied field ([d0ad166](https://github.com/Gsync/jobsync/commit/d0ad166a291477bd53663d59165a40bc6af203cb))
* login error validation ([7df090a](https://github.com/Gsync/jobsync/commit/7df090a6b899b89394d29722f7f247730b2b8713))
* minor layout issues ([55e1e42](https://github.com/Gsync/jobsync/commit/55e1e42d38e26c74ff675f0a761cabe40cde7cb2))
* no matching decryption secret ([b8f3919](https://github.com/Gsync/jobsync/commit/b8f3919cc5fa39d241b034639c73684c3284e34d))
* openssl not found ([290a1a7](https://github.com/Gsync/jobsync/commit/290a1a7b6ba54968ba19ebd0c41a378bbd8b1fa0))
* resume undefined issue ([dbe01a9](https://github.com/Gsync/jobsync/commit/dbe01a91ede0a378dd9678c44ac73823339e4546))
* Revalidate company list in addjob when adding company ([785c49b](https://github.com/Gsync/jobsync/commit/785c49b92ef6459fdb9d77045795108d78d26c65))
* route path ([4234c08](https://github.com/Gsync/jobsync/commit/4234c0808d83871bffb1d2d54a2205a244133771))
* session based conditional rendering ([b008e1b](https://github.com/Gsync/jobsync/commit/b008e1b7efa0912db5512b33561295b4c59b0c4d))

## 1.0.0 (2026-02-28)


### Features

* add release automation ([6fd8247](https://github.com/Gsync/jobsync/commit/6fd8247f836208d61eddae935c4cbd63fac36cde))


### Bug Fixes

* Add job draft date in job details ([f6c2bb6](https://github.com/Gsync/jobsync/commit/f6c2bb65f14364f1292ecccf66c4f2999ba5cfc6))
* Admin tab swich ([8c57052](https://github.com/Gsync/jobsync/commit/8c5705297c643a13c9d00da34a45d7d85f785f23))
* bullet and order styling of editor content ([423b0f4](https://github.com/Gsync/jobsync/commit/423b0f43d0cfff76e1522864bd1b5177773692fb))
* button hydration error ([d7e97a0](https://github.com/Gsync/jobsync/commit/d7e97a014e2d41ccdb1cd77d6baa0b6975576f4b))
* Combobox filter issue ([1ab477e](https://github.com/Gsync/jobsync/commit/1ab477eb6e64f0aab7da360fcc936897217583e5))
* Combobox undefined error ([fdaa9fe](https://github.com/Gsync/jobsync/commit/fdaa9fe72c35695136871a8e92fb5311af52a476))
* configure release-please to target dev branch ([9ca7db0](https://github.com/Gsync/jobsync/commit/9ca7db003a5fb2d0ef4484a223aa7511eb84c08b))
* Create company bug when adding experience ([c992077](https://github.com/Gsync/jobsync/commit/c99207744f8f038ad490d10dba581dba8c13d960))
* DatePicker bug in Safari browser ([0f24106](https://github.com/Gsync/jobsync/commit/0f24106ebe5fabbd65336e2de128a623d3406099))
* Dialog scroll ([93f8e7d](https://github.com/Gsync/jobsync/commit/93f8e7dbec477b14c924ea0f819283c9a1f142f0))
* Edit company ([d7a15e2](https://github.com/Gsync/jobsync/commit/d7a15e293345e8097a43e9e4128b1e5a07ff024b))
* Error accessing ollama api endpoint in docker ([83aa24a](https://github.com/Gsync/jobsync/commit/83aa24a5ec8f503c1f2c758e4fb5ec5d2506bcc4))
* Failing Tasks playwright tests ([4c2cecf](https://github.com/Gsync/jobsync/commit/4c2cecf95c77106b7f6fafd2ded8ca4c16822d9c))
* hydration error, minor refactor ([6d2db31](https://github.com/Gsync/jobsync/commit/6d2db31ebde9ee6afc426f8ece397145becfe731))
* job status undefined issue ([91d3097](https://github.com/Gsync/jobsync/commit/91d309762d87f863ffd481b6c720b91ee8e21c5a))
* jobsApplied based on applied field ([d0ad166](https://github.com/Gsync/jobsync/commit/d0ad166a291477bd53663d59165a40bc6af203cb))
* login error validation ([7df090a](https://github.com/Gsync/jobsync/commit/7df090a6b899b89394d29722f7f247730b2b8713))
* minor layout issues ([55e1e42](https://github.com/Gsync/jobsync/commit/55e1e42d38e26c74ff675f0a761cabe40cde7cb2))
* no matching decryption secret ([b8f3919](https://github.com/Gsync/jobsync/commit/b8f3919cc5fa39d241b034639c73684c3284e34d))
* openssl not found ([290a1a7](https://github.com/Gsync/jobsync/commit/290a1a7b6ba54968ba19ebd0c41a378bbd8b1fa0))
* resume undefined issue ([dbe01a9](https://github.com/Gsync/jobsync/commit/dbe01a91ede0a378dd9678c44ac73823339e4546))
* Revalidate company list in addjob when adding company ([785c49b](https://github.com/Gsync/jobsync/commit/785c49b92ef6459fdb9d77045795108d78d26c65))
* route path ([4234c08](https://github.com/Gsync/jobsync/commit/4234c0808d83871bffb1d2d54a2205a244133771))
* session based conditional rendering ([b008e1b](https://github.com/Gsync/jobsync/commit/b008e1b7efa0912db5512b33561295b4c59b0c4d))
