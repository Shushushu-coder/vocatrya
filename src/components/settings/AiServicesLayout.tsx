"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";

type Placement = "connected" | "available" | "support";
const ServiceTargets = createContext<Record<Placement, HTMLDivElement | null> | null>(null);

export function useAiServicesLayout() {
  return useContext(ServiceTargets) !== null;
}

// Keep each credential controller mounted once while placing its cards by state.
// Moving between columns never destroys the controller's OAuth or form state.
export function AiServiceSlot({ placement, children }: { placement: Placement; children: ReactNode }) {
  const targets = useContext(ServiceTargets);
  if (!targets) return children;
  const target = targets[placement];
  return target ? createPortal(children, target) : null;
}

export default function AiServicesLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [connected, setConnected] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<HTMLDivElement | null>(null);
  const [support, setSupport] = useState<HTMLDivElement | null>(null);
  const targets = useMemo(() => ({ connected, available, support }), [connected, available, support]);
  return (
    <ServiceTargets.Provider value={targets}>
      <div className="@container/services min-w-0 space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings.aiServicesHint")}</p>
        <div className="grid min-w-0 gap-5 @3xl/services:grid-cols-[minmax(0,1fr)_minmax(14rem,18rem)]">
          <section aria-label={t("settings.aiServicesConnected")} className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">{t("settings.aiServicesConnected")}</h3>
            <div ref={setConnected} data-testid="ai-services-connected" className="min-w-0 space-y-3">
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground [&:not(:only-child)]:hidden">{t("settings.aiServicesEmpty")}</p>
            </div>
          </section>
          <section aria-label={t("settings.aiServicesAvailable")} className="min-w-0 space-y-3">
            <h3 className="text-sm font-semibold">{t("settings.aiServicesAvailable")}</h3>
            <div ref={setAvailable} data-testid="ai-services-available" className="min-w-0 space-y-3">
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground [&:not(:only-child)]:hidden">{t("settings.aiServicesAllConnected")}</p>
            </div>
          </section>
        </div>
        <div ref={setSupport} className="space-y-3" />
        {children}
      </div>
    </ServiceTargets.Provider>
  );
}
