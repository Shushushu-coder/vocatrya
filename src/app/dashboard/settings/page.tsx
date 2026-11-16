"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import GeneralSettings from "@/components/settings/GeneralSettings";
import AiServicesLayout from "@/components/settings/AiServicesLayout";
import AiConnectionsCard from "@/components/settings/AiConnectionsCard";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";
import ByokConnectionsCard from "@/components/settings/ByokConnectionsCard";
import ManagedAiCard from "@/components/settings/ManagedAiCard";
import ManagedRechargeCard from "@/components/settings/ManagedRechargeCard";
import InterviewAiSettings from "@/components/settings/InterviewAiSettings";
import ArchiveSettings from "@/components/settings/ArchiveSettings";
import DataSettings from "@/components/settings/DataSettings";
import DataMigrationGuide from "@/components/settings/DataMigrationGuide";
import DisplaySettings from "@/components/settings/DisplaySettings";
import McpAccessSettings from "@/components/settings/McpAccessSettings";
import NotificationsSettings from "@/components/settings/NotificationsSettings";
import ShortcutsSettings from "@/components/settings/ShortcutsSettings";
import AudioSettings from "@/components/settings/AudioSettings";
import InputPreferencesSettings from "@/components/settings/InputPreferencesSettings";
import AboutSettings from "@/components/settings/AboutSettings";
import AdminTabsContainer from "@/components/admin/AdminTabsContainer";
import SettingsSidebar, {
  isSettingsSection,
  useSettingsText,
  type SettingsSection,
} from "@/components/settings/SettingsSidebar";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

const DEFAULT_SECTION: SettingsSection = "general";

// Assembly slots: a section in the navigation whose owner component has not
// landed yet renders an honest unavailable state instead of fabricated
// controls. Every declared section is delivered today — the map is empty but
// stays so the next pending section re-uses the mechanism instead of
// inventing a new one.
const PENDING_SECTION_META: Partial<
  Record<SettingsSection, { labelKey: string; fallbackLabel: string }>
> = {};

