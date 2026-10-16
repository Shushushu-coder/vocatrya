"use client";

import { useState } from "react";
import { CircleHelp, Settings, type LucideProps } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VocatryaMark } from "@/components/brand/VocatryaMark";
import { APP_CONSTANTS, SIDEBAR_LINKS } from "@/lib/constants";
import NavLink from "./NavLink";
import { ProfileDropdown } from "./ProfileDropdown";
import { SupportDialog } from "./SupportDialog";
import { useAppVersion } from "@/hooks/useAppVersion";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";
import { CurrentUser } from "@/models/user.model";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { isFreshFullHiddenNavRoute } from "@/lib/career/freshSurfacePolicy";
import { getSidebarNavLabel } from "./Header";

// Same row geometry as NavLink (fixed 56px icon cell + fading label) so the
// bottom utility entries line up with the business nav in both rail states.
function SidebarAction({
  label,
  Icon,
  onClick,
  expanded,
}: {
  label: string;
  Icon: React.ComponentType<LucideProps>;
  onClick: () => void;
  expanded: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="navlink h-10 w-full text-muted-foreground hover:text-foreground"
        >
          <span className="flex h-full w-14 shrink-0 items-center justify-center">
            <Icon className="h-6 w-6 shrink-0" strokeWidth={1.5} />
          </span>
          <span
            className={cn(
              "truncate text-sm transition-opacity duration-200",
              expanded ? "opacity-100 delay-100" : "opacity-0",
            )}
          >
            {label}
          </span>
        </button>
      </TooltipTrigger>
      {!expanded && <TooltipContent side="right">{label}</TooltipContent>}
    </Tooltip>
  );
}

function SidebarFooter({
  user,
  expanded,
  signOutAction,
}: {
  user: CurrentUser | null;
  expanded: boolean;
  signOutAction: () => void;
}) {
  const { t } = useI18n();
  const path = usePathname();
  const version = useAppVersion();
  const [supportOpen, setSupportOpen] = useState(false);
  const openSupport = () => setSupportOpen(true);

  return (
    <div className="flex flex-col gap-1 border-t py-2">
      <SidebarAction
        label={t("nav.helpFeedback")}
        Icon={CircleHelp}
        onClick={openSupport}
        expanded={expanded}
      />
      <NavLink
        label={t("nav.settings")}
        Icon={Settings}
        route="/dashboard/settings"
        pathname={path}
        expanded={expanded}
      />
      <ProfileDropdown
        user={user}
        expanded={expanded}
        signOutAction={signOutAction}
        version={version}
        onOpenSupport={openSupport}
      />
      <SupportDialog
        open={supportOpen}
        onOpenChange={setSupportOpen}
        version={version}
      />
    </div>
  );
}

interface SidebarProps {
  user: CurrentUser | null;
  signOutAction: () => void;
}

function Sidebar({ user, signOutAction }: SidebarProps) {
  const { t } = useI18n();
  const path = usePathname();
  const { expanded, width, isResizing, toggle, startResize, resizeByKey } =
    useSidebar();
  const { freshNativeFull } = useCareerSurfaces();

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        id={APP_CONSTANTS.SIDEBAR_DOM_ID}
        className={cn(
          // Inset workbench panel: floats on the muted workspace background
          // instead of running a full-height hard divider down the window.
          // Sticky offset reserves room for the desktop titlebar; the CSS
          // var is 0 outside Electron so the web layout is unchanged.
          "sticky top-[calc(var(--desktop-titlebar-height,0px)+1rem)] z-10 my-4 ml-4 hidden h-[calc(100vh-var(--desktop-titlebar-height,0px)-2rem)] shrink-0 flex-col self-start rounded-xl border bg-background shadow-sm sm:flex",
          // Following the drag handle late reads as lag, not animation.
          isResizing
            ? "transition-none"
            : "transition-[width] duration-200 ease-in-out",
        )}
        style={{
          width: expanded ? width : APP_CONSTANTS.SIDEBAR_WIDTH_PX.collapsed,
        }}
      >
        <div className="flex h-14 shrink-0 items-center overflow-hidden">
          <div className="flex w-14 shrink-0 items-center justify-center">
            <button
              type="button"
              onClick={toggle}
              aria-label={t(expanded ? "common.collapseSidebar" : "common.expandSidebar")}
              aria-expanded={expanded}
              aria-controls={APP_CONSTANTS.SIDEBAR_DOM_ID}
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8 md:w-8"
            >
              <VocatryaMark size={24} />
            </button>
          </div>
          <span
            className={cn(
              "truncate font-semibold transition-opacity duration-200",
              expanded ? "opacity-100 delay-100" : "opacity-0",
            )}
          >
            Vocatrya
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto py-2">
          {SIDEBAR_LINKS.map((item) => {
            // Only show dev-only items in development mode
            if (item.devOnly && process.env.NODE_ENV !== "development") {
              return null;
            }
            if (freshNativeFull && isFreshFullHiddenNavRoute(item.route)) {
              return null;
            }
            const label = getSidebarNavLabel(item.route, item.label, t);
            return (
              <NavLink
                key={item.label}
                label={label}
                Icon={item.icon}
                route={item.route}
                pathname={path}
                expanded={expanded}
              />
            );
          })}
        </nav>

        <SidebarFooter
          user={user}
          expanded={expanded}
          signOutAction={signOutAction}
        />

        {/* Edge resize handle. Below the collapse threshold the rail snaps
            shut; from the rail, dragging right (or ArrowRight / double-click)
            expands again. Sits in the margin gap so it never covers content. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("common.resizeSidebar")}
          aria-valuenow={expanded ? width : APP_CONSTANTS.SIDEBAR_WIDTH_PX.collapsed}
          aria-valuemin={APP_CONSTANTS.SIDEBAR_WIDTH_PX.collapsed}
          aria-valuemax={APP_CONSTANTS.SIDEBAR_WIDTH_PX.max}
          tabIndex={0}
          data-testid="sidebar-resize-handle"
          onMouseDown={startResize}
          onKeyDown={resizeByKey}
          onDoubleClick={toggle}
          className="group absolute -right-2 top-0 h-full w-3 cursor-col-resize outline-none"
        >
          <div className="mx-auto h-full w-px transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary/50" />
        </div>
      </aside>
    </TooltipProvider>
  );
}

export default Sidebar;
