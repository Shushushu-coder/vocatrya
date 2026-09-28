import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import {
  getInterviewReadinessAction,
  listInterviewSessionsAction,
} from "@/actions/interview.actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.interview") };
}

function sessionTitle(
  card: { jobTitle: string | null; companyName: string | null },
  generic: string,
): string {
  if (card.jobTitle) {
    return card.companyName
      ? `${card.companyName} · ${card.jobTitle}`
      : card.jobTitle;
  }
  return generic;
}

export default async function InterviewLandingPage() {
  const { t, formatDate } = await getServerI18n();
  const [readinessResult, sessionsResult] = await Promise.all([
    getInterviewReadinessAction(),
    listInterviewSessionsAction(),
  ]);
  const readiness =
    readinessResult.success && "data" in readinessResult
      ? readinessResult.data
      : null;
  const ready = readiness?.status === "ready";
  const history =
    sessionsResult.success && "data" in sessionsResult ? sessionsResult.data : [];

  const statusLabel = (status: string): string => {
    switch (status) {
      case "IN_PROGRESS":
      case "COACHING":
        return t("interview.statusInProgress");
      case "COMPLETED":
        return t("interview.statusCompleted");
      case "ARCHIVED":
        return t("interview.statusArchived");
      default:
        return t("interview.statusDraft");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">{t("interview.title")}</h1>
        {ready ? (
          <Button asChild>
            <Link href="/dashboard/interview/new">
              {t("interview.startInterview")}
            </Link>
          </Button>
        ) : (
          <Button disabled>{t("interview.startInterview")}</Button>
        )}
      </div>
      {!ready && (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 pt-6">
            <p className="text-sm text-muted-foreground">
              {t("interview.needsAiSetup")}
            </p>
            <Button asChild variant="outline">
              <Link href="/dashboard/settings">{t("interview.goSettings")}</Link>
            </Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("interview.history")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("interview.emptyHistory")}
            </p>
          ) : (
            <ul className="space-y-2">
              {history.map((card) => {
                const dateText = formatDate(card.session.createdAt, {
                  month: "short",
                  day: "numeric",
                });
                const progress =
                  card.session.status === "COMPLETED"
                    ? t("interview.questionsTotal", {
                        total: card.totalQuestions,
                      })
                    : t("interview.questionsProgress", {
                        done: card.answeredQuestions,
                        total: card.totalQuestions,
                      });
                return (
                  <li key={card.session.id}>
                    <Link
                      className="block rounded-md border px-3 py-2 text-sm hover:bg-accent"
                      href={`/dashboard/interview/${card.session.id}`}
                    >
                      <span className="font-medium">
                        {sessionTitle(card, t("interview.genericSession"))}
                      </span>
                      <span className="ml-2 text-muted-foreground">
                        {dateText} · {statusLabel(card.session.status)} ·{" "}
                        {progress}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
