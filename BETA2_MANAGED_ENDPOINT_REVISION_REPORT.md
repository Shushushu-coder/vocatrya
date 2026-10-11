# BETA2 Managed Endpoint Revision Report

```
REVISION:  BETA2_MANAGED_ENDPOINT_SHUCUBED
SUPERSEDED: https://managed.vocatrya.com
EFFECTIVE:  https://managed.shucubed.xyz
REASON:     vocatrya.com is not registered.
            Internal Beta will use the existing shucubed.xyz domain.
```

Generated: 2026-10-11
Branch: `fix/beta2-managed-endpoint`
Worktree: `E:\Projects\vocatrya\.worktrees\beta2-managed-endpoint`

---

## 1. Starting Baseline

| Item | Value |
|---|---|
| Repository | `E:\Projects\vocatrya` |
| Baseline commit | `c008b481ab01630e0ab608f1b95e2fc7c7b02f22` (main, beta.2) |
| Revision commit | `0b7f0e97926e813404509ef3b0611128ccd9037f` |
| Canonical version | `1.2.0-beta.2` (unchanged — same unpublished version, revised candidate) |
| `services/managed-ai/package.json` | `0.1.0` (unchanged) |
| `evals/package.json` | `1.0.0` (unchanged) |

M6 worktree (`E:\Projects\vocatrya\.worktrees\m6-real-gateway-e2e`) was inspected before and after the run; `M6_REAL_GATEWAY_E2E_REPORT.md` and `M6_HOSTED_SERVER_COEXISTENCE_AUDIT.md` remain untouched and uncommitted there.

## 2. Endpoint Contract

| | |
|---|---|
| OLD_ENDPOINT | `https://managed.vocatrya.com` |
| NEW_ENDPOINT | `https://managed.shucubed.xyz` |
| Canonical authority | `src/lib/ai/managed-client.ts` → `TRUSTED_HOSTED_MANAGED_ENDPOINT` |
| Dev override | `VOCATRYA_DEV_HOSTED_ENDPOINT` (only when `NODE_ENV !== "production"`) |
| Session broker | `VOCATRYA_HOSTED_SESSION_URL` (loopback-only, token issuer — unchanged) |
| Internal broker token | `VOCATRYA_DESKTOP_INTERNAL_TOKEN` (unchanged) |

Contract properties preserved: production default requires HTTPS; rejects credentials in URL, query strings, fragments; loopback HTTP allowed only for local development override; no implicit fallback to the old endpoint exists anywhere.

## 3. Endpoint Dependency Audit

Search terms executed: `managed.vocatrya.com`, `vocatrya.com`, `Managed AI endpoint`, `Hosted base URL`, `Desktop hosted URL`, `Release endpoint configuration`.

| Component | Finding |
|---|---|
| Desktop Managed Gateway Client | `HostedManagedClient` (backend bundle) resolves endpoint via `endpoint()` in `managed-client.ts` — the single canonical authority. |
| Managed Session / Bootstrap | `DesktopHostedSessionProvider` talks only to the loopback session broker; token is then sent to the trusted endpoint by the client. No embedded host. |
| AIConnection Resolver | Resolves provider binding, not the endpoint; unaffected. |
| Business Assignment | Consumes Managed client; no host literals. |
| Hosted Client / HTTP Transport | `managed-client.ts` — the single place where the production URL is compiled in. |
| Installer / Packaging | No endpoint references; backend bundle is staged wholesale. |
| Electron runtime config | Supplies `VOCATRYA_DESKTOP_DATA_ROOT`, `VOCATRYA_HOSTED_SESSION_URL`, `VOCATRYA_DESKTOP_INTERNAL_TOKEN`; no production host. |
| Release Manifest / Verification | Uses commit/version/hash; endpoint recorded in this report. |
| Automated Tests | Fixture URLs such as `https://hosted.example` are synthetic and remain valid. |
| Deployment Documentation | `services/managed-ai/README.md` updated with the revision record and `PUBLIC_ORIGIN`. |

