"use client";

import { Bot, Database, Palette, Plug, Settings2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

export type SettingsSection =
  | "general"
  | "ai-provider"
  | "appearance"
  | "mcp-access"
  | "data";

const SETTINGS_SECTIONS: {
  id: SettingsSection;
  labelKey: string;
  icon: typeof Bot;
}[] = [
  { id: "general", labelKey: "settings.general", icon: Settings2 },
  { id: "ai-provider", labelKey: "settings.aiProvider", icon: Bot },
  { id: "appearance", labelKey: "settings.appearance", icon: Palette },
  { id: "mcp-access", labelKey: "settings.mcpAccess", icon: Plug },
  { id: "data", labelKey: "settings.dataSection", icon: Database },
];

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

export default function SettingsSidebar({
  activeSection,
  onSectionChange,
}: SettingsSidebarProps) {
  const { t } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();
  return (
    <nav className="flex w-full min-w-0 flex-col gap-1 @md/main:w-48 @md/main:shrink-0">
      {SETTINGS_SECTIONS.map((section) => {
        // MCP tokens only drive legacy writes — no fresh-native entry point.
        if (freshNativeFull && section.id === "mcp-access") return null;
        const Icon = section.icon;
        const isActive = activeSection === section.id;
        return (
          <Button
            key={section.id}
            variant="ghost"
            className={cn(
              "max-w-full justify-start gap-2 whitespace-normal rounded-none border-l-2 text-left",
              isActive
                ? "border-l-primary bg-muted font-medium"
                : "border-l-transparent hover:border-l-muted-foreground/25",
            )}
            onClick={() => onSectionChange(section.id)}
          >
            <Icon className="h-4 w-4" />
            {t(section.labelKey)}
          </Button>
        );
      })}
    </nav>
  );
}
