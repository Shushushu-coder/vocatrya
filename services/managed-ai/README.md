# M2 Hosted Managed AI

This is a separate trusted service, not a route in the desktop Next server.
Deploy only its compiled service and shared wire contract on Node 22.13 or
newer. It has no runtime npm dependencies. TLS termination, the authority
database and gateway secrets belong to the hosted deployment.

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

## Hosted deployment configuration

Set these variables only in the hosted process:

| Variable | Purpose |
| --- | --- |
| `MANAGED_AI_BASE_URL` | HTTPS OpenAI-compatible gateway API root, typically ending `/v1` |
| `MANAGED_AI_API_KEY` | Hosted deployment secret |
| `MANAGED_AI_DATABASE_PATH` | Absolute path to a persistent hosted SQLite database on a private volume |
| `MANAGED_AI_CATALOG_PATH` | Absolute path to reviewed, versioned server catalog JSON |
| `MANAGED_AI_ENABLED` | Must equal `true` in addition to the catalog switch |
| `PORT` | Listener port, default 8787, behind TLS ingress |

The example catalog is deliberately disabled and contains a placeholder
upstream model. Replace the mapping in the hosted deployment and version its
catalog and mapping revisions. Validate before starting; invalid configuration
stops startup. No plan or entitlement enforcement occurs in M2.

Start with `npm --prefix services/managed-ai start`, or run the compiled entry
point directly. Bindings and sessions persist across process restarts. For
this first deployment, use one service instance/private SQLite volume; do not
share SQLite across unrelated hosts or expose the database over HTTP.

## Minimal hosted identity bridge

The trusted hosted operator/identity issuer provisions the hosted account and
a 24-hour opaque session using the compiled `provision-session.js <hosted-account-id>`
command. It uses the same hosted database configuration. Its stdout is the
one-time credential transfer output; do not send it to application logs.
Only its SHA-256 hash is persisted server-side. No public request can issue a
session or select the authenticated user through a body `userId`.

Transfer that session to the desktop's trusted main-process login completion
code. After `app.whenReady()`, import `desktop/main/hosted-session.js` and call
`createHostedSessionStore({ directory, safeStorage }).save(localUserId, token)`.
Use the same directory the main process uses: `path.join(stateRoot(), "hosted-sessions")`.
This is an internal primitive, not renderer IPC. A future hosted login flow
can call it after authenticated login; M2 intentionally adds no product UI.
For developer verification, execute this call in the trusted Electron main
process with the token received in memory, never as a command-line argument,
settings value or environment variable. `clear(localUserId)` removes a local
session; `HostedStore.revokeSession(token)` revokes hosted authority.

The desktop starts a separate loopback credentials broker authenticated by
its per-launch internal bearer. The server-only Next client requests a session
for the current local business user; a different local user receives no token.
The broker only transfers credentials to the local backend. Managed execution
goes directly from that backend to Hosted and never uses an Electron execution
ticket, runtime profile, CLI or persistent pool. Browser code never receives
either credential.

Missing, expired, revoked and forged sessions fail closed. The issuer creates
HostedUser independently of local User IDs; even coincidentally equal strings
do not confer authority. Save fails when OS encryption is unavailable or uses
Electron's insecure `basic_text` fallback. Ciphertext is outside the local
database/uploads backup, and the local backup schema remains unchanged.

## Desktop endpoint and internal bootstrap

Production desktop releases use the reviewed code constant
`https://managed.vocatrya.com`. This defines the deployment target; this change
does not claim that DNS/TLS/service deployment is already provisioned. Change
that constant in release source if the deployment uses another trusted domain.
Normal users cannot edit it. Non-production code allows
`VOCATRYA_DEV_HOSTED_ENDPOINT`, with HTTP restricted to loopback.

After a hosted session is valid, trusted application code can call
`ensureManagedConnectionForLocalUser(localUserId)` to create/revalidate the
frozen `VOCATRYA / MANAGED_GATEWAY / MANAGED` tuple. Public account CRUD and
assignment setters remain protected; business/UI onboarding is deferred.
Core resolution recognizes an internally assigned Managed connection.

`HostedManagedClient.bind(userId, { business, resourceKey, modelKey })` returns
strict M1 provenance. A resource has a single immutable binding. Pass that
provenance to shared text/stream execution for historical resources, and
persist the returned provenance in the existing business lock. A text call
without a resource creates an invocation-specific binding; structured repair
reuses the first attempt's binding. Client provenance is a snapshot: the
Hosted service looks up the binding by its ID and authenticated owner.

## Execution protocol

Authenticated endpoints are `/v1/session`, `/v1/catalog`, `/v1/bindings`,
`/v1/text`, `/v1/structured`, and `/v1/stream`. Catalog DTOs exclude upstream
mapping and deployment secrets. Binding/provenance responses include the
historical mapping required by M1, never credentials or gateway configuration.

Text and structured use a single compatible chat completion invocation.
Structured schema prompting, strict parsing/schema validation and at most one
repair remain in the existing application layer (`PROMPT_AND_VALIDATE`). Both
attempts use the same immutable upstream mapping. The gateway receives no tools.
Gateway SSE is incrementally normalized into Hosted NDJSON, with explicit
completion/error and upstream cancellation on disconnect/consumer return.
Both clients disable redirects. No raw upstream errors, headers or stacks
are returned. No prompt/response logging was added.

Input is bounded by a conservative UTF-8 byte ceiling equal to the catalog's
maxInputTokens (and an absolute 256 KiB prompt limit), rather than trusting a
client token estimate. Gateway max_tokens uses the frozen output bound.
This intentionally may reject some inputs below the advertised token count;
a verified tokenizer can refine this policy later. This is an invocation size
guard, not a quota or usage ledger. Provider usage metadata is not persisted.

Real gateway interoperability is deferred to M6. Synthetic tests cover HTTP,
SSE, auth/expiry/ownership, frozen mappings, disable switches, malformed
responses, model mismatch, rate limits, timeout, redirect safety and abort.
Subscription/entitlement/quota/accounting are M3; complete business migration
is M4; login/onboarding/model/product surfaces are M5.
