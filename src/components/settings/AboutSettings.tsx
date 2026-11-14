"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/i18n";
import { APP_CONSTANTS } from "@/lib/constants";
import { toastError } from "@/lib/toast";
import { isDesktopShell } from "../desktop/desktopShell";
import { Button } from "../ui/button";

type RuntimeListEntry = Awaited<
  ReturnType<VocatryaRuntimeBridge["list"]>
>[number];

// Build-time fallback: next.config.mjs's env block reads package.json when
// the config loads, so this value always agrees with the bundled manifest.
// The authoritative running version arrives post-mount through the document
// meta emitted by the settings layout — in a packaged install it carries the
// installer's Electron version, which a stale bundled build cannot know.
function bundledVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "unknown";
}

// next dev ships a development bundle; the installed app and any other
// `next build` output ship a production bundle. That is the only packaged
// signal the renderer can read without a new IPC channel.
function isInstalledBuild(): boolean {
  return process.env.NODE_ENV === "production";
}

// Whitelist, not serialization: a runtime list entry also carries
// capability descriptors, profile strategy and mechanism strings. None of
// that may reach the clipboard — diagnostics contain version and
// environment facts only.
function runtimeSummary(entry: RuntimeListEntry): string {
  return `${entry.displayName} (backend=${entry.backendKind}, vendor=${entry.runtimeVendor})`;
}

function FactRow({
  name,
  value,
  testId,
}: {
  name: string;
  value: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
      <dt className="text-sm font-medium leading-none">{name}</dt>
      <dd
        className="text-sm text-muted-foreground break-words"
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

function AboutSettings() {
  const { t, locale } = useI18n();
  // The shell marker is read after mount so the SSR pass and the first
  // client paint agree before the Electron-only fact appears.
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  // Initialized from the bundled env so SSR and the first client paint agree;
  // the post-mount read below upgrades it to the resolved running version.
  const [version, setVersion] = useState(bundledVersion);
  // Packaged-install build facts, delivered the same way as the version meta.
  // Absent on web/dev — the rows simply do not render there.
  const [buildCommit, setBuildCommit] = useState<string | null>(null);
  const [builtAt, setBuiltAt] = useState<string | null>(null);
  useEffect(() => {
    setDesktop(isDesktopShell());
    const resolved = document
      .querySelector(`meta[name="${APP_CONSTANTS.APP_VERSION_META_NAME}"]`)
      ?.getAttribute("content")
      ?.trim();
    if (resolved) setVersion(resolved);
    const meta = (name: string) =>
      document
        .querySelector(`meta[name="${name}"]`)
        ?.getAttribute("content")
        ?.trim() || null;
    setBuildCommit(meta(APP_CONSTANTS.APP_BUILD_COMMIT_META_NAME));
    setBuiltAt(meta(APP_CONSTANTS.APP_BUILT_AT_META_NAME));
  }, []);

  const installed = isInstalledBuild();
  const builtAtDate = builtAt ? new Date(builtAt) : null;
  const builtAtLabel =
    builtAtDate && !Number.isNaN(builtAtDate.getTime())
      ? new Intl.DateTimeFormat(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(builtAtDate)
      : builtAt;

  const copyDiagnostics = async () => {
    const lines = [
      "vocatrya diagnostics",
      `version: ${version}`,
      `build: ${installed ? "installed" : "development"}`,
    ];
    if (buildCommit) lines.push(`commit: ${buildCommit}`);
    if (builtAt) lines.push(`builtAt: ${builtAt}`);
    lines.push(
      `environment: ${isDesktopShell() ? "electron" : "browser"}`,
      `locale: ${locale}`,
      `timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"}`,
    );
    if (window.vocatryaRuntime) {
      try {
        const list = await window.vocatryaRuntime.list();
        lines.push(
          `runtimes: ${list.length === 0 ? "none" : list.map(runtimeSummary).join("; ")}`,
        );
      } catch {
        // A failed probe skips the runtimes line instead of blocking copy.
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toastError(t("settings.about.copyDiagnosticsFailed"));
    }
  };

  return (
    <div className="space-y-4" data-testid="about-settings">
      <div>
        <h3 className="text-lg font-medium">{t("settings.about.title")}</h3>
        <p className="text-sm text-muted-foreground break-words">
          {t("settings.about.description")}
        </p>
      </div>

      <dl className="divide-y">
        <FactRow
          name={t("settings.about.versionLabel")}
          value={version}
          testId="about-version"
        />
        <FactRow
          name={t("settings.about.buildLabel")}
          value={
            installed
              ? t("settings.about.buildInstalled")
              : t("settings.about.buildDevelopment")
          }
          testId="about-build"
        />
        <FactRow
          name={t("settings.about.environmentLabel")}
          value={
            desktop === null
              ? "—"
              : desktop
                ? t("settings.about.environmentDesktop")
                : t("settings.about.environmentBrowser")
          }
          testId="about-environment"
        />
        {buildCommit ? (
          <FactRow
            name={t("settings.about.commitLabel")}
            value={buildCommit.slice(0, 12)}
            testId="about-commit"
          />
        ) : null}
        {builtAt ? (
          <FactRow
            name={t("settings.about.builtAtLabel")}
            value={builtAtLabel}
            testId="about-built-at"
          />
        ) : null}
        <FactRow
          name={t("settings.about.licenseLabel")}
          value="MIT"
          testId="about-license"
        />
      </dl>

      <div className="space-y-2">
        <p className="text-sm font-medium leading-none">
          {t("settings.about.diagnosticsTitle")}
        </p>
        <p className="text-sm text-muted-foreground break-words">
          {t("settings.about.diagnosticsDescription")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={copyDiagnostics}
          data-testid="about-copy-diagnostics"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          {copied
            ? t("settings.about.diagnosticsCopied")
            : t("settings.about.copyDiagnostics")}
        </Button>
      </div>
    </div>
  );
}

export default AboutSettings;
