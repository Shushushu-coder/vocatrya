# M3 Hosted Managed AI — Subscription / Entitlement / Quota / Durable Usage

This is a separate trusted service, not a route in the desktop Next server.
Deploy only its compiled service and shared wire contract on Node 22.13 or
newer. It has no runtime npm dependencies. TLS termination, the authority
database and gateway secrets belong to the hosted deployment.

M3 adds the hosted commercial authority on top of the M2 hosted identity and
binding authority: normalized Subscription, versioned Plan policy, derived
Entitlement, atomic quota admission, and a durable invocation ledger with
idempotent admission and conservative unknown settlement. No payment
provider, price, plan product values, or subscription UI are selected here.

## Build and validate

From the repository, install the existing locked dependencies, then:

```sh
npm --prefix services/managed-ai test
npm --prefix services/managed-ai run typecheck
npm --prefix services/managed-ai run build
npm --prefix services/managed-ai run lint
```

Deploy `services/managed-ai/dist/`. The entry point within that directory is
`services/managed-ai/src/main.js`; the shared contract is `src/lib/ai/managed-contract.js`.
Do not copy this package into the desktop application. The desktop assembly
scans the actual backend/resources and rejects hosted code and key markers.

## Public origin

`REVISION: BETA2_MANAGED_ENDPOINT_SHUCUBED` — the beta.2 managed hosted
endpoint is `https://managed.shucubed.xyz`. It supersedes
`https://managed.vocatrya.com`, which was never registered; the internal beta
uses the existing `shucubed.xyz` domain. TLS terminates at the ingress in
front of the single active service instance; the service itself keeps
listening on `PORT` and performs no host or origin validation of its own.

## Hosted deployment configuration

Set these variables only in the hosted process:

| Variable | Purpose |
| --- | --- |
| `MANAGED_AI_BASE_URL` | HTTPS OpenAI-compatible gateway API root, typically ending `/v1` |
| `MANAGED_AI_API_KEY` | Hosted deployment secret |
| `MANAGED_AI_DATABASE_PATH` | Absolute path to a persistent hosted SQLite database on a private volume |
| `MANAGED_AI_CATALOG_PATH` | Absolute path to reviewed, versioned server catalog JSON |
| `MANAGED_AI_PLAN_PATH` | Absolute path to reviewed, versioned server plan policy JSON |
| `MANAGED_AI_ENABLED` | Must equal `true` in addition to the catalog switch |
| `MANAGED_AI_UNKNOWN_SETTLEMENT_MS` | Optional unknown-reconciliation grace, 1000–3600000 ms, default 60000 |
| `PORT` | Listener port, default 8787, behind TLS ingress |

`catalog.example.json` and `plans.example.json` are synthetic and disabled by
default. Replace mappings in the hosted deployment and version catalog,
mapping and plan revisions. Startup validates model catalog, plan config,
schema and gateway config together; invalid configuration stops startup.

## Schema migrations

The store runs an ordered, versioned migration runner
(`HostedSchemaMigration`). Opening a fresh database creates the latest schema;
opening an existing M2 database upgrades it in place without a destructive
reset. Reapplying migrations is idempotent. Never add `CREATE TABLE IF NOT
EXISTS` outside the migration list.
Historical M2 columns, PK/FK, unique indexes and binding immutability trigger
are validated before adoption; registered versions are also validated on open.
Damaged schemas fail closed. Migration metadata commits only after validation.

## Subscription and operator CLI

Subscription status is one of `ACTIVE`, `PAST_DUE`, `CANCELED`, `EXPIRED`.
Only a trusted operator mutates it. The compiled `operator-cli.js` exposes:

```sh
node dist/services/managed-ai/src/operator-cli.js provision-subscription <hostedUserId> <planKey> <periodStart> <periodEnd> [--status ACTIVE]
node dist/services/managed-ai/src/operator-cli.js set-subscription <hostedUserId> <planKey> <status> <periodStart> <periodEnd> [--source X] [--external-ref X] [--source-revision X] [--cancel-at-period-end] [--dry-run]
node dist/services/managed-ai/src/operator-cli.js revoke-subscription <hostedUserId> [--dry-run]
```

