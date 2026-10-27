import "server-only";
import prisma from "@/lib/db";
import { parseSettingsDocument } from "./patch";
import { resolveUserTimeZone } from "./timeZone";

/**
 * P-TZ server read entry: the caller's account time zone for one
 * request/operation. Returns the stored canonical IANA zone, or the
 * runtime zone when unset — `parseSettingsDocument` +
 * `resolveUserTimeZone` make corrupt/dirty documents fall back instead
 * of throwing, so a hand-edited row cannot crash callers. The resolved
 * zone is a read-time value only: it is never written back.
 *
 * Server actions, read models and services call this once at their
 * entry point and pass the result explicitly into src/lib/datetime
 * consumers — nothing deeper in the stack should substitute
 * runtimeTimeZone() for account semantics.
 */
export async function getUserTimeZone(userId: string): Promise<string> {
  const row = await prisma.userSettings.findUnique({
    where: { userId },
    select: { settings: true },
  });
  return resolveUserTimeZone(parseSettingsDocument(row?.settings));
}
