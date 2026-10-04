"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { VocatryaMark } from "@/components/brand/VocatryaMark";
import { APP_CONSTANTS, SIDEBAR_LINKS } from "@/lib/constants";
import NavLink from "./NavLink";
import { ProfileDropdown } from "./ProfileDropdown";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";
import { CurrentUser } from "@/models/user.model";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { isFreshFullHiddenNavRoute } from "@/lib/career/freshSurfacePolicy";
import { getSidebarNavLabel } from "./Header";

interface SidebarProps {
  user: CurrentUser | null;
  signOutAction: () => void;
}

function Sidebar({ user, signOutAction }: SidebarProps) {
  const { t } = useI18n();
  const path = usePathname();
  const { expanded, toggle } = useSidebar();
  const { freshNativeFull } = useCareerSurfaces();

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        id={APP_CONSTANTS.SIDEBAR_DOM_ID}
        className={cn(
          "fixed inset-y-0 left-0 z-10 hidden flex-col border-r bg-background transition-[width] duration-200 ease-in-out sm:flex",
          expanded
            ? APP_CONSTANTS.SIDEBAR_WIDTH.expanded.rail
            : APP_CONSTANTS.SIDEBAR_WIDTH.collapsed.rail,
        )}
      >
        <div className="flex h-14 shrink-0 items-center overflow-hidden sm:mt-2">
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

        <div className="flex flex-col gap-1 border-t py-2">
          <ProfileDropdown
            user={user}
            expanded={expanded}
            signOutAction={signOutAction}
          />
        </div>
      </aside>
    </TooltipProvider>
  );
}

export default Sidebar;
