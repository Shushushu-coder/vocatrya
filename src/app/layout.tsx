import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { DesktopTitleBar } from "@/components/desktop/DesktopTitleBar";
import { DesktopZoom } from "@/components/desktop/DesktopZoom";

export const dynamic = "force-dynamic";

const inter = localFont({
  src: "./fonts/Inter-Variable.woff2",
  variable: "--font-inter",
  weight: "100 900",
});

import { cookies } from "next/headers";
import { I18nProvider, LOCALE_COOKIE_NAME, normalizeLocale } from "@/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const rawLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);

  const description =
    locale === "zh-CN"
      ? "AI 求职与职业发展工作台"
      : "Job Application Tracking System";

  return {
    title: {
      template: "%s | Vocatrya",
      default: "Vocatrya",
    },
    description,
  };
}

interface Props {
  children: React.ReactNode;
}

export default async function RootLayout({ children }: Readonly<Props>) {
  const cookieStore = await cookies();
  const rawLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value;
  const locale = normalizeLocale(rawLocale);

  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={cn(
          "min-h-screen bg-background font-sans antialiased",
          inter.variable
        )}
      >
        <I18nProvider initialLocale={locale}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {/* Desktop-only window chrome; CSS hides it outside Electron, so
                the web build and the hidden print window render unchanged. */}
            <DesktopTitleBar />
            <DesktopZoom />
            {children}
            <Toaster />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
