# Interview Adapter / Interface Integration (Phase 2)

Base: `main @ b05f8ec6a7e64936fef99d15b2547ac429074296` (task `VOCATRYA_PHASE2_INTERVIEW_ADAPTER_INTERFACE_INTEGRATION`).
Status: working tree, **not committed / not pushed**. Phase 3 transplant is explicitly out of scope.

The old compatibility snapshot `facc436` is `HISTORICAL_REFERENCE_ONLY`; every fact below was
re-audited against current `main`.

## 1. Boundary

```text
Phase 1 domain/service (future transplant)
        |  depends only on the resolver interface
        v
InterviewModelResolver  (src/lib/interview/interviewModelResolver.ts, owned by Vocatrya)
        |  resolve(userId) -> { provider, model, generateJson }
        v
getInterviewModel(userId)  (src/lib/interview/getInterviewModel.ts, server-only)
        |  reads UserSettings.settings.ai.interview, validates, delegates
        v
shared getModel(provider, model, userId)  (src/lib/ai/providers.ts — NOT imported by services)
  + resolveApiKey / PROVIDER_REGISTRY / encryption-key path (reused, never duplicated)
```

Rules:

- Future feedback/summary/coaching services must depend on `InterviewModelResolver`, never on
  `src/lib/ai/providers.ts` directly.
- Provenance crossing the boundary is `{ provider, model }` only. No keys, base URLs, key
  metadata, or credential details.
- `generateJson()` parses model text with strict `JSON.parse`. Parse failures propagate; the
  Phase 1 validator must never be relaxed to make output pass.

## 2. Settings contract (`settings.ai.interview`)

```ts
settings.ai.interview?: {
  provider: string;
  model: string;
}
```

Frozen rules (all covered by `__tests__/interviewSettings.spec.ts`):

- `ai.interview` is optional. Legacy payloads without it parse normally; `getInterviewConfig()`
  returns `undefined`.
- The interview pair is NEVER populated from global `ai.provider` / `ai.model`. No global
  provider fallback, no global model fallback, no Ollama fallback, no silent default.
- Provider/model must both be non-empty trimmed strings; whitespace-only counts as missing.
- `parseUserSettingsJson()` is tolerant: invalid JSON yields global defaults with no interview
  config; unknown keys are ignored.
- Writes preserve the existing interview config across partial global-AI updates
  (`mergeAiSettingsForUpdate`). An explicit `interview` key sets/replaces (valid pair stored,
  anything else clears); omitting the key preserves. `updateInterviewAiSettings()` validates
  without writing on empty input; `clearInterviewAiSettings()` clears while preserving global AI.

This is a JSON-contract extension of the existing `UserSettings.settings` string column, so no
Prisma migration is required.

## 3. `getInterviewModel(userId)`

`userId -> UserSettings.settings.ai.interview -> validate -> getModel(provider, model, userId)
-> { model, provider, modelName, provenance }`.

- Missing `ai.interview` / provider / model throws `INTERVIEW_MODEL_NOT_CONFIGURED`
  **without calling `getModel()`**.
- Unknown interview provider throws `INTERVIEW_MODEL_NOT_CONFIGURED` without calling `getModel()`
  (checked against `PROVIDER_REGISTRY` first).
- Credential errors raised by shared `getModel()` propagate unchanged.
- Empty/blank `userId` throws `INTERVIEW_MODEL_NOT_CONFIGURED`.
- The default DB loader is a point query (`userSettings.findUnique`, `settings` only);
  tests inject `loadSettingsJson` / `getModelFn` doubles so no real DB or key is needed.

## 4. Adapters

### 4.1 User ownership (`userAdapter.ts`)

Authority is always `User.id`; owner and actor must be exactly equal or `SESSION_FORBIDDEN`
is thrown. No fallback identity (no tester_code, no username matching). Mirrors the Phase 1
`assertSameUser` semantics (`CROSS_USER_RELATION` stays available as a code for relation-level
rejects).

### 4.2 Question snapshot (`questionAdapter.ts`, ADAPTERABLE_DRIFT)

Binds the living Vocatrya `Question` (`question / answer? / createdBy / createdVia` + `Tag[]`)
to the frozen domain snapshot without any new storage:

- `id` -> `questionId` + `sourceQuestionId`
- `question` (trimmed, non-empty) -> `displayedText`
- `answer` -> `referenceAnswerSnapshot` (`null` when absent/blank)
- `Tag[]` (`value` preferred, `label` fallback) -> `tags` (deduped, locale-sorted) +
  `category` (first tag or `null`)
- `createdVia` copied verbatim as provenance

Ownership verified (`SESSION_FORBIDDEN` on cross-user), missing row is `QUESTION_NOT_FOUND`,
empty text is `QUESTION_INVALID`. Pure mapper + ownership-checked DB loader; never writes.

### 4.3 Job / JD resolver (`jobJdResolver.ts`, MATCH)

Frozen pair rule, read-only:

- Both ids absent -> PASS with an empty context.
- Exactly one present -> `JOB_PAIR_REQUIRED`.
- Job missing -> `JOB_NOT_FOUND`; job not owned by the user -> `SESSION_FORBIDDEN`.
- JD missing -> `JD_NOT_FOUND`; JD belonging to another job -> `JOB_JD_MISMATCH`.
- Valid pair -> frozen context (`jobOpportunityId, jobDescriptionVersionId, jobTitle,
  jdVersionNumber, jdContentHash`). Never auto-selects `currentJdVersionId`, never writes Job/JD rows.

