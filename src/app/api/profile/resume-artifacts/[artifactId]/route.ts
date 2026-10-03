import { auth } from "@/auth";
import prisma from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { CareerRuntimeError } from "@/lib/career/errors";
import { ResumeArtifactService } from "@/lib/career/resumeArtifactService";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Not Authenticated" }, { status: 401 });
    const { artifactId } = await params;
    const { artifact, bytes } = await new ResumeArtifactService(prisma, session.user.id).openForDownload(artifactId);
    const fallback = artifact.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(artifact.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof CareerRuntimeError) {
      const status = error.code.includes("NOT_ENABLED") ? 403 : error.code === "ARTIFACT_NOT_FOUND" || error.code === "ARTIFACT_BYTES_MISSING" ? 404 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Failed to download resume PDF" }, { status: 500 });
  }
}
