/**
 * BYOK CredentialStore — the backend half of the OS-envelope storage
 * contract from BYOK_WINDOWS_SECURE_STORAGE_MIGRATION_DESIGN.md.
 *
 * ApiKey stays the single credential authority; the `iv` column doubles
 * as the format discriminator so no schema change is needed:
 *
 *   iv === ""        → non-sensitive plaintext passthrough (Ollama URL)
 *   iv === "os:v1"   → encryptedKey is base64(safeStorage ciphertext),
 *                      unsealed only by the Electron-main broker (DPAPI)
 *   iv contains "."  → v1 per-record salt PBKDF2 + AES-256-GCM
 *   iv otherwise     → legacy fixed LEGACY_SALT PBKDF2 + AES-256-GCM
 *
 * Write policy: a desktop backend (VOCATRYA_CREDENTIAL_URL injected by
 * Electron main) must seal through the broker or fail — it NEVER degrades
 * to the shared application cipher or plaintext on a Windows build. A
 * backend without the URL (web/docker/next dev) keeps the existing v1
 * application-cipher contract unchanged.
 *
 * Nothing here logs, returns, or stores plaintext anywhere but the
 * resolved return value of resolveApiKeySecret — which exists only so the
 * backend can hold a key for the single provider request being executed.
 */
import "server-only";

import { decrypt, encrypt } from "@/lib/encryption";

export const OS_ENVELOPE_IV = "os:v1";
const OS_ENVELOPE_IV_PREFIX = "os:";
const BROKER_TIMEOUT_MS = 5_000;
const MAX_SEAL_PLAINTEXT_BYTES = 8 * 1024;
const MAX_BLOB_CHARS = 44 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const CREDENTIAL_STORE_ERROR_CODES = {
  CREDENTIAL_STORE_UNAVAILABLE: "CREDENTIAL_STORE_UNAVAILABLE",
  CREDENTIAL_DECRYPT_FAILED: "CREDENTIAL_DECRYPT_FAILED",
} as const;
export type CredentialStoreErrorCode =
  (typeof CREDENTIAL_STORE_ERROR_CODES)[keyof typeof CREDENTIAL_STORE_ERROR_CODES];

/**
 * Stable-code credential store failure. The message is fixed text by
 * construction — broker codes, ciphertext, and plaintext are never
 * interpolated into it.
 */
export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode;

  constructor(code: CredentialStoreErrorCode) {
    super(
      code === CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_DECRYPT_FAILED
        ? "The stored credential cannot be decrypted in this OS context"
        : "The OS-backed credential store is unavailable",
    );
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

export interface CredentialStoreDeps {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Test seam for the loopback broker call. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CredentialStoreStatus {
  /** os-backed: desktop broker channel; app-cipher: web/docker/dev AES. */
  mode: "os-backed" | "app-cipher";
  /** True when new credentials can be sealed right now. */
  available: boolean;
  /** OS storage backend reported by the broker (e.g. "dpapi"), if known. */
  backend: string | null;
}

/** The `iv` value marks an OS-envelope row. */
export function isOsEnvelopeIv(iv: string | null | undefined): boolean {
  // "os" (bare) is accepted so a row written with the unversioned marker
  // never gets misclassified into the legacy fixed-salt branch.
  return (
    typeof iv === "string" && (iv === "os" || iv.startsWith(OS_ENVELOPE_IV_PREFIX))
  );
}

/** A sensitive row that is NOT yet OS-envelope — the migration candidate set. */
export function credentialNeedsOsMigration(row: { iv: string }): boolean {
  return row.iv !== "" && !isOsEnvelopeIv(row.iv);
}

/**
 * The application cipher cannot run because ENCRYPTION_KEY is absent —
 * an environment outage (missing desktop secret / misconfigured env),
 * NOT a broken credential. Verify/migrate paths map this to
 * "unavailable" instead of "credential lost".
 */
export function isCipherKeyUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === "ENCRYPTION_KEY is not set";
}

function envOf(deps: CredentialStoreDeps): Record<string, string | undefined> {
  return deps.env ?? (process.env as Record<string, string | undefined>);
}

/** Desktop-ness marker: the URL is only ever injected by Electron main. */
export function isCredentialBrokerConfigured(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env.VOCATRYA_CREDENTIAL_URL;
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Strict loopback validation, same contract as the hosted-session client:
 * http, 127.0.0.1, no userinfo, no query, no hash. A malformed injected
 * value is a desktop misconfiguration — it must fail closed as
 * UNAVAILABLE rather than silently select the application cipher.
 */
function brokerBase(env: Record<string, string | undefined>): string {
  const raw = env.VOCATRYA_CREDENTIAL_URL?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  return url.origin;
}

function brokerToken(env: Record<string, string | undefined>): string {
  const token = env.VOCATRYA_DESKTOP_INTERNAL_TOKEN?.trim();
  if (!token) {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  return token;
}

/**
 * One broker round-trip. Maps every failure onto the two stable store
 * codes: DECRYPT_FAILED only when the broker explicitly reports it;
 * transport/auth/shape/5xx problems are all STORE_UNAVAILABLE.
 */
async function callBroker(
  deps: CredentialStoreDeps,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const env = envOf(deps);
  const base = brokerBase(env);
  const token = brokerToken(env);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? BROKER_TIMEOUT_MS),
    });
  } catch {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const code =
      parsed && typeof parsed === "object"
        ? (parsed as { code?: unknown }).code
        : undefined;
    throw new CredentialStoreError(
      code === CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_DECRYPT_FAILED
        ? CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_DECRYPT_FAILED
        : CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { ok?: unknown }).ok !== true
  ) {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  return parsed as Record<string, unknown>;
}

