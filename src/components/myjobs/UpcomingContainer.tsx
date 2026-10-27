"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Loading from "@/components/Loading";
import { JobTabEmptyState } from "./job-details/JobTabEmptyState";
import { listUpcomingApplicationEvents } from "@/actions/application.actions";
import {
  bucketUpcomingApplicationEvents,
  UPCOMING_BUCKET_ID,
  UPCOMING_EVENT_KIND,
  type UpcomingApplicationEvent,
  type UpcomingBucketId,
} from "@/lib/career/upcomingReadModel";
import {
  businessTimeFromColumns,
  formatBusinessTime,
  type BusinessTimeValue,
} from "@/lib/datetime";
import { toastError } from "@/lib/toast";
import { useI18n, type Locale } from "@/i18n";

function bucketTitle(id: UpcomingBucketId, t: (key: string) => string): string {
  if (id === UPCOMING_BUCKET_ID.overdue) return t("jobs.upcomingOverdue");
  if (id === UPCOMING_BUCKET_ID.today) return t("jobs.upcomingToday");
  if (id === UPCOMING_BUCKET_ID.next7Days) return t("jobs.upcomingNext7Days");
  return t("jobs.upcomingLater");
}

export function UpcomingContainer() {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<UpcomingApplicationEvent[] | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listUpcomingApplicationEvents();
    if (!result.success) {
      toastError(result.message);
      setLoadError(result.message);
      setEvents([]);
      return;
    }
    setLoadError(null);
    setEvents(result.data?.events ?? []);
    setTimeZone(result.data?.timeZone ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buckets = useMemo(
    () =>
      events && timeZone
        ? bucketUpcomingApplicationEvents(events, new Date(), timeZone)
        : [],
    [events, timeZone],
  );

  if (loadError !== null) {
    return <p role="alert" className="text-sm text-destructive">{loadError}</p>;
  }

  if (events === null || timeZone === null) {
    return <Loading />;
  }

  return (
    <Card data-testid="upcoming-list">
      <CardHeader>
        <CardTitle>{t("jobs.upcomingTab")}</CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <JobTabEmptyState
            icon={CalendarClock}
            title={t("jobs.upcomingEmptyTitle")}
            description={t("jobs.upcomingEmptyDescription")}
          />
        ) : (
          <div className="space-y-6">
            {buckets.map((bucket) => (
              <section
                key={bucket.id}
                className="space-y-3"
                data-testid="upcoming-bucket"
                data-bucket={bucket.id}
              >
                <h3 className="text-sm font-semibold tracking-tight">
                  {bucketTitle(bucket.id, t)}
                </h3>
                <ul className="space-y-3">
                  {bucket.events.map((event) => (
                    <UpcomingEventItem
                      key={event.processStepId ?? `${event.kind}:${event.jobOpportunityId}`}
                      event={event}
                      locale={locale}
                      timeZone={timeZone}
                      t={t}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function scheduledTimeValue(event: UpcomingApplicationEvent) {
  return event.scheduledAt
    ? businessTimeFromColumns({
        dateOnly: null,
        instant: event.scheduledAt,
        precision: event.scheduledAtPrecision,
      })
    : null;
}

function deadlineTimeValue(event: UpcomingApplicationEvent) {
  return businessTimeFromColumns({
    dateOnly: event.deadlineOn,
    instant: event.deadlineAt,
    precision: event.deadlinePrecision,
  });
}

function renderTime(
  value: BusinessTimeValue | null,
  locale: Locale,
  timeZone: string,
): string | null {
  if (value === null) return null;
  return formatBusinessTime(value, locale, timeZone);
}

function UpcomingEventItem({
  event,
  locale,
  timeZone,
  t,
}: {
  event: UpcomingApplicationEvent;
  locale: Locale;
  timeZone: string;
  t: (key: string) => string;
}) {
  const isDeadline = event.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE;
  const categoryLabel = event.category
    ? t(`jobs.stepCategories.${event.category}`)
    : null;
  const categoryText =
    categoryLabel && categoryLabel !== `jobs.stepCategories.${event.category}`
      ? categoryLabel
      : event.category;
  const scheduledText = renderTime(scheduledTimeValue(event), locale, timeZone);
  const deadlineText = renderTime(deadlineTimeValue(event), locale, timeZone);

  return (
    <li
      className="rounded-md border bg-muted/30 p-3"
      data-testid="upcoming-event"
      data-kind={event.kind}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm text-muted-foreground">
            {event.companyName ?? t("common.notAvailable")}
          </p>
          <Link
            href={`/dashboard/myjobs/${event.jobOpportunityId}`}
            className="font-medium hover:underline"
          >
            {event.roleTitle}
          </Link>
        </div>
        <Badge variant={isDeadline ? "secondary" : "outline"}>
          {isDeadline
            ? t("jobs.applicationDeadline")
            : t("jobs.upcomingProcessStep")}
        </Badge>
      </div>
      <p className="mt-2 font-medium">
        {isDeadline ? t("jobs.applicationDeadline") : event.label}
      </p>
      {!isDeadline && categoryText && (
        <p className="text-sm text-muted-foreground">{categoryText}</p>
      )}
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        {scheduledText && (
          <div>
            <dt className="text-muted-foreground">{t("jobs.stepScheduledAt")}</dt>
            <dd>{scheduledText}</dd>
          </div>
        )}
        {deadlineText && (
          <div>
            <dt className="text-muted-foreground">{t("jobs.stepDeadlineAt")}</dt>
            <dd>{deadlineText}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}
