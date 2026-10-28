"use client";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Button } from "../ui/button";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { useI18n } from "@/i18n";

// Shown in place of the score when a job has none. The match flag is read by
// useAutoMatch on the details page, which fires the AI match on arrival.
export function MatchJobButton({ jobId }: { jobId: string }) {
  const { busy } = useAgentChat();
  const { t } = useI18n();
  const { freshNativeFull, jobMutationsEnabled } = useCareerSurfaces();

  if (freshNativeFull) return null;

  // One shared conversation: a second match would clear the running one, so
  // the link is swapped for a dead button rather than left navigable.
  if (busy || !jobMutationsEnabled) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled
        title={t(jobMutationsEnabled ? "jobs.assistantBusy" : "career.jobsReadOnlyTitle")}
      >
        <Sparkles className="h-3.5 w-3.5 mr-1" />
        {t("jobs.matchAction")}
      </Button>
    );
  }

  return (
    <Button asChild size="sm" variant="outline" className="shrink-0">
      <Link href={`/dashboard/myjobs/${jobId}?tab=match&match=1`}>
        <Sparkles className="h-3.5 w-3.5 mr-1" />
        {t("jobs.matchAction")}
      </Link>
    </Button>
  );
}
