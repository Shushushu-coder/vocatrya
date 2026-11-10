"use client";

import Link from "next/link";
import {
  BriefcaseBusiness,
  FileText,
  History,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { useI18n } from "@/i18n";
import type { OverviewDataState } from "@/actions/dashboard.actions";

type JourneyEntry = {
  key: string;
  labelKey: string;
  href: string;
};

type JourneyStage = {
  key: "prepare" | "act" | "review";
  icon: LucideIcon;
  titleKey: string;
  descKey: string;
  entries: JourneyEntry[];
};

// The Agent slot stays a single open() entry (frozen §9 D7) — with
// multi-agent it passes the stage's role through the same call: prepare →
// Insight, act → Pilot, review → Reflect. Still no send, no conversation.
const STAGE_AGENT_ROLE = {
  prepare: "insight",
  act: "pilot",
  review: "reflect",
} as const;

// O1 welcome + O2 journey cards (frozen contract §2.1/§2.2). The three stages
// map to real routes; gated entries follow the same capability policy as
// GettingStarted/CreateMenu — hidden, never disabled. The Agent slot is a
// single open() entry (frozen §9 D7): it only unfolds the existing panel —
// no conversation, message, or prefilled context. With multi-agent landed it
// passes the stage's role through the same entry (MULTI-AGENT contract §6.2).
export default function JourneySection({
  dataState,
  jobsAbRead,
}: {
  dataState: OverviewDataState;
  jobsAbRead: boolean;
}) {
  const { t } = useI18n();
  const { open } = useAgentChat();
  const { jobMutationsEnabled, resumeV1Enabled } = useCareerSurfaces();

  const stages: JourneyStage[] = [
    {
      key: "prepare",
      icon: FileText,
      titleKey: "dashboard.journeyPrepareTitle",
      descKey: "dashboard.journeyPrepareDesc",
      entries: [
        {
          key: "materials",
          labelKey: "dashboard.journeyEntryMaterials",
          href: "/dashboard/profile",
        },
        ...(resumeV1Enabled
          ? [
              {
                key: "resumes",
                labelKey: "dashboard.journeyEntryResumes",
                href: "/dashboard/profile/resumes",
              },
            ]
          : []),
        {
          key: "questions",
          labelKey: "dashboard.journeyEntryQuestions",
          href: "/dashboard/questions",
        },
      ],
    },
    {
      key: "act",
      icon: BriefcaseBusiness,
      titleKey: "dashboard.journeyActTitle",
      descKey: "dashboard.journeyActDesc",
      entries: [
        {
          key: "jobs",
          labelKey: "dashboard.journeyEntryJobs",
          href: "/dashboard/myjobs",
        },
        ...(jobMutationsEnabled
          ? [
              {
                key: "addJob",
                labelKey: "dashboard.journeyEntryAddJob",
                href: "/dashboard/myjobs?add-job=true",
              },
            ]
          : []),
        ...(jobsAbRead
          ? [
              {
                key: "upcoming",
                labelKey: "dashboard.journeyEntryUpcoming",
                href: "/dashboard/myjobs?tab=upcoming",
              },
            ]
          : []),
        {
          key: "tasks",
          labelKey: "dashboard.journeyEntryTasks",
          href: "/dashboard/tasks",
        },
        {
          key: "addTask",
          labelKey: "dashboard.journeyEntryAddTask",
          href: "/dashboard/tasks?add-task=true",
        },
      ],
    },
    {
      key: "review",
      icon: History,
      titleKey: "dashboard.journeyReviewTitle",
      descKey: "dashboard.journeyReviewDesc",
      entries: [
        {
          key: "reflection",
          labelKey: "dashboard.journeyEntryReflection",
          // Explanatory entry: real debriefs live on each position's detail
          // page (timeline tab under the ab read family); the R6 suggestion
          // carries the concrete deep link once its read model lands.
          href: "/dashboard/myjobs",
        },
        {
          key: "practice",
          labelKey: "dashboard.journeyEntryInterview",
          href: "/dashboard/interview",
        },
      ],
    },
  ];

  return (
    <section data-testid="journey-overview" className="grid min-w-0 gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-foreground">
          {t("dashboard.journeyTitle")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t(
            dataState === "empty"
              ? "dashboard.journeyIntroEmpty"
              : "dashboard.journeyIntro",
          )}
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-4 @md/main:grid-cols-2 @3xl/main:grid-cols-3">
        {stages.map((stage) => (
          <Card key={stage.key} data-testid={`journey-stage-${stage.key}`}>
            <CardContent className="flex h-full flex-col gap-3 px-4 py-4">
              <div className="flex items-center gap-2">
                <stage.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t(stage.titleKey)}</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(stage.descKey)}
              </p>
              <div className="grid gap-0.5">
                {stage.entries.map((entry) => (
                  <Link
                    key={entry.key}
                    href={entry.href}
                    data-testid={`journey-entry-${stage.key}-${entry.key}`}
                    className="flex min-w-0 items-center rounded-md px-2 py-1.5 text-sm hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="truncate">{t(entry.labelKey)}</span>
                  </Link>
                ))}
              </div>
              <button
                type="button"
                data-testid={`journey-agent-${stage.key}`}
                onClick={() => open({ role: STAGE_AGENT_ROLE[stage.key] })}
                className="mt-auto flex items-center gap-1.5 self-start rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                <span>{t("dashboard.journeyAskAgent")}</span>
              </button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
