"use client";
import { useI18n } from "@/i18n";
import type { ResumeDiffChange } from "@/lib/career/resumeVersionDiff";
function text(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (Array.isArray(value)) return value.map(text).join("\n");
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    if ("items" in row) return [row.title, text(row.items)].filter(Boolean).join("\n");
    if ("expressions" in row) return [row.materialTitleSnapshot, text(row.expressions)].filter(Boolean).join("\n");
    if ("content" in row) return String(row.content);
    return Object.entries(row).filter(([key]) => !key.toLowerCase().endsWith("id")).map(([, value]) => text(value)).join("\n");
  }
  return "—";
}
export function ResumeVersionDiffView({ changes }: { changes: ResumeDiffChange[] }) {
  const { t } = useI18n();
  return <ul className="space-y-2 text-sm">{changes.length ? changes.map((change, i) => {
    const suffix = change.path.split("/").at(-1)!;
    const field = ["header", "layout", "hidden", "title", "kind", "material", "content", "evidence"].includes(suffix) ? suffix : "entry";
    const describe = (value: unknown) => field === "hidden" ? t(value ? "resumeBuilder.hidden" : "resumeBuilder.visible") : field === "evidence" ? t("resumeBuilder.evidenceChanged") : field === "material" && Array.isArray(value) ? text(value.slice(1)) : text(value);
    return <li key={i} className="rounded border p-3"><strong>{t(`resumeBuilder.change${change.type}`)} · {t(`resumeBuilder.diff${field}`)}</strong><div className="mt-2 grid gap-3 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">{t("resumeBuilder.before")}</p><p className="whitespace-pre-wrap break-words">{describe(change.before)}</p></div><div><p className="text-xs text-muted-foreground">{t("resumeBuilder.after")}</p><p className="whitespace-pre-wrap break-words">{describe(change.after)}</p></div></div></li>;
  }) : <li>{t("resumeBuilder.noChanges")}</li>}</ul>;
}
