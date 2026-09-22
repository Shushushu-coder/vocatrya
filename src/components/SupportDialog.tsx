"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { AppVersionInfo } from "@/models/version.model";
import packageJson from "../../package.json";
import { useI18n } from "@/i18n";

interface SupportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version?: AppVersionInfo | null;
}

export function SupportDialog({
  open,
  onOpenChange,
  version,
}: SupportDialogProps) {
  const { t } = useI18n();
  // Prefer the runtime-reported version (installed desktop app injects its
  // real Electron app version); fall back to the bundled package.json while
  // the /api/version fetch is pending or on non-desktop deployments.
  const appVersion = version?.current ?? packageJson.version;
  const currentYear = new Date().getFullYear();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("nav.support")}</DialogTitle>
          <DialogDescription>
            <a
              href="https://github.com/Shushushu-coder/vocatrya/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              https://github.com/Shushushu-coder/vocatrya/issues
            </a>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">{t("common.version")}</h3>
            <p className="text-sm text-muted-foreground">v{appVersion}</p>
            {version?.updateAvailable && (
              <p className="text-sm">
                <a
                  href={version.releaseUrl ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {t("common.updateAvailableVersion", {
                    version: version.latest ?? "",
                  })}
                </a>
              </p>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">{t("common.aboutCopyright")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("common.derivedFrom", { year: currentYear })}
            </p>
            <div className="flex flex-col gap-1 text-sm">
              <a
                href="https://github.com/Shushushu-coder/vocatrya"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                https://github.com/Shushushu-coder/vocatrya
              </a>
              <span className="text-xs text-muted-foreground">
                {t("common.upstreamBase")}{" "}
                <a
                  href="https://github.com/Gsync/jobsync"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  https://github.com/Gsync/jobsync
                </a>
              </span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
