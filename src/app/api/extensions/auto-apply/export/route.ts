import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { resolveAppVersion } from "@/lib/appVersion";
import { assertCareerDataCopyable } from "@/lib/career/access";
import { CareerRuntimeError } from "@/lib/career/errors";
import { loadAutoApplySource } from "@/lib/extensions/autoApply/source";
import { buildAutoApplyExport } from "@/lib/extensions/autoApply/convert";
import { parseSectionSelection } from "@/lib/extensions/autoApply/sections";
import { log } from "@/lib/telemetry";

/**
 * GET /api/extensions/auto-apply/export?sections=basic,education,...
 *
 * Returns an OpenJobAutofill-compatible profile backup JSON as a download.
 * Read-only: reads whitelisted non-sensitive profile data via
 * loadAutoApplySource and writes nothing. `sections` is optional (defaults
 * to every exportable section) and intersected with the export whitelist —
 * sensitive upstream sections can never be requested.
 */
export const GET = async (req: NextRequest) => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session?.user || !userId) {
    return NextResponse.json({ error: "Not Authenticated" }, { status: 401 });
  }

  try {
    await assertCareerDataCopyable(prisma as never);
    const { searchParams } = new URL(req.url);
    const selection = parseSectionSelection(searchParams.get("sections"));
    if (selection.sections.length === 0) {
      return NextResponse.json(
        { error: "No exportable sections selected." },
        { status: 400 },
      );
    }

    const source = await loadAutoApplySource(prisma, userId);
    const appVersion = resolveAppVersion();
    const { backup } = buildAutoApplyExport(source, selection.sections, {
      appVersion,
    });

    const stamp = backup.exportedAt.replace(/[:.]/g, "-").slice(0, 19);
    const filename = `vocatrya-autofill-profile-${stamp}.json`;
    return new NextResponse(JSON.stringify(backup, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof CareerRuntimeError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 },
      );
    }
    log.error("[AutoApplyExport] Export failed", { error: String(error) });
    return NextResponse.json(
      { error: "Profile export failed" },
      { status: 500 },
    );
  }
};
