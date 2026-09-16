import { format } from "date-fns";
import { toastError, toastSuccess } from "@/lib/toast";
import type { TranslateFn } from "@/i18n";

export async function downloadJobsList(t: TranslateFn) {
  try {
    const res = await fetch("/api/jobs/export", {
      method: "POST",
      headers: {
        "Content-Type": "text/csv",
      },
    });
    if (!res.ok) {
      throw new Error(t("jobs.downloadFailed"));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vocatrya-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toastSuccess(t("jobs.downloadSuccess"));
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : t("jobs.unknownError"),
    );
  }
}
