import "server-only";
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { assertResumeV1Writable } from "@/lib/career/capabilities";
import { extractText, sniffFileType } from "@/lib/ai/import/extract-text";
import { preprocessText } from "@/lib/ai/tools/preprocessing";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { APP_CONSTANTS } from "@/lib/constants";
import { CANONICAL_IMPORT_PROMPT } from "@/lib/ai/resume-import/canonicalPrompt";
import { safeImportName, validateResumeImport } from "@/lib/career/resumeImportContract";
import { canonicalImportJsonSchema } from "@/lib/ai/resume-import/canonicalSchema";
import { inspectResumeImport, persistResumeImport } from "@/lib/career/canonicalResumeImport";
import { issueImportApproval, readImportApproval } from "@/lib/career/resumeImportApproval";
import {
  executeDurableResumeImport,
  markResumeImportConfirmed,
  RESUME_IMPORT_REQUEST_ID_PATTERN,
} from "@/lib/career/resumeImportAttempt";
import { AIBusinessError } from "@/lib/ai/connections";

const schema = canonicalImportJsonSchema();
const fail = (code: string, status = 422) => NextResponse.json({ code }, { status });

/** Same mapping the sibling canonical route applies to structured failures. */
function structuredErrorStatus(code: string): number {
  if (code === "RUNTIME_NOT_AVAILABLE" || code === "BACKEND_UNAVAILABLE" ||
      code === "MANAGED_RUNTIME_UNAVAILABLE" || code === "MANAGED_BINDING_UNAVAILABLE" ||
      code === "MANAGED_AUTH_REQUIRED") return 503;
  if (code === "AI_EXECUTION_TIMEOUT") return 504;
  if (code === "AI_REQUEST_TOO_LARGE") return 413;
  return 502;
}

/** Same route owns preview and confirm so the ephemeral signing key has one runtime owner. */
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return fail("UNAUTHENTICATED", 401);
  try { await assertResumeV1Writable(prisma); }
  catch { return fail("IMPORT_NOT_ENABLED", 403); }

  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      const { approval } = await req.json();
      const input = readImportApproval(approval, userId);
      const variant = await persistResumeImport(prisma, userId, input);
      await markResumeImportConfirmed(prisma, userId, input.requestId);
      return NextResponse.json({ variantId: variant.id });
    } catch (error) {
      if (error instanceof AIBusinessError) {
        return fail(error.code, structuredErrorStatus(error.code));
      }
      return fail("SAVE_FAILED", 409);
    }
  }
  if (!checkRateLimit(userId).allowed) return fail("RATE_LIMITED", 429);
  // Refuse oversized requests before parsing multipart where length is available.
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES + 65536) return fail("FILE_TOO_LARGE", 413);
  let file: File;
  let requestId: string;
  try {
    const form = await req.formData();
    const uploaded = form.get("file");
    if (!(uploaded instanceof File)) return fail("UNSUPPORTED_FORMAT");
    file = uploaded;
    // Durable import identity (P1-01): the client mints this opaque id
    // before the first request and reuses it on transport retries, so the
    // same logical import always resolves to the same durable attempt.
    const supplied = form.get("requestId");
    if (typeof supplied !== "string" || !RESUME_IMPORT_REQUEST_ID_PATTERN.test(supplied)) {
      return fail("IMPORT_REQUEST_ID_REQUIRED", 400);
    }
    requestId = supplied;
  } catch { return fail("UNSUPPORTED_FORMAT"); }
  if (file.size > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES) return fail("FILE_TOO_LARGE", 413);
  if (!APP_CONSTANTS.RESUME_ALLOWED_MIME_TYPES.some((mime) => mime === file.type)) return fail("UNSUPPORTED_FORMAT");
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = sniffFileType(bytes);
  if ((type === "pdf" && file.type !== "application/pdf") || !type ||
    (type === "docx" && file.type !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) return fail("UNSUPPORTED_FORMAT");
  // Bytes remain in memory: no upload paths, File rows, or temp-file cleanup.
  const extracted = await extractText(bytes);
  if (!extracted.success) return fail(extracted.error.code);
  if (extracted.data.truncated) return fail("TOO_LONG");
  const rawText = extracted.data.text;
  const validation = await preprocessText(rawText);
  if (!validation.success) return fail(validation.error.code);
  try {
    // The durable attempt row exists before the first model call: the
    // request id doubles as the ResumeVariant id (idempotent confirm), a
    // Managed resolution binds `resume-version:<id>` and the operation
    // replays under that identity instead of double-billing a retry.
    const result = await executeDurableResumeImport(prisma, {
      userId,
      requestId,
      requestSha: createHash("sha256").update(rawText).digest("hex"),
      execution: {
        prompt: `${CANONICAL_IMPORT_PROMPT}\n\n<resume_source>\n${rawText}\n</resume_source>`,
        schema, schemaName: "canonical_resume_import",
        timeoutMs: APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS)]),
      },
    });
    // Managed RESUME / GLOBAL_DEFAULT assignment. Broken explicit assignments never fall back.
    // The stable business code propagates verbatim — degrading quota/auth/managed
    // failures to AI_PARSE_FAILED would hide the real cause from the client.
    if (result.kind !== "ok") {
      if (result.code === "NOT_CONFIGURED") return fail("AI_NOT_CONFIGURED", 502);
      return fail(result.code, structuredErrorStatus(result.code));
    }
    const parsed = validateResumeImport(result.value, rawText);
    const name = safeImportName(file.name);
    const summary = await inspectResumeImport(prisma, userId, parsed);
    const approval = issueImportApproval({ userId, name, rawText, parsed,
      resolvedConnectionId: result.resolvedConnectionId, resolvedModel: result.resolvedModel,
      managedAiProvenance: result.managedAiProvenance }, result.attemptId);
    return NextResponse.json({ parsed, rawText, name, summary, approval });
  } catch (error) {
    if (error instanceof AIBusinessError) {
      return fail(error.code, structuredErrorStatus(error.code));
    }
    return fail("AI_PARSE_FAILED", 502);
  }
}
