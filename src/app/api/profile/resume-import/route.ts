import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/db";
import { assertResumeV1Writable } from "@/lib/career/capabilities";
import { extractText, sniffFileType } from "@/lib/ai/import/extract-text";
import { preprocessText } from "@/lib/ai/tools/preprocessing";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import { APP_CONSTANTS } from "@/lib/constants";
import { CANONICAL_IMPORT_PROMPT } from "@/lib/ai/resume-import/canonicalPrompt";
import { safeImportName, validateResumeImport } from "@/lib/career/resumeImportContract";
import { canonicalImportJsonSchema } from "@/lib/ai/resume-import/canonicalSchema";
import { inspectResumeImport, persistResumeImport } from "@/lib/career/canonicalResumeImport";
import { issueImportApproval, readImportApproval } from "@/lib/career/resumeImportApproval";

const schema = canonicalImportJsonSchema();
const fail = (code: string, status = 422) => NextResponse.json({ code }, { status });

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
      return NextResponse.json({ variantId: variant.id });
    } catch {
      return fail("SAVE_FAILED", 409);
    }
  }
  if (!checkRateLimit(userId).allowed) return fail("RATE_LIMITED", 429);
  // Refuse oversized requests before parsing multipart where length is available.
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > APP_CONSTANTS.MAX_RESUME_FILE_SIZE_BYTES + 65536) return fail("FILE_TOO_LARGE", 413);
  let file: File;
  try {
    const form = await req.formData();
    const uploaded = form.get("file");
    if (!(uploaded instanceof File)) return fail("UNSUPPORTED_FORMAT");
    file = uploaded;
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
    const result = await executeStructuredForAssignment({
      userId, purpose: "RESUME", schema, schemaName: "canonical_resume_import",
      prompt: `${CANONICAL_IMPORT_PROMPT}\n\n<resume_source>\n${rawText}\n</resume_source>`,
      timeoutMs: APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS)]),
    });
    // Managed RESUME / GLOBAL_DEFAULT assignment. Broken explicit assignments never fall back.
    if (result.status !== "OK") return fail(result.status === "NOT_CONFIGURED" ? "AI_NOT_CONFIGURED" : "AI_PARSE_FAILED", 502);
    const parsed = validateResumeImport(result.value, rawText);
    const name = safeImportName(file.name);
    const summary = await inspectResumeImport(prisma, userId, parsed);
    const approval = issueImportApproval({ userId, name, rawText, parsed,
      resolvedConnectionId: result.resolvedConnectionId, resolvedModel: result.resolvedModel });
    return NextResponse.json({ parsed, rawText, name, summary, approval });
  } catch { return fail("AI_PARSE_FAILED", 502); }
}
