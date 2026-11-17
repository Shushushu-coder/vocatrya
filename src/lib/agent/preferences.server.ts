import "server-only";
import prisma from "@/lib/db";
import { readAgentPreferences } from "./preferences";

export async function loadAgentPreferences(userId: string) {
  const row = await prisma.userSettings.findUnique({ where: { userId }, select: { settings: true } });
  let document: unknown = null;
  try { document = row ? JSON.parse(row.settings) : null; } catch { /* Invalid historical preferences use safe defaults. */ }
  return readAgentPreferences(document);
}
