Task 04 — Resume export core (2026-10-03)

1. Git and scope

Base SHA: `8aff923560e8566ddfe85cf00350fee44043880c` (main at task start).
Branch: `feat/resume-export-core`.
Worktree: `E:\Projects\vocatrya\.worktrees\feat-resume-export-core`.
The implementation commit SHA is provided in the final delivery message; this report is included in that commit.

The root main working tree remained clean at the base SHA. No other worktree was edited. No push, merge, rebase, tag, release, deployment, app launch, dev server, or production build was performed. No real application database, real uploads root, or `%LOCALAPPDATA%\Vocatrya` content was accessed. No schema, migration, dependency, lockfile, feature configuration, or environment file was changed.

The expected output of `git diff --name-only 8aff923560e8566ddfe85cf00350fee44043880c..HEAD` after committing is:

```text
RESUME_EXPORT_CORE_REPORT.md
__tests__/helpers/resumeExportTestDb.ts
__tests__/helpers/resumeExportTestSetup.ts
__tests__/resumeArtifactRoutes.spec.tsx
__tests__/resumeArtifactService.spec.ts
__tests__/resumeExportUI.spec.tsx
desktop/main/main.js
desktop/main/preload.js
desktop/main/resume-print.js
desktop/main/resume-print.test.mjs
src/actions/resumeVariant.actions.ts
src/app/api/profile/resume-artifacts/[artifactId]/route.ts
src/app/api/profile/resume-artifacts/route.ts
src/app/resume-print/[versionId]/page.tsx
src/app/resume-print/[versionId]/print.css
src/components/career/resume-variant/ResumeExportControl.tsx
src/components/career/resume-variant/ResumePreview.tsx
src/components/career/resume-variant/ResumePrintReady.tsx
src/components/career/resume-variant/ResumeVariantWorkspace.tsx
src/i18n/messages/en.json
src/i18n/messages/zh-CN.json
src/lib/career/resumeArtifactService.ts
src/types/desktop.d.ts
vitest.resume-export.config.ts
```

All task-owned/reserved exclusions remain untouched, including `resumeVariantService.ts`, agent tools/context, application service/actions/submission controls, backup code, schema, and migrations. Translation edits only add keys inside `resumeVariants` without reordering existing keys.

2. Conventions verified

`window-theme.js` validates sender identity against the main window's `webContents`, the exact `mainFrame`, and its backend origin, then validates theme arguments. The new print handler follows this sender convention and permits only a 1–128-character alphanumeric/underscore/hyphen version ID. Runtime IPC handlers instead validate registered backend kinds; connection IPC uses backend-minted tickets. There was no existing print channel or `printToPDF` implementation.

The existing resume route calls `auth()`, returns JSON `{ error }` with HTTP 401 when unauthenticated, scopes reads by user ownership, and uses `NextResponse` for binary downloads. New routes follow that shape, with explicit domain error codes/statuses and generic infrastructure errors that do not expose filesystem paths. Existing server actions use `requireUser()`, capability assertions, `ActionResult`, and `handleError`; the reusable-export action follows those conventions.

Existing DB test helpers use `mkdtemp` under the OS temporary directory, explicit Prisma datasource URLs, and disposable-path checks. Their usual schema setup invokes Prisma CLI. This task instead uses `node:sqlite` to apply the checked-in SQL migrations directly to a verified temporary `test.db`. Each new integration suite injects that datasource and a separate temporary uploads directory. The dedicated Vitest config replaces only the old helper's `pushSchema` during existing resume regression runs; no Prisma CLI executes. Mocked UI/Electron tests do not access a database or real file root. Test-scoped gate values are restored; no persisted configuration changes occur.

Probe drift: at the base, `getVersion` starts at line 282, freeze at 379, the freeze action at 239, and the workspace preview at approximately 398, as reported. `ResumeArtifact` starts at 1485 rather than 1484. The workspace page begins at 15, but disabled capability renders a runtime notice; `notFound()` applies to invalid explicit version resolution. This still prevents resume rendering. The print route separately returns `notFound()` on missing authentication, capability/ownership failure, or mutable status. The existing public `getVersion` enforces ownership and internally uses the write assertion; current readable/writable resume capability conditions admit the same modes/scopes. It was reused without modification.

3. Implementation by step