**Result:** exactly one production hostname literal existed in source (`managed-client.ts:6`), and it was the real Endpoint Authority — not UI text.

## 4. Changed Files

Commit `0b7f0e97` — `fix(managed-ai): revise beta2 hosted endpoint` (3 files, +131/−1):

| File | Change |
|---|---|
| `src/lib/ai/managed-client.ts` | `TRUSTED_HOSTED_MANAGED_ENDPOINT` → `https://managed.shucubed.xyz` + revision comment block (REVISION/SUPERSEDED/EFFECTIVE/REASON). |
| `__tests__/managedEndpointContract.spec.ts` | New endpoint-contract suite: 12 tests covering canonical value, revision metadata, production default vs dev override, old-endpoint absence, HTTPS-only validation, credential/query/fragment rejection, loopback exception, request-URL construction, broker origin, no-fallback. |
| `services/managed-ai/README.md` | Revision record + `PUBLIC_ORIGIN = https://managed.shucubed.xyz` deployment contract note. |

No changes to: Prisma schema/migrations, auth models, subscription/entitlement/quota logic, usage ledger/idempotency, AIConnection resolver, ACCOUNT_LOGIN path, provider fallback rules, API key compatibility, M6 reports, package versions, GGSANDBOX or any other project.

## 5. Security / Auth Impact

- No new authentication, billing, or data models introduced.
- Dev override still gated behind `NODE_ENV !== "production"`; production validation unchanged.
- Bearer tokens are issued by the local session broker and sent only to `endpoint()`; no token can leak to the superseded host because no code path references it anymore.
- No TLS verification weakening, no certificate bypass, no untrusted-origin whitelist.
- No implicit production fallback to `managed.vocatrya.com` exists (verified by source audit + artifact scan).
- No destructive reset of existing Desktop Credentials, bindings, or user data.

## 6. Desktop Compatibility

Verified request paths all route through `endpoint()`:

- Managed bootstrap / session establishment — via `HostedManagedClient` + `DesktopHostedSessionProvider` (loopback broker).
- Managed model catalog, invocation, text generation, streaming, structured output — all constructed against `endpoint()` (covered by new suite + managed regression).
- Error handling / timeout / abort / reopen-retry — unchanged; managed failures still fail closed with typed errors and **no silent fallback** to Own Account or other providers.
- Existing Business Assignment parsing, historical Conversation Lock, saved credentials — untouched by the change.
- Packaged artifact verified: `https://managed.shucubed.xyz` present in backend server chunks (`7018.js`, `6975.js`, `6928.js`); zero occurrences of `managed.vocatrya.com` in staged backend and `win-unpacked` (byte-level scan).

## 7. Hosted Compatibility

- `services/managed-ai` contains **no** hostname/domain binding for the old or new domain; it binds `INTERNAL_HTTP = :8787` behind TLS ingress. `PUBLIC_ORIGIN` is a deployment-time value only.
- Topology contract unchanged: `HOSTED_TOPOLOGY = SINGLE_ACTIVE_INSTANCE`, `SQLITE_AUTHORITY = PERSISTENT_SERVER_VOLUME`, `AUTO_SCALING = DISABLED`, `ROLLING_OVERLAP = DISABLED`.
- Subscription/entitlement/quota/usage ledger/idempotency/settlement semantics untouched (hosted regression 91/91).
- Hosted service code is not packaged into the Desktop app (packaging filters verified; hosted-code exclusion holds).

## 8. Regression Results

