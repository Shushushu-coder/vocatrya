"use client";

import Link from "next/link";
import { ChevronDown, Plus, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { cn } from "@/lib/utils";

const CREATE_MENU_ITEMS = [
  { key: "dashboard.job", href: "/dashboard/myjobs?add-job=true" },
  { key: "nav.tasks", href: "/dashboard/tasks?add-task=true" },
  { key: "nav.activities", href: "/dashboard/activities?add-activity=true" },
  { key: "dashboard.question", href: "/dashboard/questions?add-question=true" },
] as const;

// The global creation entries live here rather than on the overview page:
// every item deep-links into the target surface's own create flow, which
// keeps that surface's permission checks (e.g. writeFamily gating on jobs).
// Real Link hrefs keep native anchor semantics and let Next prefetch the
// deep-link targets while the dashboard renders.
//
// `compact` shrinks the controls for the 36px desktop titlebar; the default
// density still serves the in-app header on the plain web build.
export function CreateMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { freshNativeFull, jobMutationsEnabled } = useCareerSurfaces();
  const uploadHref = freshNativeFull
    ? "/dashboard/profile/resumes"
    : "/dashboard/profile";
  // In the compact titlebar the actions match the surrounding window chrome:
  // ghost icon buttons with the label carried by aria-label/title instead of
  // visible text. The web header keeps labeled outline buttons.
  const buttonVariant = compact ? "ghost" : "outline";
  const buttonClass = compact ? "h-7 w-7 gap-0 px-0" : "gap-1.5";
  const menuButtonClass = compact ? "h-7 w-auto gap-0.5 px-1.5" : "gap-1.5";

  return (
    <div className={cn("flex items-center", compact ? "gap-0.5" : "gap-2")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={buttonVariant}
            className={menuButtonClass}
            aria-label={compact ? t("dashboard.createNew") : undefined}
            title={compact ? t("dashboard.createNew") : undefined}
            data-testid="header-create-menu"
          >
            <Plus className="h-4 w-4" />
            {compact ? (
              <ChevronDown className="h-3 w-3 opacity-60" />
            ) : (
              <>
                <span className="hidden sm:inline">
                  {t("dashboard.createNew")}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {CREATE_MENU_ITEMS.filter((item) => jobMutationsEnabled || item.key !== "dashboard.job").map((item) => (
            <DropdownMenuItem key={item.href} asChild>
              <Link href={item.href}>{t(item.key)}</Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Upload is its own toolbar entry, not a create-menu item: it lands on
          the existing career-profile surface rather than opening a form. */}
      <Button
        variant={buttonVariant}
        className={buttonClass}
        data-testid="header-upload"
        asChild
      >
        <Link
          href={uploadHref}
          aria-label={compact ? t("dashboard.upload") : undefined}
          title={compact ? t("dashboard.upload") : undefined}
        >
          <Upload className="h-4 w-4" />
          {!compact && (
            <span className="hidden sm:inline">{t("dashboard.upload")}</span>
          )}
        </Link>
      </Button>
    </div>
  );
}
