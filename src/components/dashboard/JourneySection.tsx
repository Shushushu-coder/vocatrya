"use client";

import Link from "next/link";
import {
  BriefcaseBusiness,
  CalendarClock,
  ChevronRight,
  CircleHelp,
  Files,
  FileText,
  FolderOpen,
  GraduationCap,
  History,
  ListTodo,
  MessageSquare,
  NotebookPen,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { journeyText, type JourneyCopySlot } from "./journeyCopy";

type JourneyEntry = {
  key: string;
  labelKey: string;
  href: string;
  icon: LucideIcon;
  // Retired inside the desktop shell via the data-desktop CSS gate; the
  // web build keeps showing the entry.
  desktopHidden?: boolean;
};

type JourneyStage = {
  key: "prepare" | "act" | "review";
  icon: LucideIcon;
  titleKey: string;
  descSlot: JourneyCopySlot;
  entries: JourneyEntry[];
};

type JourneyTone = {
  card: string;
  title: string;
  desc: string;
  icon: string;
  entry: string;
  entryIcon: string;
  chevron: string;
  agent: string;
};

// UI-RC-OVERVIEW frozen palette: light stage tints with dark same-hue text.
// Dark-mode variants keep the same hue family so the three stages stay
// distinguishable inside the dark theme.
const STAGE_TONE: Record<JourneyStage["key"], JourneyTone> = {
  prepare: {
    card: "border-blue-200/70 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/50",
    title: "text-blue-900 dark:text-blue-100",
    desc: "text-blue-800/75 dark:text-blue-200/75",
    icon: "text-blue-700 dark:text-blue-300",
    entry:
      "bg-blue-100/80 text-blue-950 hover:bg-blue-100 dark:bg-blue-900/60 dark:text-blue-50 dark:hover:bg-blue-900",
    entryIcon: "text-blue-600 dark:text-blue-300",
    chevron: "text-blue-400 dark:text-blue-500",
    agent:
      "text-blue-800/80 hover:bg-blue-100 hover:text-blue-900 dark:text-blue-200/75 dark:hover:bg-blue-900/70 dark:hover:text-blue-100",
  },
  act: {
    card: "border-green-200/70 bg-green-50 dark:border-green-900 dark:bg-green-950/50",
    title: "text-green-900 dark:text-green-100",
    desc: "text-green-800/75 dark:text-green-200/75",
    icon: "text-green-700 dark:text-green-300",
    entry:
      "bg-green-100/80 text-green-950 hover:bg-green-100 dark:bg-green-900/60 dark:text-green-50 dark:hover:bg-green-900",
    entryIcon: "text-green-600 dark:text-green-300",
    chevron: "text-green-500 dark:text-green-500",
    agent:
      "text-green-800/80 hover:bg-green-100 hover:text-green-900 dark:text-green-200/75 dark:hover:bg-green-900/70 dark:hover:text-green-100",
  },
  review: {
    card: "border-purple-200/70 bg-purple-50 dark:border-purple-900 dark:bg-purple-950/50",
    title: "text-purple-900 dark:text-purple-100",
    desc: "text-purple-800/75 dark:text-purple-200/75",
    icon: "text-purple-700 dark:text-purple-300",
    entry:
      "bg-purple-100/80 text-purple-950 hover:bg-purple-100 dark:bg-purple-900/60 dark:text-purple-50 dark:hover:bg-purple-900",
    entryIcon: "text-purple-600 dark:text-purple-300",
    chevron: "text-purple-400 dark:text-purple-500",
    agent:
      "text-purple-800/80 hover:bg-purple-100 hover:text-purple-900 dark:text-purple-200/75 dark:hover:bg-purple-900/70 dark:hover:text-purple-100",
  },
};

// The Agent slot stays a single open() entry (frozen §9 D7) — with
// multi-agent it passes the stage's role through the same call: prepare →
// Insight, act → Pilot, review → Reflect. Still no send, no conversation.
const STAGE_AGENT_ROLE = {
  prepare: "insight",
  act: "pilot",
  review: "reflect",
} as const;

// O1 welcome + O2 journey cards (frozen contract §2.1/§2.2, UI-RC-OVERVIEW
// D2). The three stages map to real routes; gated entries follow the same
// capability policy as GettingStarted/CreateMenu — hidden, never disabled.
// The Agent slot is a single open() entry (frozen §9 D7): it only unfolds
// the existing panel — no conversation, message, or prefilled context. With
// multi-agent landed it passes the stage's role through the same entry
// (MULTI-AGENT contract §6.2).
export default function JourneySection({
  jobsAbRead,
}: {
  jobsAbRead: boolean;
}) {
  const { t, locale } = useI18n();
  const { open } = useAgentChat();
  const { jobMutationsEnabled, resumeV1Enabled } = useCareerSurfaces();

  const stages: JourneyStage[] = [
    {
      key: "prepare",
      icon: FileText,
      titleKey: "dashboard.journeyPrepareTitle",
      descSlot: "prepareDesc",
      entries: [
        {
          key: "materials",
          labelKey: "dashboard.journeyEntryMaterials",
          href: "/dashboard/profile",
          icon: FolderOpen,
        },
        ...(resumeV1Enabled
          ? [
              {
                key: "resumes",
                labelKey: "dashboard.journeyEntryResumes",
                href: "/dashboard/profile/resumes",
                icon: Files,
              },
            ]
          : []),
        {
          key: "questions",
          labelKey: "dashboard.journeyEntryQuestions",
          href: "/dashboard/questions",
          icon: CircleHelp,
        },
      ],
    },
    {
      key: "act",
      icon: BriefcaseBusiness,
      titleKey: "dashboard.journeyActTitle",
      descSlot: "actDesc",
      entries: [
        {
          key: "jobs",
          labelKey: "dashboard.journeyEntryJobs",
          href: "/dashboard/myjobs",
          icon: BriefcaseBusiness,
        },
        ...(jobMutationsEnabled
          ? [
              {
                key: "addJob",
                labelKey: "dashboard.journeyEntryAddJob",
                href: "/dashboard/myjobs?add-job=true",
                icon: Plus,
              },
            ]
          : []),
        ...(jobsAbRead
          ? [
              {
                key: "upcoming",
                labelKey: "dashboard.journeyEntryUpcoming",
                href: "/dashboard/myjobs?tab=upcoming",
                icon: CalendarClock,
              },
            ]
          : []),
        {
          key: "tasks",
          labelKey: "dashboard.journeyEntryTasks",
          href: "/dashboard/tasks",
          icon: ListTodo,
        },
        {
          key: "addTask",
          labelKey: "dashboard.journeyEntryAddTask",
          href: "/dashboard/tasks?add-task=true",
          icon: Plus,
        },
      ],
    },
    {
      key: "review",
      icon: History,
      titleKey: "dashboard.journeyReviewTitle",
      descSlot: "reviewDesc",
      entries: [
        {
          key: "reflection",
          labelKey: "dashboard.journeyEntryReflection",
          // Explanatory entry: real debriefs live on each position's detail
          // page (timeline tab under the ab read family); the R6 suggestion
          // carries the concrete deep link once its read model lands.
          href: "/dashboard/myjobs",
          icon: NotebookPen,
        },
        {
          key: "practice",
          labelKey: "dashboard.journeyEntryInterview",
          href: "/dashboard/interview",
          icon: GraduationCap,
          desktopHidden: true,
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
          {journeyText(locale, t, "intro")}
        </p>
      </div>
      <div className="grid min-w-0 grid-cols-1 items-start gap-4 @md/main:grid-cols-2 @3xl/main:grid-cols-3">
        {stages.map((stage) => {
          const tone = STAGE_TONE[stage.key];
          return (
            <Card
              key={stage.key}
              data-testid={`journey-stage-${stage.key}`}
              className={tone.card}
            >
              <CardContent className="flex flex-col gap-3 px-4 py-4">
                <div className="flex items-center gap-2">
                  <stage.icon
                    className={cn("h-4 w-4 shrink-0", tone.icon)}
                  />
                  <h3 className={cn("text-sm font-semibold", tone.title)}>
                    {t(stage.titleKey)}
                  </h3>
                </div>
                <p className={cn("text-xs", tone.desc)}>
                  {journeyText(locale, t, stage.descSlot)}
                </p>
                <div className="grid gap-1">
                  {stage.entries.map((entry) => (
                    <Link
                      key={entry.key}
                      href={entry.href}
                      data-testid={`journey-entry-${stage.key}-${entry.key}`}
                      className={cn(
                        "flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                        tone.entry,
                        entry.desktopHidden && "desktop-hidden",
                      )}
                    >
                      <entry.icon
                        className={cn("h-4 w-4 shrink-0", tone.entryIcon)}
                        aria-hidden
                      />
                      <span className="truncate">{t(entry.labelKey)}</span>
                      <ChevronRight
                        className={cn(
                          "ml-auto h-4 w-4 shrink-0",
                          tone.chevron,
                        )}
                        aria-hidden
                      />
                    </Link>
                  ))}
                </div>
                <button
                  type="button"
                  data-testid={`journey-agent-${stage.key}`}
                  onClick={() => open({ role: STAGE_AGENT_ROLE[stage.key] })}
                  className={cn(
                    "flex items-center gap-1.5 self-start rounded-md px-2 py-1.5 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                    tone.agent,
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("dashboard.journeyAskAgent")}</span>
                </button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
