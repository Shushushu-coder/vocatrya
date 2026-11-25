import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { LOCALE_COOKIE_NAME, normalizeLocale } from "@/i18n";
import {
  computeConversationContextUsage,
  runManualConversationCompaction,
} from "@/lib/agent/conversationCompaction.server";
import { checkRateLimit } from "@/lib/ai/rate-limiter";

const ManualCompactBodySchema = z
  .object({
    conversationId: z.string().trim().min(1).max(128),
    focusNote: z.string().max(500).optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) {
    return NextResponse.json(
      { error: "Not Authenticated", code: "NOT_AUTHENTICATED" },
      { status: 401 },
    );
  }

  const conversationId = req.nextUrl?.searchParams?.get("conversationId")?.trim() ?? "";
  if (!conversationId) {
    return NextResponse.json(
      { error: "Missing conversationId", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const rawLocale = req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);
  const usage = await computeConversationContextUsage({
    userId,
    conversationId,
    locale,
  });

  return NextResponse.json({ usage });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) {
    return NextResponse.json(
      { error: "Not Authenticated", code: "NOT_AUTHENTICATED" },
      { status: 401 },
    );
  }

  const rateLimit = checkRateLimit(userId, "chat");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`,
        code: "RATE_LIMITED",
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid compaction request.", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const parsed = ManualCompactBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid compaction request.", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  const rawLocale = req.cookies?.get?.(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);
  const result = await runManualConversationCompaction({
    userId,
    conversationId: parsed.data.conversationId,
    focusNote: parsed.data.focusNote,
    locale,
  });

  return NextResponse.json(result, { status: result.httpStatus });
}
