"use client";

import * as React from "react";
import {
  ThemeProvider as NextThemesProvider,
  ThemeProviderProps,
  useTheme,
} from "next-themes";

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return <NextThemesProvider {...props}><NativeWindowThemeSync />{children}</NextThemesProvider>;
}

// next-themes remains the only theme authority, including explicit overrides.
function NativeWindowThemeSync() {
  const { resolvedTheme, theme, forcedTheme } = useTheme();
  React.useEffect(() => {
    const actualTheme = forcedTheme ?? resolvedTheme;
    if (actualTheme !== "light" && actualTheme !== "dark") return;
    const preference = forcedTheme ?? theme;
    void window.vocatryaWindow?.setTheme(actualTheme, preference === "system" ? "system" : actualTheme).catch(error => {
      console.error("Native window theme synchronization failed", error);
    });
  }, [resolvedTheme, theme, forcedTheme]);
  return null;
}
