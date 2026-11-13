import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// EXT-INTERVIEW-WEB compatibility gate: inside the Electron shell the
// built-in practice UI is retired, so old /dashboard/interview bookmarks and
// history links land on a pointer to the extensions area instead. The web
// build keeps the full practice pages — the swap is CSS-gated on
// data-desktop (set by preload before first paint), never auto-opens a
// browser, and never redirects or deletes history data.
export default async function InterviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = await getServerI18n();
  return (
    <>
      <div
        className="desktop-only col-span-3 w-full"
        data-testid="interview-moved-notice"
      >
        <Card>
          <CardContent className="flex flex-col items-start gap-3 px-4 py-4">
            <h1 className="text-lg font-semibold">
              {t("extensions.interviewMovedTitle")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("extensions.interviewMovedDescription")}
            </p>
            <Button asChild>
              <Link href="/dashboard/extensions">
                {t("extensions.interviewMovedCta")}
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
      <div className="desktop-hidden" data-testid="interview-practice-surface">
        {children}
      </div>
    </>
  );
}
