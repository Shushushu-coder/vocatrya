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
  const appVersion = packageJson.version;
  const currentYear = new Date().getFullYear();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Support</DialogTitle>
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
            <h3 className="text-sm font-semibold">Version</h3>
            <p className="text-sm text-muted-foreground">v{appVersion}</p>
            {version?.updateAvailable && (
              <p className="text-sm">
                <a
                  href={version.releaseUrl ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {version.latest} is available
                </a>
              </p>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">About & Copyright</h3>
            <p className="text-sm text-muted-foreground">
              © {currentYear} Vocatrya. Derived from JobSync (© 2024–{currentYear} gsync).
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
                Upstream base:{" "}
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