## 5. Compatibility matrix (required)

| Phase 1 assumption | Current Vocatrya fact | Classification | Phase 2 action | Phase 3 action |
| --- | --- | --- | --- | --- |
| User identity | `User.id` is the single authority; cross-user equality is a service-layer invariant | MATCH | `userAdapter.ts` asserts exact `User.id` equality | Reuse as session owner FK |
| Question ownership | `Question.createdBy -> User.id`, index on `createdBy` | MATCH | Ownership-checked loader; cross-user -> `SESSION_FORBIDDEN` | Reuse for instance sourcing |
| Question text | `Question.question: String` (required) | ADAPTERABLE_DRIFT | Map to `displayedText` (trimmed, non-empty enforced) | None (snapshot only) |
| Reference answer | `Question.answer: String?` (nullable) | ADAPTERABLE_DRIFT | Map to `referenceAnswerSnapshot` (`null` when blank) | None (snapshot only) |
| Tags / category | `Tag` has `value/label/unique(value, createdBy)`; `Question.tags: Tag[]`; no category column | ADAPTERABLE_DRIFT | Sorted `tags` + derived `category` (first tag) | Decide whether session/instance rows need a persisted category copy |
| Job ownership | `JobOpportunity.userId -> User.id`, index on `(userId, status)` | MATCH | `SESSION_FORBIDDEN` on cross-user job | Reuse as session job FK target |
| JD relation | `JobDescriptionVersion.jobOpportunityId`, unique `(jobOpportunityId, versionNumber)` and `(jobOpportunityId, contentHash)`, `OpportunityCurrentJd` relation | MATCH | Pair validation incl. `JOB_JD_MISMATCH`; no auto-select of `currentJdVersionId` | Reuse pair as frozen session context |
| `settings.ai.interview` | Did not exist; added as optional JSON sub-object on the existing `settings` string column | ADAPTERABLE_DRIFT | Parser/validation/merge + `update/clearInterviewAiSettings` actions | None (no migration needed) |
| Model resolution | Shared `getModel(provider, model, userId)` + `resolveApiKey` + `PROVIDER_REGISTRY` + encryption path | MATCH | `getInterviewModel()` delegates; no second provider/key stack | Reuse for all transplanted services |
| Provider provenance | Host AI layer carries key/base-URL material internally | ADAPTERABLE_DRIFT | Boundary provenance narrowed to `{ provider, model }` + no-credentials guard | Keep the narrow contract |
| Phase 1 Prisma relations | Session/instance/bank/generation models, relations, FKs, enums do not exist in `prisma/schema.prisma` | REQUIRES_SCHEMA_CHANGE | `DO NOT IMPLEMENT`; recorded in `docs/interview-transplant-plan.md` | Design + migrate in Phase 3 |
| QuestionBank ownership | No bank model/ownership exists on the host | REQUIRES_SCHEMA_CHANGE | No bank code in Phase 2 | Define bank ownership + seed/preset wiring in Phase 3 |
| Structured output shape | Phase 1 feedback-item validator (evidence + explanation) | MATCH (probe) | Mock-only probe validates a strict local copy of the item schema | Real-provider probe stays opt-in until credentials are authorized |
| Cross-cutting semantics | No conflicting host business semantics found for identity, ownership, question/JD reads, or model delegation | SEMANTIC_CONFLICT | None — no conflicts detected, nothing halted | Reassess at transplant time if host semantics change |

No item is left as a bare "compatible": every row names the fact, the classification, and the action.

## 6. Structured-output probe (`__tests__/interviewStructuredOutput.spec.ts`)

- Default automated path is MOCK ONLY: a deterministic mock payload shaped like the frozen Phase 1
  commercial feedback item is validated against a strict local `zod` copy of the item schema.
- Real-provider probe (Vercel AI SDK -> OpenRouter -> Claude) is opt-in via
  `INTERVIEW_REAL_PROBE=1` and skips otherwise; the suite never requires a real API key.
- A real-probe failure must surface as `BLOCKED / OPENROUTER_CLAUDE_STRUCTURED_OUTPUT_INCOMPATIBLE`;
  the validator is never relaxed.

## 7. Validation record (this run)

- `npx tsc --noEmit`: exit 0, clean.
- `eslint` on all 14 touched/new source+spec files: exit 0, clean.
- `git diff --check`: clean.
- New specs (4 files): 32/32 pass.
- Regression: `providers`, `provider-registry`, `api-key-resolver`, `openrouter-models-route`,
  `verify-api-key-route`, `agentChatRoute`, `AgentChatProvider`, `ats-runner`,
  `greenhouse-runner` — 9 files, 118/118 pass. `provider-registry-server` + restored
  `interviewReflection.actions` also pass.
- Untouched: `prisma/schema.prisma`, `prisma/migrations/*`, real `dev.db`,
  `%LOCALAPPDATA%/Vocatrya`, the InterviewDx port workspace and original repo.
- Known pre-existing environment failure (out of scope, documented, not caused by this change):
  `migrateDeploy`-based specs (`interviewReflection.migration`, and identically the untouched
  `processStepDeadlineAt.migration`) fail in this sandbox with an empty
  `Schema engine error:` from the Prisma CLI before any adapter code runs. The migration spec
  file itself is byte-identical to `HEAD`.
