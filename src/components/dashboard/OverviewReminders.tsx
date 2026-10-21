"use client";

import Link from "next/link";
import { CalendarClock, SquareCheckBig } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { OverviewReminder } from "@/actions/dashboard.actions";

// Lightweight strip rendered only when something concrete is due; the whole
// section disappears on a clean week rather than holding empty space.
export default function OverviewReminders({
  reminders,
}: {
  reminders: OverviewReminder[];
}) {
  const { t, formatDate } = useI18n();
  if (reminders.length === 0) return null;

  return (
    <Card data-testid="overview-reminders">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-foreground">
          {t("dashboard.remindersTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 px-3 pb-3">
        {reminders.map((reminder) => {
          const Icon =
            reminder.kind === "task" ? SquareCheckBig : CalendarClock;
          return (
            <Link
              key={reminder.id}
              href={reminder.href}
              className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{reminder.title}</p>
                {reminder.detail ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {reminder.detail}
                  </p>
                ) : null}
              </div>
              <span
                className={
                  reminder.overdue
                    ? "shrink-0 text-xs font-medium text-destructive"
                    : "shrink-0 text-xs text-muted-foreground"
                }
              >
                {formatDate(reminder.at, {
                  month: "short",
                  day: "numeric",
                  weekday: "short",
                })}
                {reminder.overdue ? ` · ${t("dashboard.overdue")}` : ""}
              </span>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
