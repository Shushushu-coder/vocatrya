import "server-only";

import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { streamText, Output } from "ai";
import path from "path";
import fs from "fs";
import { getModel } from "@/lib/ai/providers";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { TEMPERATURES } from "@/lib/ai/config";
import { preprocessText } from "@/lib/ai";
import { extractText } from "@/lib/ai/import/extract-text";
import { ResumeImportSchema } from "@/models/resumeImport.schema";
import { AiModel } from "@/models/ai.model";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { isResumeFilePath } from "@/lib/resumeFiles";
import {
  RESUME_IMPORT_SYSTEM_PROMPT,
  buildResumeImportPrompt,
} from "@/lib/ai/prompts/resume-import";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import {
  RESUME_IMPORT_JSON_SCHEMA,
  RESUME_IMPORT_SCHEMA_NAME,
} from "@/lib/ai/resume-import/structured-schema";
import {
  genAiRequestAttrs,
  genAiResponseAttrs,
  inputSizeAttrs,
  log,
  runInSpan,
  startSpan,
  SURFACES,
} from "@/lib/telemetry";

// Configuration-layer failures (assignment unusable, runtime not verified
// for structured output) are 409; transport unavailability is 503; a timed
// out execution is 504; validation/execution failures are 502.
const STRUCTURED_CONFIG_CODES = new Set([
  "ASSIGNED_CONNECTION_UNAVAILABLE",
  "REAUTH_REQUIRED",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_ERROR",
  "MODEL_UNAVAILABLE",
  "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  "STRUCTURED_OUTPUT_NOT_VERIFIED",
]);

function structuredErrorStatus(code: string): number {
  if (STRUCTURED_CONFIG_CODES.has(code)) return 409;
  if (code === "RUNTIME_NOT_AVAILABLE" || code === "BACKEND_UNAVAILABLE") {
    return 503;
  }
  if (code === "AI_EXECUTION_TIMEOUT") return 504;
  if (code === "AI_REQUEST_TOO_LARGE") return 413;
  return 502;
}

function structuredErrorMessage(code: string): string {
  switch (code) {
    case "STRUCTURED_OUTPUT_NOT_VERIFIED":
      return "The assigned AI runtime is not verified for structured output.";
    case "STRUCTURED_OUTPUT_PARSE_FAILED":
    case "STRUCTURED_OUTPUT_SCHEMA_FAILED":
    case "STRUCTURED_OUTPUT_RETRY_EXHAUSTED":
      return "The AI service returned data that did not match the expected format.";
    case "STRUCTURED_OUTPUT_TRUNCATED":
      return "The AI service output was truncated. Please try again.";
    case "REAUTH_REQUIRED":
      return "The assigned AI connection needs re-authentication.";
    case "CONNECTION_DISCONNECTED":
      return "The assigned AI connection is disconnected.";
    case "ASSIGNED_CONNECTION_UNAVAILABLE":
      return "The assigned AI connection is not available.";
    case "MODEL_UNAVAILABLE":
      return "The assigned AI model is not available.";
    case "AI_EXECUTION_TIMEOUT":
      return `AI request timed out after ${APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS / 1000} seconds. Please try again.`;
    case "RUNTIME_NOT_AVAILABLE":
    case "BACKEND_UNAVAILABLE":
      return "Cannot connect to AI service. Please ensure the service is running.";
    default:
      return "AI request failed";
  }
}