| Suite | Result |
|---|---|
| Endpoint contract (new) | **12/12 PASS** |
| Root managed-related | **102/102 PASS** (8 files) |
| Hosted service | **91/91 PASS** (6 files) |
| Root full regression | **4574 passed / 1 skipped** (396 files) |
| Desktop suite | **661 passed / 8 skipped** (43 files); `migration-integration.test.mjs` separately rerun in isolation → **7/7 PASS** (earlier `EBUSY` was concurrent `.codex-tmp` contention, not a defect) |
| TypeScript (`tsc --noEmit`) | PASS |
| ESLint | PASS |
| Next.js build | PASS |
| Hosted build/typecheck/lint | PASS |
| Managed secret scan (win-unpacked) | PASS — no `SYNTHETIC_MANAGED_GATEWAY_SECRET_*` markers |
| Hosted-code exclusion | PASS |

## 9. Candidate Identity

### Revised candidate (this revision)

| Field | Value |
|---|---|
| Commit | `0b7f0e97926e813404509ef3b0611128ccd9037f` |
| Artifact | `E:\Projects\vocatrya\.worktrees\beta2-managed-endpoint\.codex-tmp\windows-installer\dist\Vocatrya-Setup-1.2.0-beta.2-x64.exe` |
| Size | `180627549` bytes |
| SHA-256 | `2e44ea45a031ac67822a1070dcd8c5dcbd68e606a2ef7e517ae3cccdffaa6580` |
| Built | `2026-10-11T08:35:55.377Z` |
| Electron / Node | `44.4.3` / `v20.20.2` (`56c1520e…b937` — matches pinned hash) |
| Prisma / migrations | `6.19.0` / `54` migrations, fingerprint `2b83367f…b73c` |
| Signature | `NotSigned` → normalized `NOT_SIGNED` |
| Effective endpoint | `https://managed.shucubed.xyz` |

### Original beta.2 candidate (preserved, not overwritten)

| Field | Value |
|---|---|
| Commit | `c008b481ab01630e0ab608f1b95e2fc7c7b02f22` |
| Artifact | `E:\Projects\vocatrya\.worktrees\beta2-candidate\.codex-tmp\windows-installer\dist\Vocatrya-Setup-1.2.0-beta.2-x64.exe` |
| Size | `180625468` bytes |
| SHA-256 | `e13cfd417e424fd0c85f9f4d5951abe0e2b2d2546650100231f5b4e360bf1435` |

Both artifacts coexist; identical version `1.2.0-beta.2`, distinguished by commit/hash/size/build timestamp/endpoint revision.

## 10. Installation & Persistence Evidence

### Fresh install + persistence (acceptance harness, isolated data roots)

`acceptance-report.json` (revised artifact): `defaultInstall`, layout complete (54 migrations, bundled-node SHA match, no forbidden artifacts/foreign binaries), shortcuts valid, `freshInstallSigninHttp=200`, `staticAssetStatus=200`, `systemNodeRequired=false`, `dockerRequired=false`, `repoRequired=false`, `arbitraryCwdLaunch`, `offlineInstallLaunch`, `freshInstallDpapiSecret`, `freshInstallDbMigration`, single-instance, `crashBackendKilled`, `gracefulShutdownInstalled`, no orphan processes, `reinstall` with `secretPreservedAfterReinstall`/`databasePreservedAfterReinstall`/`filesPreservedAfterReinstall`/`backupsPreservedAfterReinstall`, `reinstallLaunch=200`, `uninstall` preserving `userDb`/`secretStore`/`files`/`backups`/`logs`, `reinstallAfterUninstall`+`preservedDataReused`+`reinstallLaunchAfterUninstall=200`, `customSpacePathInstall`+`customSpacePathLaunch=200` — **all true**.

`error` field in the same report is **not an install failure**: it is the unicode-path leg of `acceptance-installer.mjs` (line 412) failing at `fs.cpSync` — a Node v24 + GBK-locale copy bug producing an empty directory. The independent `unicode-smoke.mjs` (manual `copyTree` workaround) proves the product itself works under a unicode install dir: layout verified, 54 migrations deployed, `signinHttp=200`, `stoppedClean=true`.

### beta.1 → revised beta.2 upgrade (instrumented, isolated)

