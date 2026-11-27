"use client";

import type { AgentRole } from "@/lib/agent/agentRoles";
import { cn } from "@/lib/utils";

/**
 * Original companion-robot avatars for the three Vocatrya roles (AUC-AVATARS).
 * Shared geometric family, distinguishable by silhouette, expression, and
 * signature accessory even at 16–24px without relying on color alone:
 * - pilot (执行助手): navigator visor + directional compass crest (action-ready)
 * - insight (职业顾问): dual optical monocle/analysis lens + antenna (analytical)
 * - reflect (复盘教练): warm rounded hood + gentle smile + spark crest (empathetic)
 */
export function AgentRoleAvatar({
  role,
  size = 24,
  className,
  label,
}: {
  role: AgentRole | null | undefined;
  size?: number;
  className?: string;
  label?: string;
}) {
  const effective: AgentRole = role ?? "pilot";
  const palette: Record<AgentRole, string> = {
    pilot: "bg-sky-500/12 text-sky-700 ring-sky-500/25 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/30",
    insight: "bg-violet-500/12 text-violet-700 ring-violet-500/25 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/30",
    reflect: "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30",
  };

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full ring-1",
        palette[effective],
        className,
      )}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid={`agent-avatar-${effective}`}
    >
      <svg
        width={Math.round(size * 0.72)}
        height={Math.round(size * 0.72)}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {effective === "pilot" ? (
          <>
            {/* Compass crest + sleek navigator visor */}
            <path
              d="M12 2.5L14 6.2H10L12 2.5Z"
              fill="currentColor"
            />
            <rect
              x="4"
              y="7"
              width="16"
              height="12.5"
              rx="5"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <rect
              x="7.2"
              y="10.4"
              width="9.6"
              height="4.4"
              rx="2.2"
              fill="currentColor"
              fillOpacity="0.2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle cx="10.2" cy="12.6" r="1.05" fill="currentColor" />
            <circle cx="13.8" cy="12.6" r="1.05" fill="currentColor" />
            <path
              d="M9.8 16.8H14.2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </>
        ) : effective === "insight" ? (
          <>
            {/* Signal node + asymmetric analysis monocle */}
            <line
              x1="12"
              y1="3.2"
              x2="12"
              y2="6.8"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
            <circle cx="12" cy="2.8" r="1.3" fill="currentColor" />
            <rect
              x="4.2"
              y="7"
              width="15.6"
              height="12.5"
              rx="4.2"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <circle
              cx="9.3"
              cy="12.7"
              r="2.6"
              fill="currentColor"
              fillOpacity="0.18"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="9.3" cy="12.7" r="0.9" fill="currentColor" />
            <circle cx="15.1" cy="12.7" r="1.25" fill="currentColor" />
            <path
              d="M11.9 12.7H13.6"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
            <path
              d="M10.2 16.9L12 16.3L13.8 16.9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            {/* Rounded coach ear-pads + warm smiling eyes */}
            <path
              d="M12 2.8C12.5 4.4 13.6 5.2 15 5.4C13.6 5.6 12.5 6.4 12 7.4C11.5 6.4 10.4 5.6 9 5.4C10.4 5.2 11.5 4.4 12 2.8Z"
              fill="currentColor"
            />
            <path
              d="M3.2 11.5V15M20.8 11.5V15"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <rect
              x="5"
              y="7.4"
              width="14"
              height="12.2"
              rx="6"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M8.5 12.4C9 11.5 10.1 11.5 10.6 12.4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d="M13.4 12.4C13.9 11.5 15 11.5 15.5 12.4"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <path
              d="M9.6 15.8C10.3 16.9 13.7 16.9 14.4 15.8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </span>
  );
}
