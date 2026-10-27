import { NextResponse } from "next/server";
import { PassThrough } from "node:stream";
import { getJobsIterator } from "@/actions/job.actions";
import { auth } from "@/auth";
import { log } from "@/lib/telemetry";
import { getServerI18n } from "@/i18n/server";
import {
  CSV_UTF8_BOM,
  transformJobForCsv,
  unparseJobsCsv,
} from "@/lib/jobs/exportJobsCsv";

export const POST = async () => {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { t, locale } = await getServerI18n();
  const passThrough = new PassThrough();
  let isFirstChunk = true;
  let hasError = false;

  (async () => {
    try {
      passThrough.write(CSV_UTF8_BOM);
      let recordIndex = 0;
      for await (const chunk of getJobsIterator()) {
        if (hasError) break;
        const transformedData = chunk.map((job, idx) =>
          transformJobForCsv(job, recordIndex + idx, t)
        );
        recordIndex += chunk.length;
        const csv = unparseJobsCsv(
          transformedData,
          t,
          {
            header: isFirstChunk,
          },
          locale,
        );
        passThrough.write(
          (isFirstChunk ? "" : "\r\n") + csv,
        );
        isFirstChunk = false;
      }
      if (isFirstChunk) passThrough.write(unparseJobsCsv([], t, { header: true }, locale));
    } catch (error) {
      hasError = true;
      log.error("Error streaming jobs CSV", { error: String(error) });
      if (error instanceof Error) {
        return NextResponse.json(
          {
            error: error.message ?? "Jobs download failed",
          },
          {
            status: 500,
          }
        );
      }
    } finally {
      passThrough.end();
    }
  })();

  return new NextResponse(passThrough as any, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="jobs.csv"',
    },
  });
};
