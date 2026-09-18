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
import { toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

function bucketTitle(id: UpcomingBucketId, t: (key: string) => string): string {
  if (id === UPCOMING_BUCKET_ID.overdue) return t("jobs.upcomingOverdue");
  if (id === UPCOMING_BUCKET_ID.today) return t("jobs.upcomingToday");
  if (id === UPCOMING_BUCKET_ID.next7Days) return t("jobs.upcomingNext7Days");
  return t("jobs.upcomingLater");
}

export function UpcomingContainer() {
  const { t, formatDate } = useI18n();
  const [events, setEvents] = useState<UpcomingApplicationEvent[] | null>(null);

  const load = useCallback(async () => {
    const result = await listUpcomingApplicationEvents();
    if (!result.success) {
      toastError(result.message);
      setEvents([]);
      return;
    }
    setEvents(result.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buckets = useMemo(
    () => (events ? bucketUpcomingApplicationEvents(events) : []),
    [events],
  );

  if (events === null) {
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
                      formatDate={formatDate}
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

function UpcomingEventItem({
  event,
  formatDate,
  t,
}: {
  event: UpcomingApplicationEvent;
  formatDate: (value: Date | string | number | null | undefined) => string;
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
        {event.scheduledAt && (
          <div>
            <dt className="text-muted-foreground">{t("jobs.stepScheduledAt")}</dt>
            <dd>{formatDate(event.scheduledAt)}</dd>
          </div>
        )}
        {event.deadlineAt && (
          <div>
            <dt className="text-muted-foreground">{t("jobs.stepDeadlineAt")}</dt>
            <dd>{formatDate(event.deadlineAt)}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}
