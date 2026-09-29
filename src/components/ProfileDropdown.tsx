"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PowerIcon, Settings, Info, ArrowUpCircle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import UserAvatar from "./UserAvatar";
import { SupportDialog } from "./SupportDialog";
import { useAppVersion } from "@/hooks/useAppVersion";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface ProfileDropdownProps {
  user: any;
  expanded: boolean;
  signOutAction: () => void;
}

export function ProfileDropdown({
  user,
  expanded,
  signOutAction,
}: ProfileDropdownProps) {
  const { t } = useI18n();
  const [supportDialogOpen, setSupportDialogOpen] = useState(false);
  const version = useAppVersion();
  const label = user?.email ?? t("nav.userMenu");

  // Radix emits a useId-derived id on the trigger that can drift between the
  // SSR pass and hydration when a lazy module suspends mid-render
  // (radix-ui/primitives#3700). Render a static button until mounted — the
  // server HTML and the first client render are then byte-identical.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const triggerContent = (
    <>
      <span className="relative flex h-full w-14 shrink-0 items-center justify-center">
        <UserAvatar user={user} />
        {version?.updateAvailable && (
          <>
            <span
              aria-hidden
              className="absolute right-3 top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background"
            />
            <span className="sr-only">{t("nav.updateAvailable")}</span>
          </>
        )}
      </span>
      <span
        className={cn(
          "truncate text-sm transition-opacity duration-200",
          expanded ? "opacity-100 delay-100" : "opacity-0"
        )}
      >
        {label}
      </span>
    </>
  );

  return (
    <>
      {mounted ? (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("nav.userMenu")}
                className="navlink h-10 w-full text-muted-foreground hover:text-foreground"
              >
                {triggerContent}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {!expanded && <TooltipContent side="right">{label}</TooltipContent>}
        </Tooltip>
        <DropdownMenuContent side="right" align="end">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/dashboard/settings" className="cursor-pointer">
              <Settings className="w-5 mr-2" />
              {t("nav.settings")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setSupportDialogOpen(true)}
            className="cursor-pointer"
          >
            <Info className="w-5 mr-2" />
            {t("nav.support")}
          </DropdownMenuItem>
          {version?.updateAvailable && (
            <DropdownMenuItem
              onClick={() => setSupportDialogOpen(true)}
              className="cursor-pointer text-primary focus:text-primary"
            >
              <ArrowUpCircle className="w-5 mr-2" />
              {t("nav.updateAvailable")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="cursor-pointer">
            <form action={signOutAction}>
              <button type="submit" className="flex w-full items-center">
                <PowerIcon className="w-5 mr-2" />
                <div className="hidden md:block">{t("nav.logout")}</div>
              </button>
            </form>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      ) : (
        <button
          type="button"
          aria-label={t("nav.userMenu")}
          className="navlink h-10 w-full text-muted-foreground hover:text-foreground"
        >
          {triggerContent}
        </button>
      )}

      <SupportDialog
        open={supportDialogOpen}
        onOpenChange={setSupportDialogOpen}
        version={version}
      />
    </>
  );
}
