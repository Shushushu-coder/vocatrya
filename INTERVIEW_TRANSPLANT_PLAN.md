# Interview Transplant Plan (Phase 3 — NOT IMPLEMENTED)

Phase 2 deliberately changed no production Prisma model. Every item below is classified
`REQUIRES_SCHEMA_CHANGE`: current Vocatrya fact, Phase 1 requirement, required Phase 3 schema
change, and migration/relation/index implications. No Phase 3 code is written here.

Base: `main @ b05f8ec6a7e64936fef99d15b2547ac429074296`.
Hard boundary reminder: do NOT add these models/migrations inside the Phase 2 change set.

## 1. InterviewSession model (new)

- Current Vocatrya fact: no session model exists. The closest host concepts are
  `JobOpportunity` (the posting, status ACTIVE/CLOSED/EXPIRED/UNKNOWN — never interview state)
  and `ApplicationAttempt` (the application process), neither of which stores interview turns.
- Phase 1 requirement: a per-user session row owning N question-instance rows plus
  `currentQuestionInstanceId`, status lifecycle (incl. archived/read-only), and frozen
  job+JD references (`jobOpportunityId` / `jobDescriptionVersionId`, both-null allowed).
- Required Phase 3 schema change: new `InterviewSession` model with
  `userId -> User.id`, nullable `jobOpportunityId -> JobOpportunity.id`,
  nullable `jobDescriptionVersionId -> JobDescriptionVersion.id`, status/archived fields,
  `currentQuestionInstanceId` self/FK pointer, timestamps.
- Migration implication: additive `CREATE TABLE` migration; no backfill (no legacy session data).
- Relation/index requirements: FKs with `onDelete: Restrict` toward User/Job/JD (host convention
  for opportunity relations); `@@index([userId, status])` mirroring the `JobOpportunity`
  convention; consider `@@index([userId, archivedAt])` following `RecruitmentCampaign`.

## 2. QuestionInstance model (new)

- Current Vocatrya fact: `Question` is a living bank row (`question/answer/tags/createdVia`);
  there is no per-session instance/copy and Phase 2 only produces in-memory snapshots.
- Phase 1 requirement: per-session question-instance rows carrying the frozen
  `displayedText` / `referenceAnswerSnapshot` / tag snapshot plus ordering and linkage back to
  the source question.
- Required Phase 3 schema change: new `QuestionInstance` model with
  `sessionId -> InterviewSession.id`, `sourceQuestionId -> Question.id` (nullable if source
  questions may be deleted — see decision D2), frozen text snapshot columns, sort order.
- Migration implication: additive `CREATE TABLE`; snapshot columns must be non-nullable with
  the freeze-at-creation invariant enforced in service code (host convention keeps evolving
  payloads as serialized JSON, but instance display text should stay a plain column so it
  survives source edits).
- Relation/index requirements: FK to session with `onDelete: Cascade` (instances die with the
  session); `@@index([sessionId, sortOrder])`; `@@index([sourceQuestionId])` for lineage queries.

## 3. QuestionBank model (new) + ownership

- Current Vocatrya fact: no bank model exists; ownership today is per-`Question.createdBy`.
- Phase 1 requirement: a bank construct grouping questions with defined ownership semantics.
- Required Phase 3 schema change: new `QuestionBank` model (`userId -> User.id`, name,
  timestamps) plus an optional `bankId -> QuestionBank.id` on `Question` (nullable to keep
  legacy unbanked questions valid).
- Migration implication: additive tables/columns only; existing `Question` rows keep working
  with `bankId = NULL`.
- Relation/index requirements: bank FK `onDelete: Restrict` or `SetNull` (decision D3);
  `@@index([userId])` on bank; `@@index([bankId])` on question.
- Seed/preset wiring: KB/preset assets (`knowledge/loader`, `presets/*` in the port) transplant
  together with the bank model, never earlier (Phase 2 prohibition stands).

## 4. Generation model (new)

- Current Vocatrya fact: no generation/prompt-run persistence exists for interviews (host AI
  calls are stateless from the schema perspective).
- Phase 1 requirement: persisted generation records (prompt, model/provenance, output or
  pointer, status) backing feedback/summary/coaching reproducibility.
- Required Phase 3 schema change: new `Generation` model keyed to session (+ optional
  question-instance), storing provider/model identifiers, prompt version/hash, status, and
  output or output hash.
- Migration implication: additive `CREATE TABLE`; retention policy must be decided (D4) before
  the table grows unbounded.
- Relation/index requirements: FK to session `onDelete: Cascade`;
  `@@index([sessionId, createdAt])`; large payloads follow the host convention (serialized
  JSON `String` columns, e.g. `JobDescriptionParse.structuredData`).

## 5. Enums / status codes

- Current Vocatrya fact: host convention keeps status/type codes as plain `String`
  (e.g. `JobOpportunity.status`, `Skill.category`); no interview enum exists.
- Phase 1 requirement: session/question/coaching-mode status vocabulary.
- Required Phase 3 approach: follow the host convention — plain `String` columns validated in
  service code (see `INVALID_COACHING_MODE` and friends in the port error catalogue), NOT new
  Prisma enums. Rationale: matches `RecruitmentCampaign`/`JobOpportunity` precedent and avoids
  enum-alter migrations on SQLite.

## 6. Suggested Phase 3 ordering

1. `InterviewSession` + indexes (unblocks session lifecycle).
2. `QuestionInstance` + snapshot-freeze invariant (unblocks practice runs).
3. Transplant feedback/summary/coaching services onto `InterviewModelResolver`
   (no `providers.ts` imports; provenance stays `{ provider, model }`).
4. `Generation` persistence + retention policy.
5. `QuestionBank` + ownership + KB/preset asset transplant.
6. Opt-in real-provider structured-output probe with authorized credentials.

## 7. Open decisions for Phase 3 (D1–D4)

- D1: session delete semantics — cascade instances+generations, or archive-only (host uses both
  patterns: `Cascade` for notes, `Restrict` for opportunity links)?
- D2: instance retention when a source `Question` is deleted — nullable `sourceQuestionId`
  with `SetNull`, or `Restrict` to protect lineage?
- D3: `Question.bankId` delete rule — `Restrict` (force explicit unbank) vs `SetNull`.
- D4: generation retention window and whether raw outputs or hashes are stored long-term.

## 8. Explicit non-goals (still prohibited)

New interview-specific Prisma relations, interview migrations, migration-SQL edits, formal
interview migration runs, real-user data writes, `Question` delete-semantics changes, early
feedback/summary/coaching transplant, early KB/preset asset transplant. Any of these restarts
the Phase 3 gate; none of them may ride along silently.
