import { auth } from "@/auth";
import prisma from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { CareerRuntimeError } from "@/lib/career/errors";
import { CandidateAttachmentService } from "@/lib/career/candidateAttachmentService";

export const runtime = "nodejs";

// Attachment bytes never ride broad data payloads: this route is the only
// explicit download path and it runs the career read gate + ownership check.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Not Authenticated" }, { status: 401 });
    }
    const { attachmentId } = await params;
    const { attachment, bytes } = await new CandidateAttachmentService(
      prisma,
      session.user.id,
    ).openForDownload(attachmentId);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof CareerRuntimeError) {
      const status = error.code.includes("NOT_ENABLED")
        ? 403
        : error.code === "ATTACHMENT_NOT_FOUND" ||
            error.code === "ATTACHMENT_BYTES_MISSING"
          ? 404
          : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Failed to download attachment" }, { status: 500 });
  }
}
