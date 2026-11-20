"use client";

import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  EXTENSIONS_TAB_IDS,
  resolveExtensionsTab,
  type ExtensionsTabId,
} from "./extensionsTab";

// The server page resolves ?tab= for deep links; switching tabs mirrors the
// choice back into the URL without a navigation round trip.
export default function ExtensionsTabs({
  initialTab,
  labels,
  panels,
}: {
  initialTab: ExtensionsTabId;
  labels: Record<ExtensionsTabId, string>;
  panels: Record<ExtensionsTabId, ReactNode>;
}) {
  const [tab, setTab] = useState<ExtensionsTabId>(initialTab);
  const onChange = (next: string) => {
    const id = resolveExtensionsTab(next);
    setTab(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // URL sync is best-effort.
    }
  };
  return (
    <Tabs value={tab} onValueChange={onChange} className="grid gap-4">
      <TabsList className="h-auto w-fit max-w-full flex-wrap justify-start">
        {EXTENSIONS_TAB_IDS.map((id) => (
          <TabsTrigger key={id} value={id} data-testid={`extensions-tab-${id}`}>
            {labels[id]}
          </TabsTrigger>
        ))}
      </TabsList>
      {EXTENSIONS_TAB_IDS.map((id) => (
        <TabsContent key={id} value={id} className="mt-0">
          {panels[id]}
        </TabsContent>
      ))}
    </Tabs>
  );
}
