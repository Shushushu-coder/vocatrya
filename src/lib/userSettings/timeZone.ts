import { assertValidTimeZone, runtimeTimeZone } from "@/lib/datetime";

/**
 * P-TZ account time zone contract — isomorphic half.
 *
 * `settings.general.timeZone` stores one IANA identifier. The write
 * path (updateSettingsTimeZone) gates on `isSupportedTimeZone` — bare
 * `assertValidTimeZone` is not enough on this runtime: ICU parses
 * abbreviations ("CST" -> America/Chicago), fixed offsets ("+08:00")
 * and single-token aliases ("GMT", "zulu", "PRC") without error, none
 * of which is an IANA ID the contract allows. The shape rule — every
 * TZDB identifier except "UTC" itself is Area/Location — rejects those
 * while still accepting genuine link names ("Asia/Chongqing",
 * "US/Pacific") and the Etc/* fixed-offset zones some ICU builds omit
 * from supportedValuesOf.
 *
 * Read rule (single rule for every consumer): a missing key, null,
 * non-string, or unsupported value counts as "not set" — dirty
 * documents (hand-edited DB rows, restored backups) fall back to the
 * runtime zone instead of crashing. The resolved value is never
 * written back to the settings document.
 *
 * This module imports nothing server-bound: client components may use
 * it on the document returned by getUserSettings(), server code on the
 * parsed UserSettings.settings row.
 */

function rawSupportedTimeZones(): string[] {
  try {
    return typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  } catch {
    return [];
  }
}

/**
 * Canonical IANA IDs for pickers. "UTC" is prepended when the runtime's
 * ICU omits it from supportedValuesOf (Node's default build omits both
 * "UTC" and the whole Etc/* family).
 */
export function listSupportedTimeZones(): string[] {
  const zones = rawSupportedTimeZones();
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/**
 * True iff `value` is usable as the account time zone: a string Intl
 * resolves as an IANA identifier, in Area/Location shape or exactly
 * "UTC". Rejects what ICU tolerates but the contract forbids —
 * abbreviations ("CST"), bare offsets ("+08:00") and bare aliases
 * ("GMT", "zulu"). Genuine Area/Location links are accepted: they are
 * real TZDB entries and formatting them is unambiguous.
 */
export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value !== "UTC" && !value.includes("/")) return false;
  try {
    assertValidTimeZone(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The persisted zone, or null when the document does not carry a
 * usable one. Accepts the `data.settings` object getUserSettings
 * returns (same shape as the stored JSON document). Never throws.
 */
export function storedUserTimeZone(settingsDoc: unknown): string | null {
  if (typeof settingsDoc !== "object" || settingsDoc === null) return null;
  const settings = (settingsDoc as Record<string, unknown>).settings;
  if (typeof settings !== "object" || settings === null) return null;
  const general = (settings as Record<string, unknown>).general;
  if (typeof general !== "object" || general === null) return null;
  const timeZone = (general as Record<string, unknown>).timeZone;
  return isSupportedTimeZone(timeZone) ? timeZone : null;
}

/**
 * The zone every consumer must use: the stored zone, or the runtime
 * zone when unset/dirty. Callers resolve once at their entry point and
 * pass the result explicitly into src/lib/datetime functions.
 */
export function resolveUserTimeZone(settingsDoc: unknown): string {
  return storedUserTimeZone(settingsDoc) ?? runtimeTimeZone();
}

/**
 * "GMT+08:00"-style label for pickers, derived from Intl's longOffset
 * name. Returns "" when the zone cannot be formatted — callers should
 * still show the bare zone id.
 */
export function timeZoneOffsetLabel(
  timeZone: string,
  at: Date = new Date(),
): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName");
    if (!part) return "";
    return part.value === "GMT" ? "GMT+00:00" : part.value;
  } catch {
    return "";
  }
}
