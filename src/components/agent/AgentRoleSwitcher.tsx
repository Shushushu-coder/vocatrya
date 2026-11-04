"use client";

import { Telescope, Compass, MessagesSquare, type LucideIcon } from "lucide-react";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { copyFor, AGENT_ROLE_KEYS } from "@/lib/agent/roleCopy";
import { AGENT_ROLES, type AgentRole } from "@/lib/agent/agentRoles";
import { useI18n } from "@/i18n";

const ROLE_ICONS: Record<AgentRole, LucideIcon> = {
  insight: Telescope,
  pilot: Compass,
  reflect: MessagesSquare,
};

/**
 * Top-level role switcher, fixed order Insight → Pilot → Reflect — the icon
 * group that never shrinks (D7). Each button stays keyboard-reachable with
 * aria-current on the active role; the full name lives on the accessible
 * label and tooltip while the header text carries name + subtitle.
 */
export function AgentRoleSwitcher() {
  const { t, locale } = useI18n();
  const copy = copyFor(t, locale);
  const { activeRole, switchRole } = useAgentChat();

  return (
    <div
      role="group"
      aria-label={copy(AGENT_ROLE_KEYS.switcherLabel)}
      data-testid="agent-role-switcher"
      className="flex shrink-0 items-center gap-0.5 rounded-sm border bg-background/60 p-0.5"
    >
      {AGENT_ROLES.map((role) => {
        const Icon = ROLE_ICONS[role];
        const active = role === activeRole;
        const name = copy(AGENT_ROLE_KEYS.name[role]);
        return (
          <button
            key={role}
            type="button"
            aria-current={active ? "true" : undefined}
            aria-label={name}
            title={name}
            data-role={role}
            onClick={() => void switchRole(role)}
            className={`flex h-6 w-6 items-center justify-center rounded-sm transition-colors ${
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
