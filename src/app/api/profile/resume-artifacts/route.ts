import { auth } from "@/auth";
import prisma from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { assertResumeV1Writable } from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { MAX_RESUME_PDF_BYTES, ResumeArtifactService, resumeArtifactDTO } from "@/lib/career/resumeArtifactService";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Not Authenticated" }, { status: 401 });
    await assertResumeV1Writable(prisma);
    const versionId = req.nextUrl.searchParams.get("versionId");
    if (!versionId) return NextResponse.json({ error: "Version id is required" }, { status: 400 });
    const format = req.nextUrl.searchParams.get("format");
    if (format === "DOCX") {
      // Server-generated only: reject uploaded bytes for this format.
      if (req.body !== null) return NextResponse.json({ error: "DOCX must be generated on the server" }, { status: 400 });
      const artifact = await new ResumeArtifactService(prisma, session.user.id).createDocxExport(versionId);
      return NextResponse.json(resumeArtifactDTO(artifact), { status: 201 });
    }
    if (format && format !== "PDF") return NextResponse.json({ error: "Unsupported format" }, { status: 400 });
    if (req.headers.get("content-type")?.split(";")[0] !== "application/pdf") {
      return NextResponse.json({ error: "PDF body is required", code: "PDF_INVALID" }, { status: 400 });
    }
    // Bound chunked uploads too, without buffering an unbounded request body.
    const reader = req.body?.getReader();
    if (!reader) return NextResponse.json({ error: "PDF body is required", code: "PDF_INVALID" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESUME_PDF_BYTES) {
          await reader.cancel();
          throw new CareerRuntimeError("PDF_TOO_LARGE", "PDF exceeds the 20 MB limit");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const artifact = await new ResumeArtifactService(prisma, session.user.id).createExport(versionId, Buffer.concat(chunks));
    return NextResponse.json(resumeArtifactDTO(artifact), { status: 201 });
  } catch (error) {
    if (error instanceof CareerRuntimeError) {
      const status = error.code.includes("NOT_ENABLED") ? 403 : error.code === "VERSION_NOT_FOUND" ? 404 : error.code === "PDF_TOO_LARGE" ? 413 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Failed to save resume PDF" }, { status: 500 });
  }
}
