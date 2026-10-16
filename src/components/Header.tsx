"use client";

import Link from "next/link";
import { PanelLeft, Briefcase } from "lucide-react";

import { Button } from "./ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SIDEBAR_LINKS } from "@/lib/constants";
import { AgentChatTrigger } from "./AgentChatTrigger";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { isFreshFullHiddenNavRoute } from "@/lib/career/freshSurfacePolicy";

export function getSidebarNavLabel(
  route: string,
  fallbackLabel: string,
  t: (key: string) => string
): string {
  if (route === "/dashboard") return t("nav.dashboard");
  if (route.startsWith("/dashboard/myjobs")) return t("nav.jobs");
  if (route.startsWith("/dashboard/automations")) return t("nav.automations");
  if (route.startsWith("/dashboard/tasks")) return t("nav.tasks");
  if (route.startsWith("/dashboard/activities")) return t("nav.activities");
  if (route.startsWith("/dashboard/questions")) return t("nav.questions");
  if (route.startsWith("/dashboard/interview")) return t("nav.interview");
  if (route.startsWith("/dashboard/profile")) return t("nav.profile");
  if (route.startsWith("/dashboard/admin")) return t("nav.library");
  if (route.startsWith("/dashboard/developer")) return t("nav.developer");
  return fallbackLabel;
}

function Header() {
  const { t } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background px-4 sm:static sm:h-auto sm:border-0 sm:bg-transparent sm:px-6">
      <Sheet>
        <SheetTrigger asChild>
          <Button size="icon" variant="outline" className="sm:hidden">
            <PanelLeft className="h-5 w-5" />
            <span className="sr-only">{t("nav.toggleMenu")}</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="sm:max-w-xs">
          <SheetTitle className="sr-only">{t("nav.toggleMenu")}</SheetTitle>
          <nav className="grid gap-6 text-lg font-medium">
            <SheetClose asChild>
              <Link
                href="/dashboard"
                className="group flex h-10 w-10 shrink-0 items-center justify-center gap-2 rounded-full bg-primary text-lg font-semibold text-primary-foreground md:text-base"
              >
                <Briefcase className="h-5 w-5 transition-all group-hover:scale-110" />
                <span className="sr-only">{t("common.appTitle")}</span>
              </Link>
            </SheetClose>
            {SIDEBAR_LINKS.map((item) => {
              if (item.devOnly && process.env.NODE_ENV !== "development") {
                return null;
              }
              if (freshNativeFull && isFreshFullHiddenNavRoute(item.route)) {
                return null;
              }
              const label = getSidebarNavLabel(item.route, item.label, t);
              return (
                <SheetClose asChild key={item.label}>
                  <Link
                    href={item.route}
                    className="flex items-center gap-4 px-2.5 text-muted-foreground hover:text-foreground"
                  >
                    <item.icon className="h-5 w-5" />
                    {label}
                  </Link>
                </SheetClose>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>
      {/* The desktop titlebar carries the product identity, so the in-app
          header only keeps the mobile nav trigger and the assistant entry. */}
      <div className="relative ml-auto flex items-center gap-2">
        <AgentChatTrigger />
      </div>
    </header>
  );
}

export default Header;
