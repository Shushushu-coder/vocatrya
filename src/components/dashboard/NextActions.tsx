"use client";

import Link from "next/link";
import {
  BriefcaseBusiness,
  CalendarClock,
  FileText,
  Link2,
  NotebookPen,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { formatDateOnly, formatInstant } from "@/lib/datetime";
import {
  NEXT_ACTION_RULE,
  type NextActionItem,
  type NextActionRuleId,
} from "@/lib/career/nextActionsContract";
import type { NextActionsData } from "@/actions/dashboard/nextActions";

const RULE_ICONS: Record<NextActionRuleId, LucideIcon> = {
  [NEXT_ACTION_RULE.R1]: FileText,
  [NEXT_ACTION_RULE.R2]: Sparkles,
  [NEXT_ACTION_RULE.R3]: BriefcaseBusiness,
  [NEXT_ACTION_RULE.R4]: Link2,
  [NEXT_ACTION_RULE.R5]: CalendarClock,
  [NEXT_ACTION_RULE.R6]: NotebookPen,
  [NEXT_ACTION_RULE.R7]: Wrench,
};

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  weekday: "short",
};

function describe(
  item: NextActionItem,
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
  timeZone: string,
): { title: string; detail?: string } {
  const when =
    item.attentionAt != null
      ? item.dateOn
        ? formatDateOnly(item.dateOn, locale, DATE_OPTIONS)
        : formatInstant(item.attentionAt, locale, timeZone, DATE_OPTIONS)
      : "";
  const company = item.companyName ? ` · ${item.companyName}` : "";
  const jobTitle = item.jobTitle ?? "";
  const stepLabel = item.stepLabel ?? "";

  switch (item.ruleId) {
    case NEXT_ACTION_RULE.R1:
      return {
        title: t("dashboard.nextActionR1Title"),
        detail: t("dashboard.nextActionR1Detail"),
      };
    case NEXT_ACTION_RULE.R2:
      return {
        title: t("dashboard.nextActionR2Title"),
        detail: t("dashboard.nextActionR2Detail"),
      };
    case NEXT_ACTION_RULE.R3:
      if (item.variant === "noJobs") {
        return {
          title: t("dashboard.nextActionR3NoJobsTitle"),
          detail: t("dashboard.nextActionR3NoJobsDetail"),
        };
      }
      if (item.variant === "unappliedLegacy") {
        return {
          title: t("dashboard.nextActionR3UnappliedLegacyTitle"),
          detail: t("dashboard.nextActionR3UnappliedLegacyDetail"),
        };
      }
      return {
        title: t("dashboard.nextActionR3UnappliedTitle"),
        detail: t("dashboard.nextActionR3UnappliedDetail"),
      };
    case NEXT_ACTION_RULE.R4:
      return {
        title: t("dashboard.nextActionR4Title", { jobTitle }),
        detail: t("dashboard.nextActionR4Detail"),
      };
    case NEXT_ACTION_RULE.R5:
      if (item.variant === "confirmStatus") {
        return {
          title: t("dashboard.nextActionR5ConfirmTitle", { jobTitle }),
          detail: t("dashboard.nextActionR5ConfirmDetail", {
            stepLabel,
            company,
            when,
          }),
        };
      }
      return {
        title: t("dashboard.nextActionR5PrepareTitle", { jobTitle }),
        detail: t("dashboard.nextActionR5PrepareDetail", {
          stepLabel,
          company,
          when,
        }),
      };
    case NEXT_ACTION_RULE.R6:
      return {
        title: t("dashboard.nextActionR6Title", { jobTitle }),
        detail: t("dashboard.nextActionR6Detail", { stepLabel, company }),
      };
    case NEXT_ACTION_RULE.R7:
      return {
        title: t("dashboard.nextActionR7Title"),
        detail: t("dashboard.nextActionR7Detail"),
      };
  }
}

// O3 next-steps strip (frozen contract §4): plain navigation to real
// surfaces — never an agent call, message, or write. The whole block
// disappears on a clean read, matching OverviewReminders' empty contract.
export default function NextActions({ data }: { data: NextActionsData }) {
  const { t, locale } = useI18n();
  if (data.items.length === 0) return null;

  return (
    <Card data-testid="next-actions">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-foreground">
          {t("dashboard.nextActionsTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 px-3 pb-3">
        {data.items.map((item) => {
          const copy = describe(item, t, locale, data.timeZone);
          const Icon = RULE_ICONS[item.ruleId];
          return (
            <Link
              key={item.id}
              href={item.href}
              data-testid={`next-action-${item.id}`}
              className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{copy.title}</p>
                {copy.detail ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {copy.detail}
                  </p>
                ) : null}
              </div>
            </Link>
          );
        })}
        {data.overflowCount > 0 ? (
          <p
            data-testid="next-actions-overflow"
            className="px-2 pt-1 text-xs text-muted-foreground"
          >
            {t("dashboard.nextActionsOverflow", {
              count: data.overflowCount,
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
