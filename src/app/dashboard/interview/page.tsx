import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import {
  getInterviewConfigAction,
  listInterviewSessionsAction,
} from "@/actions/interview.actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.interview") };
}

export default async function InterviewLandingPage() {
  const { t } = await getServerI18n();
  const [config, sessions] = await Promise.all([
    getInterviewConfigAction(),
    listInterviewSessionsAction(),
  ]);
  const configured = config.success && "data" in config ? config.data.configured : false;
  const history = sessions.success && "data" in sessions ? sessions.data : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("interview.title")}</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("interview.aiStatus")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {configured ? t("interview.configured") : t("interview.notConfigured")}
          </p>
          {!configured && (
            <Button asChild variant="outline">
              <Link href="/dashboard/settings">{t("interview.goSettings")}</Link>
            </Button>
          )}
        </CardContent>
      </Card>
      <div className="flex gap-3">
        <Button asChild disabled={!configured}>
          <Link href="/dashboard/interview/new">{t("interview.startNew")}</Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("interview.history")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("interview.emptyHistory")}</p>
          ) : (
            <ul className="space-y-2">
              {history.map((session) => (
                <li key={session.id}>
                  <Link
                    className="text-sm underline"
                    href={`/dashboard/interview/${session.id}`}
                  >
                    {session.status} · {session.coachingMode} · {session.id.slice(0, 8)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
