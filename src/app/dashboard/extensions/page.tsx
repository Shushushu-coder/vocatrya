import Link from "next/link";
import { ClipboardList, ExternalLink, Mic, Notebook } from "lucide-react";
import { getServerI18n } from "@/i18n/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getInterviewPracticeUrl } from "@/lib/extensions/interviewPractice";
import { getCurrentUser } from "@/utils/user.utils";
import prisma from "@/lib/db";
import { getAutoApplyExtensionStatus } from "@/lib/extensions/autoApply/status";
import { getNotionExtensionState } from "@/lib/extensions/notion/service";
import ExtensionsTabs, { resolveExtensionsTab } from "./ExtensionsTabs";
import SkillsPanel from "./SkillsPanel";
import { notionT } from "@/lib/extensions/notion/copy";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.extensions") };
}

// Unified extension-tools list (frozen UI decision 2026-11-12): three
// equal-width cards that wrap on narrow widths. Cards carry icon, name,
// one-line description, an honest status, and a single primary CTA — complex
// configuration lives on the tool detail pages, never inside a card.
export default async function ExtensionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialTab = resolveExtensionsTab((await searchParams).tab);
  const { t, locale } = await getServerI18n();
  const interviewPracticeUrl = getInterviewPracticeUrl();
  const user = await getCurrentUser();
  const [autoApply, notion] = user
    ? await Promise.allSettled([
        getAutoApplyExtensionStatus(prisma, user.id),
        getNotionExtensionState(user.id),
      ])
    : [];
  const autoApplyStatus =
    autoApply?.status === "fulfilled"
      ? t(
          !autoApply.value.available
            ? "extensions.autoApply.unavailable"
            : autoApply.value.connections.active > 0
              ? "extensions.autoApply.connected"
              : "extensions.autoApply.available",
        )
      : t("extensions.autoApply.statusError");
  const notionState = notion?.status === "fulfilled" ? notion.value : null;
  const notionStatus = notionState
    ? notionT(
        locale,
        `status.${notionState.status.toLowerCase()}` as
          | "status.connected"
          | "status.connecting"
          | "status.disconnected"
          | "status.reauth_required",
      )
    : t("extensions.notion.statusError");

  const connectionsPanel = (
    <div
      data-testid="extensions-list"
      className="grid grid-cols-1 gap-4 @md/main:grid-cols-2 @3xl/main:grid-cols-3"
    >
      <Card data-testid="extensions-card-notion" className="h-full">
        <CardContent className="flex h-full flex-col gap-3 px-4 py-4">
          <div className="flex items-center gap-2">
            <Notebook className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("extensions.notion.name")}
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("extensions.notion.description")}
          </p>
          <Badge
            variant="secondary"
            className="w-fit"
            data-testid="extensions-notion-status"
          >
            {notionStatus}
          </Badge>
          <div className="mt-auto">
            <Button asChild>
              <Link
                href="/dashboard/extensions/notion"
                data-testid="extensions-notion-cta"
              >
                {t(
                  notionState?.status === "CONNECTED"
                    ? "extensions.notion.manageCta"
                    : "extensions.notion.cta",
                )}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
  const companionPanel = (
    <div
      data-testid="extensions-list"
      className="grid grid-cols-1 gap-4 @md/main:grid-cols-2 @3xl/main:grid-cols-3"
    >
      <Card data-testid="extensions-card-auto-apply" className="h-full">
        <CardContent className="flex h-full flex-col gap-3 px-4 py-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("extensions.autoApply.name")}
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("extensions.autoApply.description")}
          </p>
          <Badge
            variant="secondary"
            className="w-fit"
            data-testid="extensions-auto-apply-status"
          >
            {autoApplyStatus}
          </Badge>
          <div className="mt-auto">
            <Button asChild>
              <Link
                href="/dashboard/extensions/auto-apply"
                data-testid="extensions-auto-apply-cta"
              >
                {t("extensions.autoApply.cta")}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="extensions-card-interview" className="h-full">
        <CardContent className="flex h-full flex-col gap-3 px-4 py-4">
          <div className="flex items-center gap-2">
            <Mic className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("extensions.interview.name")}
            </h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("extensions.interview.description")}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            {t("extensions.interview.browserHint")}
          </p>
          {interviewPracticeUrl ? (
            <Badge
              variant="outline"
              className="w-fit"
              data-testid="extensions-interview-status"
            >
              {t("extensions.interview.ready")}
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="w-fit"
              data-testid="extensions-interview-status"
            >
              {t("extensions.interview.unavailable")}
            </Badge>
          )}
          <div className="mt-auto">
            {interviewPracticeUrl ? (
              // target=_blank inside Electron is routed to the system
              // browser by configureNavigation's setWindowOpenHandler;
              // on the web host it is a safe new tab.
              <Button asChild>
                <a
                  href={interviewPracticeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="extensions-interview-cta"
                >
                  {t("extensions.interview.cta")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            ) : (
              <Button disabled data-testid="extensions-interview-cta">
                {t("extensions.interview.cta")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );

  return (
    <div className="col-span-3 mx-auto grid w-full max-w-[1400px] min-w-0 auto-rows-max gap-4">
      <h1 className="text-2xl font-semibold">{t("extensions.title")}</h1>
      <ExtensionsTabs
        initialTab={initialTab}
        labels={{
          connections: t("extensions.tabs.connections"),
          skills: t("extensions.tabs.skills"),
          companion: t("extensions.tabs.companion"),
        }}
        panels={{
          connections: connectionsPanel,
          skills: <SkillsPanel />,
          companion: companionPanel,
        }}
      />
    </div>
  );
}