It validates the plan key against the deployed plan policy and the status
against the allowed set, complete period and existing HostedUser. Provision
the user/session separately first. `--dry-run` opens an existing database
read-only, validates the intended mutation and never creates or migrates a DB.
Same source + revision + normalized payload is an idempotent no-op; changed
payload under that revision is `SOURCE_REVISION_CONFLICT`. All payload fields,
including external reference, are compared under the write lock. Revisions
are opaque identifiers and are never ordered lexicographically. There is
no authenticated HTTP endpoint that changes a subscription.

## Plan policy is the sole entitlement authority

`ManagedPlan` has `planKey`, `managedAiEnabled`, `allowedModels`,
`periodQuotaUnits` and `modelUsageUnits`. The catalog `planRequirement` field
is metadata only. Entitlement is derived per request from the authenticated
user's current Subscription, the versioned plan policy and the current time;
it is never persisted. Quota uses abstract integer `units`, never tokens or
currency. A quota period is frozen to the subscription period and records the
`planKey` and `planRevision` it was created with; updating the plan policy
never silently rewrites an in-flight period.

## Invocation admission, idempotency and settlement

Authenticated invocation endpoints (`/v1/text`, `/v1/stream`,
`/v1/structured`) require durable `operationId`, `invocationKey` and
`attemptIndex`; a caller without a stable identity fails closed with
`INVOCATION_ID_REQUIRED`. The operation must identify a durable business
operation, not an assignment or binding. Transport retries reuse its binding,
invocation key and attempt index. Structured repair increments attemptIndex
with a separate key; regeneration supplies a new operationId. Validation of
identity precedes binding mutation. Binding defaults to the operation resource
when the caller supplies no durable resource.

Admission order: hosted auth → binding ownership/catalog/capability →
`BEGIN IMMEDIATE` → unique invocation/hash replay → current subscription →
derived entitlement/model allow-list → exact quota period → reservation →
`COMMIT` → gateway network → short settlement transaction. The plan snapshot
is immutable for this service instance; subscription and time are read once
for admission. Replays do not reserve units or consult an exhausted quota.
No network call happens inside the authority database transaction. Hashing
uses canonical JSON with sorted object keys and includes endpoint mode,
structured schema, business/resource, operation/attempt, frozen upstream model
and output limit; transport IDs, timestamps and credentials are excluded.

The lifecycle is `NEW → RESERVED → RUNNING → SUCCEEDED / FAILED / UNKNOWN`.
NEW is an unpersisted request. Settlement is `RESERVED → COMMITTED / RELEASED`.
One `settleInvocation` primitive applies a settlement CAS and counter changes
in the same transaction. Only a successful CAS changes counters. COMMITTED
and RELEASED are terminal, and late results cannot overwrite terminal truth.
An unusable generated response is FAILED with COMMITTED accounting.
Hosted status describes upstream execution/response validation; subsequent
local structured-schema validation has its own business result and does not
rewrite Hosted execution truth or refund an executed invocation.

`UNIQUE(hostedUserId, invocationKey)` is the accounting idempotency gate.
Same key + same request re-executes nothing; same key + different request is
`INVOCATION_CONFLICT`; an `UNKNOWN` row is never retried. Success commits
quota; a proven pre-dispatch rejection releases it; an executed-but-invalid
response commits it. Generic 400/401/403/408/409/425/429/5xx, network and timeout
after dispatch become UNKNOWN with reservation preserved. HTTP status alone
is not proof of no execution. UNKNOWN never transitions to RELEASED from a
late rejection. Startup recovers abandoned `RUNNING`/`RESERVED` rows to `UNKNOWN`, and
stale `UNKNOWN` rows are conservatively committed after the grace interval —
never released, so crash/retry can never become a free repeat call.
The interval starts at UNKNOWN/recovery time. Repeated reconciliation and late
completion are accounting no-ops after commit.

