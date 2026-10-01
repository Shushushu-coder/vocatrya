"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { AgentAddJobResult } from "@/models/agent.model";
import { useI18n } from "@/i18n";

// Composed from the tool result's STRUCTURED fields, never from
// createJobFromNames' message string — that prose is MCP-facing protocol text
// naming update_job and allowDuplicate, tools this surface does not expose.
export function AddJobResult({
  output,
  input,
}: {
  output: AgentAddJobResult;
  input: Record<string, unknown>;
}) {
  const { t } = useI18n();
  if (output.validationError) {
    return (
      <p className="text-sm">
        {t("agent.couldNotAddJob", {
          error: output.displayError ?? output.validationError,
        })}
      </p>
    );
  }

  if (output.duplicateOf) {
    return (
      <div className="text-sm">
        <p>
          {t("agent.alreadyTracked", {
            title: output.duplicateOf.title,
            company: output.duplicateOf.company,
          })}
        </p>
        <Link
          className="text-xs underline"
          href={`/dashboard/myjobs/${output.duplicateOf.id}`}
        >
          {t("agent.openExistingJob")}
        </Link>
      </div>
    );
  }

  const newEntities = output.resolutions
    .filter((r) => r.created)
    .map((r) => r.label);
  const jobTitle =
    typeof input.jobTitle === "string" ? input.jobTitle : t("agent.fallbackJob");
  const company = typeof input.company === "string" ? input.company : undefined;

  return (
    <div className="text-sm">
      <p>{t("agent.addedToMyJobs")}</p>
      <p>
        {company
          ? t("agent.addedJobAt", { title: jobTitle, company })
          : t("agent.addedJob", { title: jobTitle })}
      </p>
      {output.jobId && (
        <Link
          className="text-xs underline"
          href={`/dashboard/myjobs/${output.jobId}`}
        >
          {t("agent.openTheJob")}
        </Link>
      )}
      {newEntities.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("agent.newEntities", { list: newEntities.join(", ") })}
        </p>
      )}
      {output.descriptionChars !== undefined && (
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {t("agent.descriptionMeta", {
              source:
                output.descriptionSource === "pasted"
                  ? t("agent.pastedVerbatim")
                  : t("agent.modelSupplied"),
              chars: output.descriptionChars,
            })}
          </span>
          {output.descriptionCompleteness && (
            <Badge variant="outline">{output.descriptionCompleteness}</Badge>
          )}
        </p>
      )}
    </div>
  );
}