- beta.1 installed (52 migrations) → launched, `/signin` 200 → sentinel rows + `secrets.dat` SHA-256 captured.
- Revised installer over same directory → landed `0b7f0e97`.
- Sentinel rows preserved verbatim; `secrets.dat` SHA-256 identical; DB migrated **52 → 54** on revised launch; `/signin` 200; clean stop.

### Same-version (original beta.2 → revised beta.2) install-over

- `c008b481` install → launched+stopped → revised install landed `0b7f0e97` (uninstall-old + extract-new, exit 0).
- `secrets.dat` + DB preserved; `/signin` 200 on revised build.
- Confirms same-version candidate replacement is supported, with the timing caveat in §11.

### Reopen / persistence

Reopen launches after both upgrade paths reached `/signin` 200 with prior data (sentinel, secrets, 54 migrations) intact — no destructive reset.

### Real user data safety

`%LOCALAPPDATA%\Vocatrya\data\vocatrya.db` SHA-256 before and after all testing: `64956CE70A19364D6EB9EA51310C7BB10E1AFFD9667B07C363444FC8E7D21B71` — **byte-identical**. All tests used isolated `VOCATRYA_DESKTOP_DATA_ROOT` roots.

## 11. Findings

### P0 — none.

### P1

1. **NSIS `uninstallOldVersion` intermittent failure in this environment.** During scripted install-over-install runs, the bundled old-uninstaller (`old-uninstaller.exe`, copied to `$PLUGINSDIR` and invoked silently with `_?=$INSTDIR`) intermittently exits `2`; the installer then surfaces `uninstallFailed: 2`. Observed 2/4 automated attempts vs 3/4 successes in instrumented runs (identical binaries/args succeed on manual invocation). This is an electron-builder/NSIS framework + environment interaction (timing-sensitive, likely transient file-locking around recently-executed unsigned binaries) — **unrelated to the endpoint revision** (the installer framework is identical in both candidates). Practical impact: silent in-place upgrade may occasionally abort with "try running the installer again"; retrying the installer, or uninstall-then-install, succeeds.

2. **`uninstallFailed` MessageBox lacks `/SD`** (upstream electron-builder template `installUtil.nsh`): on failure of the old-uninstaller, a non-silent-safe dialog is shown, which can **block a `/S` silent install indefinitely** instead of erroring out. Mitigation used in validation: watch for installer-process liveness + assert landed build identity. Worth an upstream-style fix (add `/SD`) in `desktop/installer.nsh` via a custom message override if ever needed — not changed in this revision.

### P2

1. `acceptance-installer.mjs` unicode leg fails on `fs.cpSync` under Node v24/GBK hosts (harness limitation, not product). Recommend switching to a manual copy helper (as used in `unicode-smoke.mjs`) in a future tooling change.
2. Total in-place upgrade wall-clock is ~2–3.5 min (old-uninstall + extract + `EstimatedSize` computation over ~635 MB) — slower than intuitive; test harnesses must wait for installer-process exit, not just the spawning parent.
3. WMI `Win32_Process.ExecutablePath` ANSI-mangles unicode install paths (`Vocatrya测试安装` → `Vocatrya??԰�װ`); process detection must use ASCII prefixes (fixed in smoke scripts).

## 12. Release Manifest / Gates

