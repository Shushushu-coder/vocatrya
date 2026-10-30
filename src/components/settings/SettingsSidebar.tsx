"use client";

import {
  Bell,
  Bot,
  Database,
  Files,
  Library,
  Info,
  Keyboard,
  Palette,
  Settings2,
  SlidersHorizontal,
  TextCursorInput,
  Volume2,
} from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";
import { hasTranslation, useI18n } from "@/i18n";

// The settings host mounts the panel for each stable section id.
export type SettingsSection =
  | "general"
  | "notifications"
  | "appearance"
  | "ai-services"
  | "ai-assignments"
  | "shortcuts"
  | "audio"
  | "input"
  | "dictionary"
  | "resume-variants"
  | "data-privacy"
  | "about";

export interface SettingsSectionMeta {
  id: SettingsSection;
  /** i18n key owned by INT-01; declared by this package, landed separately. */
  labelKey: string;
  /** Shown while the declared key is absent from the locale bundles. */
  fallbackLabel: string;
  icon: typeof Bot;
}

export interface SettingsSectionGroup {
  id: "preferences" | "ai" | "devices" | "career" | "data-support";
  labelKey: string;
  fallbackLabel: string;
  sections: readonly SettingsSectionMeta[];
}

export const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroup[] = [
  {
    id: "preferences",
    labelKey: "settings.groups.preferences",
    fallbackLabel: "Preferences",
    sections: [
      { id: "general", labelKey: "settings.general", fallbackLabel: "General", icon: Settings2 },
      { id: "notifications", labelKey: "settings.sections.notifications", fallbackLabel: "Notifications", icon: Bell },
      { id: "appearance", labelKey: "settings.appearance", fallbackLabel: "Appearance", icon: Palette },
    ],
  },
  {
    id: "ai",
    labelKey: "settings.ai",
    fallbackLabel: "AI",
    sections: [
      { id: "ai-services", labelKey: "settings.sections.aiServices", fallbackLabel: "AI Services", icon: Bot },
      { id: "ai-assignments", labelKey: "settings.sections.aiAssignments", fallbackLabel: "AI Assignments", icon: SlidersHorizontal },
    ],
  },
  {
    id: "devices",
    labelKey: "settings.groups.devices",
    fallbackLabel: "Devices & Input",
    sections: [
      { id: "shortcuts", labelKey: "settings.sections.shortcuts", fallbackLabel: "Shortcuts", icon: Keyboard },
      { id: "audio", labelKey: "settings.sections.audio", fallbackLabel: "Audio", icon: Volume2 },
      { id: "input", labelKey: "inputPrefs.navLabel", fallbackLabel: "Input Preferences", icon: TextCursorInput },
    ],
  },
  {
    id: "career",
    labelKey: "settings.groups.career",
    fallbackLabel: "Career Management",
    sections: [
      { id: "dictionary", labelKey: "settings.sections.bulkEdit", fallbackLabel: "Bulk Edit", icon: Library },
      { id: "resume-variants", labelKey: "resumeVariants.title", fallbackLabel: "Resume Variants", icon: Files },
    ],
  },
  {
    id: "data-support",
    labelKey: "settings.groups.dataSupport",
    fallbackLabel: "Data & Support",
    sections: [
      { id: "data-privacy", labelKey: "settings.sections.dataPrivacy", fallbackLabel: "Data & Privacy", icon: Database },
      { id: "about", labelKey: "settings.sections.about", fallbackLabel: "About", icon: Info },
    ],
  },
];

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] =
  SETTINGS_SECTION_GROUPS.flatMap((group) => group.sections);

export function isSettingsSection(
  value: string | null | undefined,
): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

// Declared keys ship to INT-01 separately; until they land in the locale
// bundles the frozen English fallback keeps navigation labels readable.
export function useSettingsText() {
  const { t, locale } = useI18n();
  return (key: string, fallback: string) =>
    hasTranslation(locale, key) ? t(key) : fallback;
}

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

export default function SettingsSidebar({
  activeSection,
  onSectionChange,
}: SettingsSidebarProps) {
  const { t } = useI18n();
  const text = useSettingsText();
  return (
    <nav
      aria-label={t("settings.title")}
      className="w-full min-w-0 @md/main:w-56 @md/main:shrink-0"
      data-testid="settings-nav"
    >
      <div className="flex min-w-0 flex-col gap-4 @md/main:gap-5">
        {SETTINGS_SECTION_GROUPS.map((group) => {
          const groupLabel = text(group.labelKey, group.fallbackLabel);
          return (
            <div
              key={group.id}
              role="group"
              aria-label={groupLabel}
              className="flex min-w-0 flex-row flex-wrap items-center gap-1 @md/main:flex-col @md/main:flex-nowrap @md/main:items-stretch @md/main:gap-0.5"
            >
              <p className="w-full px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground @md/main:w-auto @md/main:px-3">
                {groupLabel}
              </p>
              {group.sections.map((section) => {
                const Icon = section.icon;
                const isActive = activeSection === section.id;
                return (
                  <Button
                    key={section.id}
                    variant="ghost"
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "max-w-full justify-start gap-2 whitespace-nowrap rounded-none border-l-2 text-left @md/main:whitespace-normal",
                      isActive
                        ? "border-l-primary bg-muted font-medium"
                        : "border-l-transparent hover:border-l-muted-foreground/25",
                    )}
                    onClick={() => onSectionChange(section.id)}
                  >
                    <Icon className="h-4 w-4" />
                    {text(section.labelKey, section.fallbackLabel)}
                  </Button>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
