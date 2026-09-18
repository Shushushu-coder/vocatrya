import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { buildBackupZip } from "@/lib/backup/export";
import { log } from "@/lib/telemetry";

function parseIncludeSensitiveData(request: NextRequest): boolean {
  return request.nextUrl.searchParams.get("includeSensitiveData") === "true";
}

// A route handler rather than a server action: server actions cannot return a
// binary stream. Covered by the /api/* middleware matcher; auth() here is
// defense in depth.
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const includeSensitiveData = parseIncludeSensitiveData(request);

  try {
    const { buffer, fileName } = await buildBackupZip(
      session.user.id,
      session.user.email ?? "",
      { includeSensitiveData },
    );
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch {
    log.error("[Backup] Export failed");
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