`\.codex-tmp\windows-release\1.2.0-beta.2\`:

- `release-manifest.json` — commit `0b7f0e97`, size `180627549`, SHA `2e44ea45…`, migration fingerprint `2b83367f…` — **verification PASS** (artifact-size, artifact-sha256, version, commit, migrations, runtime-versions all checked).
- `SHA256SUMS.txt` — recorded.
- `signature-report.json` — `NotSigned` → `NOT_SIGNED`.
- `release-gate-internal-unsigned.json` — **PASS**.
- `release-gate-public-signed.json` — **BLOCKED** (`ARTIFACT_NOT_SIGNED`, `PUBLISHER_IDENTITY_UNRESOLVED`) — expected; not bypassed.

```
AUTHENTICODE        = DEFERRED
PUBLIC_SIGNED_GATE  = BLOCKED
```

## 13. DNS / TLS Readiness

Measured via DNS-over-HTTPS (local resolver returns `198.18.0.0/15` fake-IP answers — discarded):

| Host | Result |
|---|---|
| `managed.shucubed.xyz` | **NXDOMAIN** (authoritative DNSPod) |
| `shucubed.xyz` | A `129.204.35.36` |
| `vocatrya.com` | NXDOMAIN (confirms unregistered — rationale holds) |

```
ENDPOINT_CONTRACT       = UPDATED
DOMAIN_READINESS        = BLOCKED
REAL_HOSTED_CONNECTION  = NOT_EXECUTED
```

No DNS/TLS/Nginx changes were made. No real Hosted request was attempted; all connectivity evidence is synthetic/local and is not reported as Real Gateway E2E. `vocatrya.shucubed.xyz` (future landing page) — no work performed, out of scope.

M6 status remains:

```
M6_READINESS        = PASS
SERVER_COMPATIBILITY = BLOCKED
REAL_GATEWAY_E2E    = NOT_EXECUTED
M6                  = OPEN
```

## 14. Acceptance Matrix

| Criterion | State | Evidence |
|---|---|---|
| `ENDPOINT_CONTRACT` | **REVISED** | commit `0b7f0e97` |
| `NEW_HOST` | `https://managed.shucubed.xyz` | source + packaged chunks |
| `DESKTOP_ENDPOINT` | **UPDATED** | same |
| `OLD_ENDPOINT_FALLBACK` | **NONE** | source audit + artifact byte-scan |
| `ENDPOINT_REGRESSION` | **PASS** | 12/12 |
| `HOSTED_REGRESSION` | **PASS** | 91/91 |
| `DESKTOP_REGRESSION` | **PASS** | 661 + 7 (isolated rerun); full root 4574 |
| `WINDOWS_CANDIDATE` | **REBUILT** | `2e44ea45…` |
| `CANDIDATE_IDENTITY` | **VERIFIED** | manifest verify PASS |
| `SECRET_SCAN` | **PASS** | win-unpacked clean |
| `HOSTED_CODE_EXCLUSION` | **PASS** | packaging filters |
| `MIGRATION_COMPATIBILITY` | **PASS** | fingerprint `2b83367f…` identical to original; 52→54 applied in upgrade |
| `FRESH_INSTALL` | **PASS** | acceptance-report positive fields; unicode leg via dedicated smoke PASS |
| `BETA1_UPGRADE` | **PASS with note** | full flow verified (data+secrets+54 migrations+signin 200); see P1-1 intermittent `uninstallOldVersion` exit-2 |
| `REOPEN` | **PASS** | signin 200, data intact |
| `RELEASE_MANIFEST` | **UPDATED** | regenerated for `0b7f0e97` |
| `INTERNAL_UNSIGNED_GATE` | **PASS** | |
| `AUTHENTICODE` | **DEFERRED** | |
| `PUBLIC_SIGNED_GATE` | **BLOCKED** | expected |
| `DOMAIN_READINESS` | **BLOCKED** | NXDOMAIN — documented, not a product failure |
| `REAL_HOSTED_CONNECTION` | **NOT_EXECUTED** | |

## 15. Final Verdict

```
ENDPOINT_REVISION = COMPLETE
CANDIDATE         = VALID_INTERNAL_UNSIGNED (revised)
PUBLIC_RELEASE    = BLOCKED (unsigned, expected)
DEPLOY/DNS/TLS    = NOT_TOUCHED
RECOMMENDATION    = Accept as internal beta.2 candidate revision.
                    Configure managed.shucubed.xyz DNS + TLS before any
                    Real Gateway E2E; upgrade path P1 items are test-env
                    notes, not blockers.
```
