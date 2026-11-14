import "server-only";

import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { APP_CONSTANTS } from "@/lib/constants";
import { extractAgentFile } from "@/lib/agent/agentFiles.server";
import { sanitizeAgentFileName } from "@/lib/agent/agentFiles";

// AWU-FILES extraction endpoint. The client uploads each picked file once,
// the server returns the extracted text that the data-file part then carries
// — so the persisted part and the model context hold exactly the text this
// route produced, and no client-side reader ever touches the file.

const ExtractRequestSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.string().max(255).optional().default(""),
  contentBase64: z.string(),
}).strict();

// Base64 inflates by 4/3 — check the envelope before decoding so a giant
// body is rejected before Buffer.from allocates it.
const MAX_BASE64_LENGTH = Math.ceil(APP_CONSTANTS.AGENT_FILE_MAX_BYTES / 3) * 4 + 8;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const rateLimit = checkRateLimit(userId, "chat");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests", code: "RATE_LIMITED" },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }
  const parsed = ExtractRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", code: "INVALID_REQUEST" },
      { status: 400 },
    );
  }
  if (parsed.data.contentBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json(
      { error: "File is too large to attach.", code: "FILE_TOO_LARGE" },
      { status: 413 },
    );
  }
  const buf = Buffer.from(parsed.data.contentBase64, "base64");
  if (buf.length === 0 || buf.length > APP_CONSTANTS.AGENT_FILE_MAX_BYTES) {
    return NextResponse.json(
      { error: "File is too large to attach.", code: "FILE_TOO_LARGE" },
      { status: 413 },
    );
  }

  const name = sanitizeAgentFileName(parsed.data.name);
  const result = await extractAgentFile(buf, {
    name,
    mediaType: parsed.data.mediaType,
  });
  if (!result.success) {
    return NextResponse.json(
      { error: result.error.message, code: result.error.code },
      { status: 422 },
    );
  }
  return NextResponse.json({
    name,
    chars: result.data.text.length,
    truncated: result.data.truncated,
    text: result.data.text,
  });
}
