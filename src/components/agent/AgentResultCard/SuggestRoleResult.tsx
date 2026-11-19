"use client";

import { Button } from "@/components/ui/button";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useI18n } from "@/i18n";
import { AGENT_ROSTER, copyFor } from "@/lib/agent/roleCopy";
import { isAgentRole } from "@/lib/agent/agentRoles";
import type { AgentSuggestRoleResult } from "@/models/agent.model";

// MAO-B handoff card: the model's suggest_role call lands here as a
// one-tap transfer — the click carries the request into the sibling's
// composer as a draft. The user reviews and sends; nothing auto-sends.
export function SuggestRoleResult({
  output,
}: {
  output: AgentSuggestRoleResult;
}) {
  const { t, locale } = useI18n();
  const { transferToRole, activeRole } = useAgentChat();
  if (!isAgentRole(output.role) || !output.question) return null;
  const copy = copyFor(t, locale);
  const name = copy(AGENT_ROSTER[output.role].nameKey);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {copy("agent.suggestRoleBetterFit").replaceAll("{name}", name)}
      </p>
      {output.role !== activeRole ? (
        <div>
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => void transferToRole(output.role, output.question)}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy("agent.suggestRoleCta").replaceAll("{name}", name)}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
