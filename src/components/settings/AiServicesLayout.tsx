"use client";

import { createContext, useContext, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";

// Slots are scoped by the two service paths: official Agent account sign-in
// (first tab) and app-managed AI (second tab) — the latter holds both the
// user's own provider APIs and the Vocatrya-hosted API. Connected/available
// stays a secondary grouping inside each tab, never the page-level split.
type Placement =
  | "account-connected"
  | "account-available"
  | "byok-connected"
  | "byok-available"
  | "managed-connected"
  | "managed-available"
  | "support";
const ServiceTargets = createContext<Record<Placement, HTMLDivElement | null> | null>(null);

export function useAiServicesLayout() {
  return useContext(ServiceTargets) !== null;
}

// Keep each credential controller mounted once while placing its cards by
// state. Moving between slots — and switching tabs — never destroys the
// controller's OAuth or form state.
export function AiServiceSlot({ placement, children }: { placement: Placement; children: ReactNode }) {
  const targets = useContext(ServiceTargets);
  if (!targets) return children;
  const target = targets[placement];
  return target ? createPortal(children, target) : null;
}

const SERVICE_TABS = [
  { id: "account", labelKey: "settings.aiServicesTabAccount" },
  { id: "managed", labelKey: "settings.aiServicesTabManaged" },
] as const;
type ServiceTab = (typeof SERVICE_TABS)[number]["id"];

export default function AiServicesLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  // Both panels stay mounted — the inactive one hides via the `hidden`
  // attribute — so tab switches never remount a controller or drop an
  // in-flight OAuth flow, draft, error, or open detail drawer.
  const [activeTab, setActiveTab] = useState<ServiceTab>("account");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [accountConnected, setAccountConnected] = useState<HTMLDivElement | null>(null);
  const [accountAvailable, setAccountAvailable] = useState<HTMLDivElement | null>(null);
  const [byokConnected, setByokConnected] = useState<HTMLDivElement | null>(null);
  const [byokAvailable, setByokAvailable] = useState<HTMLDivElement | null>(null);
  const [managedConnected, setManagedConnected] = useState<HTMLDivElement | null>(null);
  const [managedAvailable, setManagedAvailable] = useState<HTMLDivElement | null>(null);
  const [support, setSupport] = useState<HTMLDivElement | null>(null);
  const targets = useMemo(
    () => ({
      "account-connected": accountConnected,
      "account-available": accountAvailable,
      "byok-connected": byokConnected,
      "byok-available": byokAvailable,
      "managed-connected": managedConnected,
      "managed-available": managedAvailable,
      support,
    }),
    [accountConnected, accountAvailable, byokConnected, byokAvailable, managedConnected, managedAvailable, support],
  );

  // ARIA tabs keyboard contract: arrows/Home/End move and activate — the
  // same automatic-activation behaviour as the shared Radix tabs.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = SERVICE_TABS.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
        : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
          : event.key === "Home" ? 0
            : event.key === "End" ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActiveTab(SERVICE_TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <ServiceTargets.Provider value={targets}>
      <div className="@container/services min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings.aiServicesHint")}</p>
        <div role="tablist" aria-label={t("settings.sections.aiServices")} className="inline-flex h-10 max-w-full items-center justify-start overflow-x-auto rounded-md bg-muted p-1 text-muted-foreground">
          {SERVICE_TABS.map((tab, index) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={(element) => { tabRefs.current[index] = element; }}
                type="button"
                role="tab"
                id={`ai-services-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`ai-services-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-2 focus-visible:outline-ring ${selected ? "bg-background text-foreground shadow-xs" : "text-muted-foreground"}`}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id="ai-services-panel-account"
          aria-labelledby="ai-services-tab-account"
          tabIndex={0}
          hidden={activeTab !== "account"}
          data-testid="ai-services-panel-account"
          className="space-y-4"
        >
          <p className="text-sm text-muted-foreground">{t("settings.aiConnectionsDescription")}</p>
          <div className="grid min-w-0 gap-5 @3xl/services:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]">
            <section aria-label={t("settings.aiServicesConnected")} className="min-w-0 space-y-3">
              <h3 className="text-sm font-semibold">{t("settings.aiServicesConnected")}</h3>
              <div ref={setAccountConnected} data-testid="ai-services-account-connected" className="min-w-0 space-y-3">
                <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground [&:not(:only-child)]:hidden">{t("settings.aiServicesEmpty")}</p>
              </div>
            </section>
            <section aria-label={t("settings.aiServicesAvailable")} className="min-w-0 space-y-3">
              <h3 className="text-sm font-semibold">{t("settings.aiServicesAvailable")}</h3>
              <div data-testid="ai-services-account-available" className="min-w-0 space-y-2.5 [&:has(>div:not(:empty))>p]:hidden">
                <div ref={setAccountAvailable} className="space-y-2.5 empty:hidden" />
                <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">{t("settings.aiServicesAllConnected")}</p>
              </div>
            </section>
          </div>
        </div>
        <div
          role="tabpanel"
          id="ai-services-panel-managed"
          aria-labelledby="ai-services-tab-managed"
          tabIndex={0}
          hidden={activeTab !== "managed"}
          data-testid="ai-services-panel-managed"
          className="space-y-6"
        >
          <section aria-label={t("settings.aiServicesByokTitle")} className="min-w-0 space-y-3">
            <div>
              <h3 className="text-sm font-semibold">{t("settings.aiServicesByokTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("settings.aiServicesByokHint")}</p>
            </div>
            <div ref={setByokConnected} data-testid="ai-services-byok-connected" className="min-w-0 space-y-3 empty:hidden" />
            <div ref={setByokAvailable} data-testid="ai-services-byok-available" className="min-w-0 space-y-2.5 empty:hidden" />
            <div ref={setSupport} data-testid="ai-services-support" className="empty:hidden" />
          </section>
          <section aria-label={t("settings.aiServicesManagedGroupTitle")} className="min-w-0 space-y-3">
            <div>
              <h3 className="text-sm font-semibold">{t("settings.aiServicesManagedGroupTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("settings.managedDescription")}</p>
            </div>
            <div ref={setManagedConnected} data-testid="ai-services-managed-connected" className="min-w-0 space-y-3 empty:hidden" />
            <div ref={setManagedAvailable} data-testid="ai-services-managed-available" className="min-w-0 space-y-2.5 empty:hidden" />
          </section>
        </div>
        {children}
      </div>
    </ServiceTargets.Provider>
  );
}