export const POST = async (req: NextRequest) => {
  const session = await auth();
  const userId = session?.user?.id;

  if (!session || !userId) {
    return NextResponse.json({ message: "Not Authenticated" }, { status: 401 });
  }

  const rateLimit = checkRateLimit(userId);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`,
      },
      { status: 429 },
    );
  }

  let body: { resumeId: string; selectedModel?: AiModel };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
  const { resumeId, selectedModel } = body;

  // selectedModel is only required on the legacy API-key path — a resolved
  // RESUME business assignment supplies its own connection + model.
  if (!resumeId) {
    return NextResponse.json(
      { error: "resumeId is required" },
      { status: 400 },
    );
  }

  // Look up the file scoped to this user — never trust client-supplied paths
  const resume = await prisma.resume.findUnique({
    where: { id: resumeId, profile: { userId } },
    select: { File: { select: { filePath: true } } },
  });

  if (!resume?.File?.filePath) {
    return NextResponse.json(
      { error: "No file attached to this resume. Please re-attach the file." },
      { status: 400 },
    );
  }

  // UPLOADS_DIR also holds the database and backup snapshots
  if (!isResumeFilePath(resume.File.filePath)) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }
  const resolvedPath = path.resolve(resume.File.filePath);

  if (!fs.existsSync(resolvedPath)) {
    return NextResponse.json(
      { error: "File not found on disk. Please re-attach the file." },
      { status: 400 },
    );
  }

  const buf = fs.readFileSync(resolvedPath);

  const extractResult = await extractText(buf);
  if (!extractResult.success) {
    return NextResponse.json(
      { error: extractResult.error.message, code: extractResult.error.code },
      { status: 422 },
    );
  }

  const { text, truncated } = extractResult.data;

  const preprocessResult = await preprocessText(text);
  if (!preprocessResult.success) {
    return NextResponse.json(
      {
        error: preprocessResult.error.message,
        code: preprocessResult.error.code,
      },
      { status: 422 },
    );
  }

  const normalizedText = preprocessResult.data.normalizedText;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS,
  );
  req.signal.addEventListener("abort", () => controller.abort());

  // Business Assignment path: a RESUME assignment (or GLOBAL_DEFAULT) runs
  // the managed account runtime through the structured execution seam —
  // strict schema validation with at most one repair retry. An explicit
  // but broken/unverified assignment fails here; only NOT_CONFIGURED falls
  // through to the legacy API-key path below.
  const structuredSpan = startSpan("resume.import", {
    "jobsync.surface": SURFACES.RESUME_IMPORT,
    ...inputSizeAttrs({ resumeChars: normalizedText.length, truncated }),
    "jobsync.user_id": userId,
    "jobsync.resume_id": resumeId,
  });

  let structured;
  try {
    structured = await runInSpan(structuredSpan, () =>
      executeStructuredForAssignment({
        userId,
        purpose: "RESUME",
        prompt: `${RESUME_IMPORT_SYSTEM_PROMPT}\n\n${buildResumeImportPrompt(normalizedText)}`,
        schema: RESUME_IMPORT_JSON_SCHEMA,
        schemaName: RESUME_IMPORT_SCHEMA_NAME,
        timeoutMs: APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS,
        signal: controller.signal,
      }),
    );
  } catch (error) {
    // Resolver/transport-level throws land here — record the category only.
    clearTimeout(timer);
    structuredSpan.setError(error);
    structuredSpan.end();
    return NextResponse.json(
      { error: "AI request failed", code: "AI_EXECUTION_FAILED" },
      { status: 502 },
    );
  }

  if (structured.status === "OK") {
    clearTimeout(timer);
    // Audit metadata only — never the raw prompt or model output.
    structuredSpan.end({
      "gen_ai.system": structured.provider,
      "gen_ai.request.model": structured.resolvedModel,
      "jobsync.ai.backend_kind": structured.backendKind,
      "jobsync.ai.connection_id": structured.resolvedConnectionId,
      "jobsync.ai.assignment_source": structured.assignmentSource,
      "jobsync.structured.attempts": structured.attemptCount,
      "jobsync.structured.retried": structured.retried,
      "jobsync.structured.strategy":
        structured.attempts[0]?.structuredStrategy ?? null,
    });
    // The managed seam is one-shot: the single validated object is emitted
    // as one NDJSON line — the client takes the latest complete line.
    return new Response(JSON.stringify(structured.value) + "\n", {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "x-resume-import-truncated": String(truncated),
      },
    });
  }

  if (structured.status === "FAILED") {
    clearTimeout(timer);
    structuredSpan.end({
      "jobsync.error_code": structured.code,
      "jobsync.ai.connection_id":
        structured.resolution?.status === "RESOLVED"
          ? structured.resolution.connectionId
          : null,
      "jobsync.structured.attempts": structured.attempts.length,
    });
    return NextResponse.json(
      {
        error: structuredErrorMessage(structured.code),
        code: structured.code,
      },
      { status: structuredErrorStatus(structured.code) },
    );
  }
  structuredSpan.end({ "jobsync.ai.assignment_source": "LEGACY" });

  // NOT_CONFIGURED — legacy API-key path (unchanged behavior).
  if (!selectedModel?.provider || !selectedModel?.model) {
    clearTimeout(timer);
    return NextResponse.json(
      { error: "provider and model are required" },
      { status: 400 },
    );
  }

  try {
    const model = await getModel(
      selectedModel.provider,
      selectedModel.model,
      userId,
    );

    // Only onError carries the provider's message — the error thrown from
    // partialOutputStream is a generic "No output generated".
    let streamErrorMessage: string | undefined;

    const importSpan = startSpan("resume.import", {
      ...genAiRequestAttrs({
        provider: selectedModel.provider,
        model: selectedModel.model,
        temperature: TEMPERATURES.ANALYSIS,
        numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
        surface: SURFACES.RESUME_IMPORT,
        system: RESUME_IMPORT_SYSTEM_PROMPT,
        prompt: preprocessResult.data.normalizedText,
      }),
      ...inputSizeAttrs({
        resumeChars: preprocessResult.data.normalizedText.length,
        // The flag extract-text.ts already computes at its 50,000-char and
        // 5-page limits — did the model see the whole document?
        truncated,
      }),
      "jobsync.user_id": userId,
      "jobsync.resume_id": resumeId,
    });

    const result = runInSpan(importSpan, () =>
      streamText({
        model,
        output: Output.object({ schema: ResumeImportSchema }),
        system: RESUME_IMPORT_SYSTEM_PROMPT,
        prompt: buildResumeImportPrompt(normalizedText),
        temperature: TEMPERATURES.ANALYSIS,
        abortSignal: controller.signal,
        providerOptions: {
          ollama: { options: { num_ctx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX } },
          // OpenAI (and OpenRouter, same factory) default to strict
          // json_schema, which rejects any object whose `required` omits a key
          // — this schema is optional-by-design throughout. Non-strict passes
          // it as guidance.
          openai: { strictJsonSchema: false },
        },
        onFinish: ({ totalUsage, finishReason }) => {
          clearTimeout(timer);
          importSpan.end(
            genAiResponseAttrs({ usage: totalUsage, finishReason }),
          );
        },
        onError: ({ error }) => {
          clearTimeout(timer);
          log.error("Resume import stream error", { error: String(error) });
          streamErrorMessage = error instanceof Error ? error.message : undefined;
          importSpan.setError(error);
          importSpan.end();
        },
      }),
    );

    // Stream partialOutputStream (not textStream): the SDK parses the model's
    // output regardless of whether the provider used json or tool-call mode, so
    // this is non-empty even when textStream is. Each value is a full snapshot
    // of the object so far — emit as NDJSON so the client reads the latest
    // complete line. Truncation is known pre-generation, so it rides a header.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const partial of result.partialOutputStream) {
            controller.enqueue(encoder.encode(JSON.stringify(partial) + "\n"));
          }
        } catch (err) {
          // Abort/network errors: close cleanly so the client salvages the
          // last complete snapshot. onError already logged it.
          log.error("Resume import stream interrupted", {
            error: String(err),
          });
        } finally {
          // The 200 and headers are committed before the provider is called,
          // so a failure can only reach the client in-band as a final line.
          if (streamErrorMessage) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({ __error: streamErrorMessage }) + "\n",
              ),
            );
          }
          controller.close();
        }
      },
      cancel() {
        // Reader released (client gone) — abort the in-flight generation.
        clearTimeout(timer);
        controller.abort();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "x-resume-import-truncated": String(truncated),
      },
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return NextResponse.json(
        {
          error: `AI request timed out after ${APP_CONSTANTS.AI_RESUME_IMPORT_TIMEOUT_MS / 1000} seconds. Please try again.`,
        },
        { status: 504 },
      );
    }

    const message =
      error instanceof Error ? error.message : "AI request failed";

    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
      return NextResponse.json(
        {
          error: `Cannot connect to AI service. Please ensure the service is running.`,
        },
        { status: 503 },
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
};
