"use client";

import { createContext, useContext, useMemo } from "react";

/**
 * Resolved once in the dashboard layout and shared with every client surface
 * that has to hide deferred entries under trusted fresh + full A+B. Defaults
 * to false so components rendered outside the provider keep legacy behavior.
 */
export type CareerSurfacesValue = {
  freshNativeFull: boolean;
};

const DEFAULT_VALUE: CareerSurfacesValue = { freshNativeFull: false };

const CareerSurfacesContext = createContext<CareerSurfacesValue>(DEFAULT_VALUE);

export function CareerSurfacesProvider({
  freshNativeFull,
  children,
}: {
  freshNativeFull: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ freshNativeFull }), [freshNativeFull]);
  return (
    <CareerSurfacesContext.Provider value={value}>
      {children}
    </CareerSurfacesContext.Provider>
  );
}

export function useCareerSurfaces(): CareerSurfacesValue {
  return useContext(CareerSurfacesContext);
}