function SectionShell({
  id,
  title,
  children,
}: {
  id: SettingsSection;
  title?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={`settings-section-${id}`}
      className="min-w-0"
      aria-label={title}
    >
      {title ? (
        <h2 className="mb-4 text-lg font-medium break-words">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

function SectionUnavailable() {
  const text = useSettingsText();
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-dashed border-muted-foreground/25 p-4 text-sm text-muted-foreground"
      data-testid="settings-section-unavailable"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p className="break-words">
        {text(
          "settings.sectionUnavailable",
          "This settings page is not available in this build yet.",
        )}
      </p>
    </div>
  );
}

// Deep links (?section=<id> or #<id>) are read after mount so the server render
// and the hydrated tree agree on the same default section.
function readSectionFromLocation(): SettingsSection | null {
  const fromQuery = new URLSearchParams(window.location.search).get("section");
  if (isSettingsSection(fromQuery)) return fromQuery;
  const fromHash = window.location.hash.replace(/^#/, "");
  if (isSettingsSection(fromHash)) return fromHash;
  return null;
}

function Settings() {
  const { t } = useI18n();
  const text = useSettingsText();
  const { freshNativeFull } = useCareerSurfaces();
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(DEFAULT_SECTION);
  // Writing the hash inside the click handler called Next's patched
  // history.replaceState while the router was still hydrating; the resulting
  // router update tore the section commit — freshly mounted cards showed a
  // permanent "Loading settings..." because their effects never ran. The hash
  // write therefore lives in the post-commit effect below, which always runs
  // on an already-committed tree.
  const userSelectedSection = useRef(false);

  useEffect(() => {
    const linked = readSectionFromLocation();
    if (linked) setActiveSection(linked);
    // Same-document hash navigation (shared links, in-app anchors) should also
    // switch the visible page.
    const onHashChange = () => {
      const next = readSectionFromLocation();
      if (next) setActiveSection(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    // Keep the hash in sync after user-initiated section changes so refreshes
    // and shared links land on the same page; replaceState avoids a history
    // entry per click. Post-commit only — see comment above.
    if (!userSelectedSection.current) return;
    const params = new URLSearchParams(window.location.search);
    if (activeSection === "dictionary") params.set("section", "dictionary");
    else params.delete("section");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}#${activeSection}`);
  }, [activeSection]);

  const selectSection = (section: SettingsSection) => {
    userSelectedSection.current = true;
    setActiveSection(section);
  };

  return (
    <div className="col-span-3 flex min-w-0 flex-col">
      <h3 className="mb-4 text-2xl font-semibold leading-tight tracking-tight break-words">
        {t("settings.title")}
      </h3>
      {/* Query the main container, not the viewport. The app sidebar and a
          docked assistant panel shrink this box without changing the window.
          Below @md/main (28rem) the nav groups wrap into full-width rows. */}
      <div className="flex min-w-0 flex-col gap-4 @md/main:flex-row @md/main:gap-6">
        <SettingsSidebar
          activeSection={activeSection}
          onSectionChange={selectSection}
        />
        <div className="min-w-0 max-w-5xl flex-1">
          {activeSection === "general" && (
            // GeneralSettings renders its own page-level title.
            <SectionShell id="general">
              <GeneralSettings />
            </SectionShell>
          )}
          {activeSection === "notifications" && (
            // NotificationsSettings renders its own page-level title.
            <SectionShell id="notifications">
              <NotificationsSettings />
            </SectionShell>
          )}
          {activeSection === "appearance" && (
            // DisplaySettings renders its own page-level title.
            <SectionShell id="appearance">
              <DisplaySettings />
            </SectionShell>
          )}
          {activeSection === "ai-services" && (
            <SectionShell
              id="ai-services"
              title={text("settings.sections.aiServices", "AI Services")}
            >
              <AiServicesLayout>
                <ManagedAiCard />
                <AiConnectionsCard />
                <ByokConnectionsCard />
              </AiServicesLayout>
            </SectionShell>
          )}
          {activeSection === "ai-assignments" && (
            <SectionShell
              id="ai-assignments"
              title={text("settings.sections.aiAssignments", "AI Assignments")}
            >
              <div className="space-y-6">
                {/* Business assignment binds consumers to a connection/model —
                    a different concept from connection management.
                    InterviewAiSettings stays as the legacy compat entry on this
                    page per the frozen scope. */}
                <AiAssignmentsCard />
                <InterviewAiSettings />
              </div>
            </SectionShell>
          )}
          {activeSection === "subscription" && (
            <SectionShell
              id="subscription"
              title={text("settings.sections.subscription", "Subscription")}
            >
              <ManagedRechargeCard />
            </SectionShell>
          )}
          {activeSection === "shortcuts" && (
            // ShortcutsSettings renders its own page-level title.
            <SectionShell id="shortcuts">
              <ShortcutsSettings />
            </SectionShell>
          )}
          {activeSection === "audio" && (
            // AudioSettings renders its own page-level title.
            <SectionShell id="audio">
              <AudioSettings />
            </SectionShell>
          )}
          {activeSection === "input" && (
            // InputPreferencesSettings renders its own page-level title.
            <SectionShell id="input">
              <InputPreferencesSettings />
            </SectionShell>
          )}
          {activeSection === "dictionary" && (
            <SectionShell id="dictionary" title={text("settings.sections.bulkEdit", "Bulk Edit")}>
              <AdminTabsContainer />
            </SectionShell>
          )}
          {activeSection === "data-privacy" && (
            <SectionShell
              id="data-privacy"
              title={text("settings.sections.dataPrivacy", "Data & Privacy")}
            >
              <div className="space-y-6">
                <DataMigrationGuide />
                <DataSettings />
                {/* MCP token management stays reachable as a compat sub-area
                    inside Data & Privacy; fresh-native surfaces still hide it. */}
                {!freshNativeFull && <McpAccessSettings />}
              </div>
            </SectionShell>
          )}
          {activeSection === "archive-data" && (
            <SectionShell
              id="archive-data"
              title={text("settings.sections.archiveData", "Archived Data")}
            >
              <ArchiveSettings />
            </SectionShell>
          )}
          {activeSection === "about" && (
            // AboutSettings renders its own page-level title.
            <SectionShell id="about">
              <AboutSettings />
            </SectionShell>
          )}
          {PENDING_SECTION_META[activeSection] && (
            <SectionShell
              id={activeSection}
              title={text(
                PENDING_SECTION_META[activeSection]!.labelKey,
                PENDING_SECTION_META[activeSection]!.fallbackLabel,
              )}
            >
              <SectionUnavailable />
            </SectionShell>
          )}
        </div>
      </div>
    </div>
  );
}

export default Settings;
