import { AiProvider } from "@/models/ai.model";
import { defaultUserSettings } from "@/models/userSettings.model";
import { getInterviewConfig } from "@/lib/interview/interviewSettings";
import { validateAgentPreferences } from "@/lib/agent/preferences";

/**
 * C-01.P — atomic JSON patch primitive for `UserSettings.settings`.
 *
 * The previous write path did findUnique → merge → blind upsert: the
 * read-modify-write gap let concurrent writers overwrite each other's
 * changes. This primitive closes that window with an optimistic CAS loop:
 * `updateMany` conditioned on the exact `settings` string that was read.
 * There is no version column (schema is owned by C-01), so the stored JSON
 * document itself is the CAS token.
 *
 * Patch semantics (frozen contract):
 * - The patch root must be a plain object; non-object roots never replace
 *   the whole settings document (SETTINGS_INVALID).
 * - Top-level patch keys are limited to registered namespaces
 *   (USER_SETTINGS_PATCH_NAMESPACES). Unknown document keys are preserved
 *   untouched; unregistered patch keys are rejected.
 * - Merge is a deep object merge: plain objects merge recursively;
 *   scalars, arrays and null replace wholesale; a key present with value
 *   `undefined` deletes that subtree (generalizes the existing
 *   `ai.interview`-clears-on-undefined precedent). `undefined` at the
 *   top level preserves the whole namespace subtree.
 * - Prototype-pollution paths (`__proto__`, `constructor`, `prototype`)
 *   are rejected anywhere in the patch.
 * - `parseUserSettingsJson` is intentionally NOT used here: it rebuilds
 *   {ai, display} and would drop every other namespace.
 *
 * CAS protocol:
 * - Read row → apply patch on the parsed document → `updateMany` with
 *   `where: { userId, settings: <read string> }`. count===1 means our
 *   write won; count===0 means a concurrent write landed first → re-read,
 *   re-merge against the winner's document, retry. Reusing a stale merge
 *   result for a blind write is exactly the lost-update bug being fixed.
 * - Missing row → create with defaults ⊕ patch. A `userId` unique-index
 *   violation (P2002) means another writer created first → re-read the
 *   winner's row and continue the CAS loop instead of overwriting it.
 * - Retry budget: initial attempt + USER_SETTINGS_CAS_MAX_RETRIES
 *   conflict retries → SETTINGS_CONFLICT. Only CAS miss / create-P2002
 *   count as conflicts; every other error propagates untouched.
 */
export const SETTINGS_INVALID = "SETTINGS_INVALID";
export const SETTINGS_CONFLICT = "SETTINGS_CONFLICT";
export type SettingsPatchErrorCode =
  | typeof SETTINGS_INVALID
  | typeof SETTINGS_CONFLICT;

export const USER_SETTINGS_CAS_MAX_RETRIES = 3;

/** Registered top-level namespaces a patch may touch. */
export const USER_SETTINGS_PATCH_NAMESPACES = [
  "ai",
  "display",
  "settings",
  "careerProfile",
  "dictation",
] as const;

export type SettingsDocument = Record<string, unknown>;

type JsonObject = Record<string, unknown>;

const BANNED_PATCH_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const AI_PATCH_KEYS = new Set(["provider", "model", "interview"]);
const DISPLAY_PATCH_KEYS = new Set(["theme"]);
const DISPLAY_THEMES = new Set(["light", "dark", "system"]);
const AI_PROVIDERS = new Set<string>(Object.values(AiProvider));

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasBannedKey(value: unknown, seen = new Set<unknown>()): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    const found = value.some((item) => hasBannedKey(item, seen));
    seen.delete(value);
    return found;
  }
  if (!isPlainObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (BANNED_PATCH_KEYS.has(key)) return true;
    if (hasBannedKey(value[key], seen)) return true;
  }
  seen.delete(value);
  return false;
}

/**
 * Values must round-trip through JSON.stringify unambiguously. `undefined`
 * is only meaningful as an object value (delete marker); inside arrays it
 * would silently serialize as null.
 */
function jsonSafetyViolation(
  value: unknown,
  where: "array" | "object",
  seen: Set<unknown>,
): string | undefined {
  if (value === undefined) {
    return where === "array" ? "undefined inside an array" : undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? undefined : "non-finite number";
  }
  if (seen.has(value)) return "circular reference";
  if (Array.isArray(value)) {
    seen.add(value);
    for (const item of value) {
      const violation = jsonSafetyViolation(item, "array", seen);
      if (violation) return violation;
    }
    seen.delete(value);
    return undefined;
  }
  if (!isPlainObject(value)) return `unsupported value type ${typeof value}`;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const violation = jsonSafetyViolation(value[key], "object", seen);
    if (violation) return violation;
  }
  seen.delete(value);
  return undefined;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue) as T;
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: cloneJsonValue(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}

