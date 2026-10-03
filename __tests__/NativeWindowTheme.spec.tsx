import { render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "@/components/theme-provider";
let resolvedTheme = "light";
let theme = "light";
let forcedTheme: string | undefined;
vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ resolvedTheme, theme, forcedTheme }),
}));

it("forwards the actual resolved app theme, including explicit overrides", async () => {
  const setTheme = vi.fn().mockResolvedValue(undefined);
  window.vocatryaWindow = { setTheme };
  const { rerender, unmount } = render(<ThemeProvider>App</ThemeProvider>);
  await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("light", "light"));
  forcedTheme = "dark";
  rerender(<ThemeProvider>App</ThemeProvider>);
  await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("dark", "dark"));
  forcedTheme = undefined;
  theme = "system";
  rerender(<ThemeProvider>App</ThemeProvider>);
  await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("light", "system"));
  resolvedTheme = "dark";
  theme = "dark";
  rerender(<ThemeProvider>App</ThemeProvider>);
  await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("dark", "dark"));
  resolvedTheme = "light";
  theme = "light";
  rerender(<ThemeProvider>App</ThemeProvider>);
  await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith("light", "light"));
  unmount(); delete window.vocatryaWindow;
});