One active Hosted service per SQLite DB is enforced before startup recovery
using an exclusive OS-released SQLite lock on the separate adjacent
`.service-lock` file. This lock contains no authority data and does not block
operator/admission transactions. Process exit/crash releases ownership. Keep
that file on the same private local volume; multiple active services against
one DB are rejected. Hard-link aliases and network filesystems are unsupported.

Responses distinguish EXECUTED, REPLAYED, IN_PROGRESS and UNKNOWN. Completed
replays return receipts rather than stored model output. The local client and
dispatcher preserve typed receipts on INVOCATION_REPLAYED,
INVOCATION_IN_PROGRESS or INVOCATION_STATUS_UNKNOWN; callers must not invent
a new key to obtain a second execution.

## Public DTO endpoints

`GET /v1/me/entitlement` returns derived status, plan, allowed models, period
and quota summary. `GET /v1/me/usage` returns the current period summary only
— never the internal ledger, prompt, response, gateway credential, or another
user's data.
Both DTOs read a consistent subscription/quota snapshot and match exact
`hostedUserId, periodStart, periodEnd`. Before quota creation they report zero
usage for that period. `planRevision` denotes current entitlement policy;
`quotaPlanRevision` denotes the frozen accounting policy, or null before creation.

## Loopback Operator console (V1)

`src/operator/` adds a second, separately-authenticated listener for the
platform owner. It binds `127.0.0.1` only (default `OPERATOR_LISTEN_PORT`
8790) and is intended to be reached over an owner-authorized SSH local
forward — never through the public ingress. It shares the authority database
with the hosted service but is its own credential domain:

- `OperatorCredential` long-lived secrets are issued exclusively by
  `operator-bootstrap` over SSH and printed exactly once; only SHA-256
  digests persist. `OperatorSession` tokens (`ops_` + 43 chars) are exchanged
  for a credential at `POST /operator/v1/session` and shown once.
  Hosted (`Bearer <43>`) and operator token formats are disjoint by
  construction, so neither authenticates against the other authority.
- `OperatorAudit` records every write, every login outcome, probes and
  runtime changes. Audit detail is whitelisted — never tokens, secrets,
  prompts or responses.
- The console is a self-contained static shell (no CDN) under
  `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`,
  `no-store`, `nosniff`, `no-referrer`, and emits no CORS headers.

Management writes currently implemented: subscription
provision/set/revoke (idempotent through an explicit `idempotencyKey`
carried as `sourceRevision`, source `OPERATOR_CONSOLE`), hosted session
issue/revoke (token displayed once), staged catalog upload (validated,
one row per revision, **no activation path exists**), provider
connectivity probe (unauthenticated `HEAD` to the provider origin only),
and the runtime kill switch.

The kill switch is a durable `ManagedAiRuntimeState` row read inside the
`BEGIN IMMEDIATE` reservation transaction, so the decision is atomic with
quota admission: while disabled, only *new* invocations fail with
`MANAGED_AI_DISABLED`; already-admitted invocations still settle normally
and idempotent replays still return receipts. A missing/unreadable state
fails closed. Disable requires a reason; both transitions are audited.

The surface cannot: expose or change the platform upstream key, activate
a staged catalog, restart services, rewrite usage/ledger rows (UNKNOWN
history is read-only here), or promote hosted/desktop users to operator.

```sh
node dist/services/managed-ai/src/operator/bootstrap-cli.js create-credential owner
MANAGED_AI_DATABASE_PATH=… MANAGED_AI_CATALOG_PATH=… MANAGED_AI_PLAN_PATH=… \
  node dist/services/managed-ai/src/operator/main.js   # listens on 127.0.0.1:8790
```

## Deferred to M4/M5/M6

No payment provider (Stripe/Paddle/WeChat/Alipay), no plan product values, no
subscription or usage UI, no business migration of Interview / Career
Dialogue / Resume / Match, and no real gateway E2E. Real gateway
interoperability remains deferred to M6.