function isCanonicalBase64(value: unknown, maxChars: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    return false;
  }
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

/**
 * Where credentials seal right now. Without the desktop URL this reports
 * the app-cipher contract and whether it can actually run (ENCRYPTION_KEY
 * present); with the URL it reports the broker's real OS-store state.
 */
export async function credentialStoreStatus(
  deps: CredentialStoreDeps = {},
): Promise<CredentialStoreStatus> {
  const env = envOf(deps);
  if (!isCredentialBrokerConfigured(env)) {
    return {
      mode: "app-cipher",
      available: typeof env.ENCRYPTION_KEY === "string" && env.ENCRYPTION_KEY.trim().length > 0,
      backend: null,
    };
  }
  try {
    const payload = await callBroker(deps, "GET", "/credential/status");
    return {
      mode: "os-backed",
      available: payload.available === true,
      backend: typeof payload.backend === "string" ? payload.backend : null,
    };
  } catch {
    return { mode: "os-backed", available: false, backend: null };
  }
}

/**
 * Seal a plaintext credential for storage. Desktop backend → broker
 * envelope `{iv: "os:v1"}`; no broker configured → existing v1
 * application cipher. A configured-but-broken broker throws
 * CREDENTIAL_STORE_UNAVAILABLE — never a silent downgrade.
 */
export async function sealApiKeySecret(
  plaintext: string,
  deps: CredentialStoreDeps = {},
): Promise<{ encryptedKey: string; iv: string }> {
  const env = envOf(deps);
  if (!isCredentialBrokerConfigured(env)) {
    const { encrypted, iv } = encrypt(plaintext);
    return { encryptedKey: encrypted, iv };
  }
  if (Buffer.byteLength(plaintext, "utf8") > MAX_SEAL_PLAINTEXT_BYTES) {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  const payload = await callBroker(deps, "POST", "/credential/seal", { plaintext });
  const blob = payload.blob;
  if (!isCanonicalBase64(blob, MAX_BLOB_CHARS)) {
    throw new CredentialStoreError(
      CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  }
  return { encryptedKey: blob, iv: OS_ENVELOPE_IV };
}

/**
 * Resolve a stored ApiKey row to plaintext, dispatching on the `iv`
 * format discriminator. `os:` rows only resolve through the desktop
 * broker; without it they fail UNAVAILABLE (web/docker opening a desktop
 * DB), and a blob the OS context cannot open fails DECRYPT_FAILED —
 * the permanent "foreign user / foreign machine / corrupt" case.
 */
export async function resolveApiKeySecret(
  row: { encryptedKey: string; iv: string },
  deps: CredentialStoreDeps = {},
): Promise<string> {
  if (row.iv === "") return row.encryptedKey;
  if (isOsEnvelopeIv(row.iv)) {
    // An unrecognized os:* revision is unreadable by this build — fail
    // closed rather than guessing at a format.
    if (row.iv !== OS_ENVELOPE_IV) {
      throw new CredentialStoreError(
        CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_DECRYPT_FAILED,
      );
    }
    if (!isCanonicalBase64(row.encryptedKey, MAX_BLOB_CHARS)) {
      throw new CredentialStoreError(
        CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_DECRYPT_FAILED,
      );
    }
    const payload = await callBroker(deps, "POST", "/credential/unseal", {
      blob: row.encryptedKey,
    });
    const plaintext = payload.plaintext;
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw new CredentialStoreError(
        CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_DECRYPT_FAILED,
      );
    }
    return plaintext;
  }
  return decrypt(row.encryptedKey, row.iv);
}