/**
 * Tolerant document parser: a missing/corrupt/non-object payload yields an
 * empty document so a CAS write repairs rather than crashes. Unknown keys
 * are preserved verbatim — unlike parseUserSettingsJson, nothing is
 * filtered down to {ai, display}.
 */
export function parseSettingsDocument(
  raw: string | null | undefined,
): JsonObject {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export type PreparedSettingsPatch =
  | { ok: true; patch: JsonObject }
  | { ok: false; code: typeof SETTINGS_INVALID; reason: string };

const invalid = (reason: string): PreparedSettingsPatch => ({
  ok: false,
  code: SETTINGS_INVALID,
  reason,
});

/**
 * `ai` keeps its existing per-key semantics: provider/model `undefined`
 * means "leave unchanged" (the old `update.provider ?? current.provider`
 * behavior), while `interview` `undefined` means "clear". An interview
 * value that does not normalize to a provider/model pair also clears —
 * identical to mergeAiSettingsForUpdate, which treats any explicit but
 * unusable interview key as deletion rather than an error.
 */
function prepareAiPatch(ai: JsonObject): PreparedSettingsPatch {
  const patch: JsonObject = {};
  for (const key of Object.keys(ai)) {
    if (!AI_PATCH_KEYS.has(key)) {
      return invalid(`unsupported ai key "${key}"`);
    }
    const value = ai[key];
    if (key === "provider") {
      if (value === undefined) continue;
      if (typeof value !== "string" || !AI_PROVIDERS.has(value)) {
        return invalid("ai.provider is not a known provider");
      }
      patch.provider = value;
    } else if (key === "model") {
      if (value === undefined) continue;
      if (typeof value !== "string") {
        return invalid("ai.model must be a string");
      }
      patch.model = value;
    } else {
      // interview
      if (value === undefined) {
        patch.interview = undefined;
        continue;
      }
      patch.interview = getInterviewConfig({ ai: { interview: value } });
    }
  }
  return { ok: true, patch };
}

function prepareDisplayPatch(display: JsonObject): PreparedSettingsPatch {
  const patch: JsonObject = {};
  for (const key of Object.keys(display)) {
    if (!DISPLAY_PATCH_KEYS.has(key)) {
      return invalid(`unsupported display key "${key}"`);
    }
    const value = display[key];
    if (value === undefined) {
      // Clears the key; readers fall back to the "system" default.
      patch.theme = undefined;
      continue;
    }
    if (typeof value !== "string" || !DISPLAY_THEMES.has(value)) {
      return invalid("display.theme must be light, dark or system");
    }
    patch.theme = value;
  }
  return { ok: true, patch };
}

/**
 * Validate + normalize a caller-supplied patch into a JSON-safe merge
 * payload. Validation is deterministic and document-independent, so it
 * runs once before the CAS loop. `settings.*`, `careerProfile.*` and
 * `dictation.*` are registered namespaces whose per-key rules belong to
 * their owning packages; they merge generically and are only checked for
 * JSON safety.
 */
export function prepareSettingsPatch(input: unknown): PreparedSettingsPatch {
  if (!isPlainObject(input)) {
    return invalid("patch root must be a plain object");
  }
  if (hasBannedKey(input)) {
    return invalid("patch contains a forbidden key path");
  }

  const prepared: JsonObject = {};
  for (const ns of Object.keys(input)) {
    const value = input[ns];
    // A namespace key explicitly set to undefined preserves the subtree —
    // mirroring the old merge where `ai: undefined` never erased `ai`.
    if (value === undefined) continue;
    if (
      !(USER_SETTINGS_PATCH_NAMESPACES as readonly string[]).includes(ns)
    ) {
      return invalid(`unregistered settings namespace "${ns}"`);
    }
    if (!isPlainObject(value)) {
      return invalid(`namespace "${ns}" must be patched with an object`);
    }
    if (ns === "ai") {
      const result = prepareAiPatch(value);
      if (!result.ok) return result;
      if (Object.keys(result.patch).length > 0) prepared.ai = result.patch;
    } else if (ns === "display") {
      const result = prepareDisplayPatch(value);
      if (!result.ok) return result;
      if (Object.keys(result.patch).length > 0) {
        prepared.display = result.patch;
      }
    } else {
      // settings / careerProfile / dictation: generic merge of a validated
      // JSON tree.
      if (ns === "settings" && isPlainObject(value.general) && "agent" in value.general && value.general.agent !== undefined && !validateAgentPreferences(value.general.agent)) {
        return invalid("invalid Agent preferences");
      }
      prepared[ns] = value;
    }
  }

  const violation = jsonSafetyViolation(prepared, "object", new Set());
  if (violation) {
    return invalid(`patch is not JSON-serializable: ${violation}`);
  }
  return { ok: true, patch: prepared };
}

function mergeInto(target: JsonObject, patch: JsonObject): void {
  for (const key of Object.keys(patch)) {
    const patchValue = patch[key];
    if (patchValue === undefined) {
      delete target[key];
      continue;
    }
    const targetValue = target[key];
    if (isPlainObject(patchValue) && isPlainObject(targetValue)) {
      mergeInto(targetValue, patchValue);
    } else {
      target[key] = cloneJsonValue(patchValue);
    }
  }
}

/**
 * Pure deep merge: returns a NEW document; `doc` is not mutated. Patch
 * must come from prepareSettingsPatch (already validated + normalized).
 */
export function mergeSettingsDocument(
  doc: JsonObject,
  preparedPatch: JsonObject,
): JsonObject {
  const next = cloneJsonValue(doc) as JsonObject;
  mergeInto(next, preparedPatch);
  return next;
}

/**
 * Minimal storage surface the CAS loop needs — structurally satisfied by
 * `prisma.userSettings`, injectable for deterministic concurrency tests.
 */
export interface UserSettingsStore {
  findUnique(args: {
    where: { userId: string };
    select: { settings: true };
  }): Promise<{ settings: string } | null>;
  updateMany(args: {
    where: { userId: string; settings: string };
    data: { settings: string };
  }): Promise<{ count: number }>;
  create(args: {
    data: { userId: string; settings: string };
  }): Promise<unknown>;
}

export type SettingsPatchOutcome =
  | { success: true; settings: JsonObject }
  | { success: false; code: SettingsPatchErrorCode; message: string };

const conflict = (): SettingsPatchOutcome => ({
  success: false,
  code: SETTINGS_CONFLICT,
  message:
    "User settings were changed by a concurrent writer; retry limit reached.",
});

/** Prisma signals a unique-index violation as P2002 (here: `userId`). */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export interface PatchUserSettingsOptions {
  /** Conflict retries after the initial attempt (default: 3). */
  maxRetries?: number;
}

/**
 * Apply `patchInput` to the user's settings document atomically.
 *
 * Returns the persisted document on success. SETTINGS_INVALID means the
 * patch was rejected before any database write. SETTINGS_CONFLICT means
 * the CAS retry budget was exhausted by competing writers. Any other
 * persistence error is rethrown — it is not a conflict and must not be
 * reported as one.
 */
export async function patchUserSettings(
  userId: string,
  patchInput: unknown,
  store: UserSettingsStore,
  options: PatchUserSettingsOptions = {},
): Promise<SettingsPatchOutcome> {
  const prepared = prepareSettingsPatch(patchInput);
  if (!prepared.ok) {
    return {
      success: false,
      code: SETTINGS_INVALID,
      message: prepared.reason,
    };
  }
  const maxRetries = options.maxRetries ?? USER_SETTINGS_CAS_MAX_RETRIES;

  for (let attempt = 0; ; attempt++) {
    const row = await store.findUnique({
      where: { userId },
      select: { settings: true },
    });

    if (row === null) {
      // First write: materialize the defaults the old upsert created,
      // then apply the patch on top.
      const next = mergeSettingsDocument(
        cloneJsonValue(defaultUserSettings as unknown as JsonObject),
        prepared.patch,
      );
      try {
        await store.create({
          data: { userId, settings: JSON.stringify(next) },
        });
        return { success: true, settings: next };
      } catch (error) {
        if (!isUniqueConstraintViolation(error)) throw error;
        if (attempt >= maxRetries) return conflict();
        // Someone else created the row first — re-read the winner's
        // document and merge onto it via CAS instead of overwriting.
      }
      continue;
    }

    const expectedRaw = row.settings;
    const doc = parseSettingsDocument(expectedRaw);
    const next = mergeSettingsDocument(doc, prepared.patch);
    const nextRaw = JSON.stringify(next);
    if (nextRaw === expectedRaw) {
      // Nothing to persist — echo the stored document, skip the write.
      return { success: true, settings: doc };
    }

    const { count } = await store.updateMany({
      where: { userId, settings: expectedRaw },
      data: { settings: nextRaw },
    });
    if (count === 1) {
      return { success: true, settings: next };
    }
    if (attempt >= maxRetries) {
      return conflict();
    }
    // CAS miss: loop back, re-read the winning document, re-merge.
  }
}
