"use client";

import { Download, Sparkles } from "lucide-react";
import { useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { BUILT_IN_SKILLS } from "@/lib/agent/skills/registry";

export default function SkillsPanel() {
  const { t } = useI18n();
  const { open } = useAgentChat();
  return (
    <div className="grid gap-4">
      <div
        data-testid="extensions-skills-list"
        className="grid grid-cols-1 gap-4 @md/main:grid-cols-2 @3xl/main:grid-cols-3"
      >
        {BUILT_IN_SKILLS.map((skill) => {
          const base = `extensions.skills.items.${skill.i18nKey}`;
          const role = t(`extensions.skills.roles.${skill.hostRole}`);
          return (
            <Card
              key={skill.id}
              data-testid={`extensions-skill-${skill.i18nKey}`}
              className="h-full"
            >
              <CardContent className="flex h-full flex-col gap-3 px-4 py-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">{t(`${base}.name`)}</h2>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(`${base}.description`)}
                </p>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={`extensions-skill-${skill.i18nKey}-host`}
                >
                  {t("extensions.skills.hostedBy", { role })}
                </p>
                <Badge
                  variant="secondary"
                  className="w-fit"
                  data-testid={`extensions-skill-${skill.i18nKey}-status`}
                >
                  {t(`extensions.skills.modes.${skill.mode}`)}
                </Badge>
                <p className="text-xs text-muted-foreground">
                  {t(`${base}.howToStart`)}
                </p>
                <div className="mt-auto">
                  <Button
                    type="button"
                    onClick={() => open({ role: skill.hostRole })}
                    data-testid={`extensions-skill-${skill.i18nKey}-cta`}
                  >
                    {t("extensions.skills.openHost", { role })}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card data-testid="extensions-skill-import" className="max-w-xl">
        <CardContent className="flex flex-col gap-3 px-4 py-4">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {t("extensions.skills.import.name")}
            </h2>
            <Badge variant="outline">
              {t("extensions.skills.import.comingSoon")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("extensions.skills.import.note")}
          </p>
          <div>
            <Button
              type="button"
              disabled
              data-testid="extensions-skill-import-cta"
            >
              {t("extensions.skills.import.cta")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
