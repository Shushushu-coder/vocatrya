"use client";

import { createContext, useContext, useMemo } from "react";

/**
 * Resolved once in the dashboard layout and shared with every client surface
 * that has to hide deferred entries under trusted fresh + full A+B. Defaults
 * preserve legacy behavior outside the provider: ordinary surfaces and enabled
 * job mutations. The dashboard supplies its resolved runtime policy explicitly.
 */
export type CareerSurfacesValue = {
  freshNativeFull: boolean;
  jobMutationsEnabled: boolean;
  resumeV1Enabled: boolean;
};

const DEFAULT_VALUE: CareerSurfacesValue = { freshNativeFull: false, jobMutationsEnabled: true, resumeV1Enabled: true };

const CareerSurfacesContext = createContext<CareerSurfacesValue>(DEFAULT_VALUE);

export function CareerSurfacesProvider({
  freshNativeFull,
  jobMutationsEnabled = true,
  resumeV1Enabled = true,
  children,
}: {
  freshNativeFull: boolean;
  jobMutationsEnabled?: boolean;
  resumeV1Enabled?: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ freshNativeFull, jobMutationsEnabled, resumeV1Enabled }), [freshNativeFull, jobMutationsEnabled, resumeV1Enabled]);
  return (
    <CareerSurfacesContext.Provider value={value}>
      {children}
    </CareerSurfacesContext.Provider>
  );
}

export function useCareerSurfaces(): CareerSurfacesValue {
  return useContext(CareerSurfacesContext);
}