- Step 1: verified the source, schema, auth/gate conventions, IPC boundary, uploads configuration, and test isolation without opening data files. Dependencies use a `node_modules` junction to the existing root install, matching existing worktrees; no install or generation was performed.
- Step 2: new `resumeArtifactService.ts` provides reusable lookup, export creation, download access, DTO construction, filename sanitization, and logical-key build/resolve helpers. Every public operation applies its read/write gate before domain queries or filesystem access. Version/artifact queries enforce user ownership. Creation requires FROZEN/SUBMITTED and an unarchived variant, exact `%PDF-` bytes, and a fixed 20 MB limit. It atomically renames a temporary file, computes SHA-256, creates the row, and removes bytes on row failure. Pending creates are shared across service instances in the desktop's single backend process. Existing rows are never updated/deleted. Missing-file rows remain intact while a new artifact is created.
- Step 3: new `POST /api/profile/resume-artifacts?versionId=...` authenticates, asserts write capability before consuming the body, bounds chunked PDF bodies, and returns only `id`, `fileName`, `sha256`, `byteSize`, and `createdAt`. New `GET /api/profile/resume-artifacts/[artifactId]` authenticates and delegates the readable gate and ownership check to the service. It sends exact stored bytes, PDF content type, private/no-store caching, and RFC 5987 UTF-8 attachment filenames.
- Step 4: `ResumePreview.tsx` now has an optional print mode; its default notice, placeholders, and content behavior remain unchanged. The new `/resume-print/[versionId]` page sits outside dashboard chrome, authenticates, asserts readable capability, and reuses the owned render graph and preview. `ResumePrintReady.tsx` waits for `document.fonts.ready` after rendering and publishes a version-specific readiness marker. Print CSS selects A4 portrait with 15 mm margins, white paper, printed backgrounds, and item break avoidance.
- Step 5: new `desktop/main/resume-print.js`, registered in `main.js` and exposed as `vocatryaResume.printToPDF(versionId)` in `preload.js`, builds its own loopback URL. A hidden sandboxed window shares the main session, blocks foreign navigation/redirects and new windows, waits for readiness under a 30-second deadline, and returns PDF bytes or typed errors. In-flight requests join per version. All outcomes destroy the hidden window; closing the main window also cleans up active print windows and IPC registration. `src/types/desktop.d.ts` describes the narrow bridge.
- Step 6: the new `findReusableResumeExport` action applies auth/read capability and returns a path-free DTO. `ResumeExportControl.tsx` integrates into the workspace without expanding its editor logic. Draft export confirms read-only/new-draft consequences, calls the existing freeze action, and immediately updates workspace status to FROZEN. Lookup precedes IPC; persistence precedes downloading stored bytes. Archived versions can only download an existing artifact. The control disables outside Electron, shows stage progress and distinct errors, and locks overlapping clicks. Both locale files contain the new messages.
- Step 7: static checks and isolated tests passed. A read-only reviewer inspected the feature against the supplied task and identified an ASCII-decoding signature issue. It was fixed with byte-exact comparison and a regression asserting no write/row. The reviewer confirmed no remaining Critical/Important findings. No merge was attempted.

4. Verification commands and results

Run from the new worktree:

```powershell
npx tsc --noEmit --incremental false
npm run lint
npx vitest run --config vitest.resume-export.config.ts __tests__/resumeArtifactService.spec.ts __tests__/resumeArtifactRoutes.spec.tsx __tests__/resumeExportUI.spec.tsx
npx vitest run --config vitest.resume-export.config.ts __tests__/resumeArtifactService.spec.ts __tests__/resumeArtifactRoutes.spec.tsx __tests__/resumeExportUI.spec.tsx __tests__/resumeVariant.v1.foundation.spec.ts __tests__/resumeVariant.v1.productPolish.spec.tsx __tests__/resumeVariant.v1.productPolish.server.spec.ts __tests__/resumeVariant.v1.productPolish.page.spec.tsx __tests__/resumeVariant.v1.runtime.spec.ts __tests__/resumeVariant.v1.noregression.spec.ts __tests__/resumeVariant.postCommitHardening.spec.ts __tests__/resumeVariantWriteBoundary.spec.ts
npx vitest run --config desktop/vitest.config.mjs desktop/main/resume-print.test.mjs desktop/main/window-theme.test.mjs desktop/main/runtime/ipc.test.mjs desktop/main/installer-config.test.mjs desktop/main/startup.test.mjs
git diff --check
```

Typecheck: passed. Full lint: passed with zero errors and three existing unused-disable warnings (`jobsAbReadPath.spec.ts` lines 52/499; `desktop/main/db-tool.cjs` line 45). Changed-file lint also passed after final fixes. Whitespace check passed.

