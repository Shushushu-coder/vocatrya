"use client";

import Link from "next/link";
import { BookOpen, BriefcaseBusiness, SquareCheckBig } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

// The four starting points reuse the same deep links as the header's global
// create menu, so each entry lands on the target surface's own create flow
// (or, for the question bank, on the bank itself which keeps its existing
// add-question capability). They are contextual guidance shown only in the
// TRUE_EMPTY state — not a second global toolbar.
const ENTRIES = [
  {
    key: "job",
    icon: BriefcaseBusiness,
    titleKey: "dashboard.gettingStartedJobTitle",
    descriptionKey: "dashboard.gettingStartedJobDesc",
    href: "/dashboard/myjobs?add-job=true",
  },
  {
    key: "task",
    icon: SquareCheckBig,
    titleKey: "dashboard.gettingStartedTaskTitle",
    descriptionKey: "dashboard.gettingStartedTaskDesc",
    href: "/dashboard/tasks?add-task=true",
  },
  {
    key: "question",
    icon: BookOpen,
    titleKey: "dashboard.gettingStartedQuestionsTitle",
    descriptionKey: "dashboard.gettingStartedQuestionsDesc",
    href: "/dashboard/questions",
  },
] as const;

// Compact guide that replaces the empty recent-updates area only when the
// user provably has no records. One shared region, four quiet entries —
// real links keep native anchor semantics (keyboard, focus ring, prefetch),
// and the grid collapses 4 -> 2 -> 1 columns as the window narrows.
export default function GettingStarted() {
  const { t } = useI18n();
  const { jobMutationsEnabled } = useCareerSurfaces();
  return (
    <Card data-testid="overview-getting-started">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-foreground">
          {t("dashboard.gettingStartedTitle")}
        </CardTitle>
        <CardDescription>
          {t("dashboard.gettingStartedDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-2 px-3 pb-3 sm:grid-cols-2 xl:grid-cols-4">
        {ENTRIES.filter(
          (entry) => jobMutationsEnabled || entry.key !== "job",
        ).map((entry) => (
          <Link
            key={entry.key}
            href={entry.href}
            data-testid={`getting-started-${entry.key}`}
            className="flex min-w-0 items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <entry.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {t(entry.titleKey)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {t(entry.descriptionKey)}
              </span>
            </span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
