"use client";

import { useState } from "react";
import GeneralSettings from "@/components/settings/GeneralSettings";
import AiConnectionsCard from "@/components/settings/AiConnectionsCard";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";
import ByokConnectionsCard from "@/components/settings/ByokConnectionsCard";
import ManagedAiCard from "@/components/settings/ManagedAiCard";
import InterviewAiSettings from "@/components/settings/InterviewAiSettings";
import DataSettings from "@/components/settings/DataSettings";
import DisplaySettings from "@/components/settings/DisplaySettings";
import McpAccessSettings from "@/components/settings/McpAccessSettings";
import SettingsSidebar, { type SettingsSection } from "@/components/settings/SettingsSidebar";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

function Settings() {
  const { t } = useI18n();
  const { freshNativeFull } = useCareerSurfaces();
  const [activeSection, setActiveSection] = useState<SettingsSection>("ai-provider");

  return (
    <div className="flex flex-col col-span-3">
      <h3 className="text-2xl font-semibold leading-none tracking-tight mb-4">
        {t("settings.title")}
      </h3>
      <div className="flex gap-6">
        <SettingsSidebar
          activeSection={activeSection}
          onSectionChange={setActiveSection}
        />
        <div className="flex-1 min-w-0">
          {activeSection === "general" && <GeneralSettings />}
          {activeSection === "ai-provider" && (
            <div className="space-y-6">
              {/* Three AI routes, then the assignment surface that binds
                  businesses to one of them. InterviewAiSettings stays as
                  the legacy interview provider/model coexistence entry. */}
              <ManagedAiCard />
              <AiConnectionsCard />
              <ByokConnectionsCard />
              <AiAssignmentsCard />
              <InterviewAiSettings />
            </div>
          )}
          {activeSection === "appearance" && <DisplaySettings />}
          {activeSection === "mcp-access" && !freshNativeFull && (
            <McpAccessSettings />
          )}
          {activeSection === "data" && <DataSettings />}
        </div>
      </div>
    </div>
  );
}

export default Settings;