The consolidated app run passed 116 tests in 11 files before the review regression was added. The final new-feature rerun passed 45 tests in three files, including the added signature regression and exact upload boundary. The eight existing resume suites contribute 72 passing tests. Desktop checks passed 46 tests in five files. Total distinct verified tests: 163 (45 new app + 72 existing resume + 46 desktop). SQLite emitted its experimental-feature notice. Earlier fixture/type/mock failures were corrected; no outstanding test failures remain.

5. Deviations and limits

No product decision was changed, and nothing required editing a prohibited file. The implementation selects technical constants where the task required fixed limits: 20 MB PDFs and a 30-second print deadline. The export control is a focused child component because the existing workspace is already large. Existing regression setup uses direct SQL migration initialization to honor the no-Prisma-CLI constraint. Real Chromium rendering and download behavior were deliberately not exercised because launching the application/server/build was forbidden. The single-process create lock matches this desktop backend; no distributed/multi-server deployment was introduced.

6. Product-owner manual verification checklist

Run only when you intentionally open your desktop test instance with A+B enabled and scope `resume_v1` or `full`.

1. Open a resume variant with a FROZEN version. Export PDF. Confirm no hidden print window flashes on screen. Open the resulting PDF and compare its header, section order, item titles, and expression text with Preview. Check there is no read-only notice, empty-value placeholder, editor button, or dashboard chrome.
2. Include Chinese header/item/expression text and a Chinese variant name. Export, open the PDF, select Chinese text, copy it into a text editor, and verify exact characters. Confirm the downloaded filename retains Chinese characters and replaces Windows-reserved filename punctuation.
3. Prepare enough section items for at least two pages. Export and check A4 portrait, margins, page breaks, no cropped text, and that ordinary items stay together where they fit on one page. An item taller than a page necessarily spans pages.
4. Record what happens when downloading: whether Electron shows a save dialog or saves directly, the proposed filename, and the actual resulting directory. No custom download handler was added; this uses the shell's existing download behavior. Verify the file can be opened from that location. The stored artifact remains under the configured uploads root, while the downloaded copy goes to the shell/user-selected destination.
5. Open a DRAFT. Click Export PDF and cancel; verify it is still editable. Click again and confirm Freeze and export. Verify the prompt explains read-only status and the need for a new draft. After successful export, check the Frozen label, disabled editors, and Create new draft action. Reload and verify that status persists.
6. Export the same immutable version twice, saving copies as `first.pdf` and `second.pdf`. Compare `Get-FileHash -LiteralPath '<chosen folder>\first.pdf' -Algorithm SHA256` with the second file. They must match. In DevTools Network, the second click should download the existing artifact without a POST or print view request. Confirm the same artifact ID is returned by the lookup.
7. To force a save failure after freezing, use the visible renderer's DevTools Network request blocking to block `*/api/profile/resume-artifacts?*`, then export a new draft and confirm freezing. Verify the save error appears and the workspace remains frozen/read-only. Clear request blocking and retry; no second freeze confirmation/action should occur. Verify the PDF now downloads.
8. To check hidden-window cleanup after failure without modifying data, run `await window.vocatryaResume.printToPDF('task04-nonexistent-version')` in desktop DevTools. Expect a typed timeout/load error within the deadline and no visible extra window. With Electron process/window inspection, verify the hidden BrowserWindow/WebContents disappears after both this failure and a successful export. A nonexistent print route never becomes ready.
9. Save an archived variant's direct workspace link before archiving. Reopen that link and download its existing PDF; no new render/POST should occur. An archived variant/version with no stored PDF should show the unavailable message and create nothing.
10. In a disposable test instance only, remove one stored artifact's bytes while keeping its row, then retry export on its unarchived immutable version. Verify a new artifact/file appears and the original row remains unchanged. Downloading the old artifact URL should return the explicit missing-bytes error. Do not do this against irreplaceable application data.
11. Open the same workspace URL in a plain browser. Export must be disabled with the desktop-only explanation; the workspace preview/editor should continue to work.
12. Verify SUBMITTED export, another user's access denial, disabled capability modes, and both English/Chinese control messages in the appropriate desktop test instance. Do not change your normal instance's rollout configuration merely to run this checklist.

Electron API options and navigation-event signatures were checked against the [official webContents documentation](https://www.electronjs.org/docs/latest/api/web-contents).
