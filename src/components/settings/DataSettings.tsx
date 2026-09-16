"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, History, Loader2, Upload } from "lucide-react";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { toastError, toastSuccess } from "@/lib/toast";
import { useI18n } from "@/i18n";

interface PreflightResult {
  manifest: {
    formatVersion: number;
    appName?: string;
    appVersion: string;
    exportedAt: string;
    sourceEmail: string;
    counts: Record<string, number>;
  };
  emailMatches: boolean;
  targetIsEmpty: boolean;
  targetCounts: Record<string, number>;
}

interface SnapshotInfo {
  id: string;
  exportedAt: string;
  appVersion: string;
  counts: Record<string, number>;
  sizeBytes: number;
}

function CountGrid({ counts }: { counts: Record<string, number> }) {
  const { t } = useI18n();
  const rows = Object.entries(counts).filter(([, n]) => n > 0);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("settings.nothing")}</p>;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
      {rows.map(([model, n]) => (
        <div key={model} className="flex justify-between gap-2">
          <span className="text-muted-foreground">{model}</span>
          <span className="font-medium tabular-nums">{n}</span>
        </div>
      ))}
    </div>
  );
}

export default function DataSettings() {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [restoring, setRestoring] = useState<SnapshotInfo | null>(null);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await fetch("/api/backup/snapshots");
      if (res.ok) setSnapshots((await res.json()) as SnapshotInfo[]);
    } catch {
      // A failed list is not worth a toast — the card just stays empty.
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const runRollback = async () => {
    if (!restoring) return;
    const snapshotId = restoring.id;
    setRestoring(null);
    setBusy(true);
    try {
      const res = await fetch("/api/backup/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId }),
      });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, t("settings.rollbackFailed"));
        return;
      }
      toastSuccess(
        t("settings.rollbackCompleteMessage"),
        t("settings.rollbackComplete"),
      );
      await loadSnapshots();
    } catch {
      toastError(t("settings.couldNotReachServer"), t("settings.rollbackFailed"));
    } finally {
      setBusy(false);
    }
  };

  const destroyed = preflight
    ? Object.entries(preflight.targetCounts).filter(([, n]) => n > 0)
    : [];

  const onSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setPreflight(null);
    setSelected(file);
    if (!file) return;

    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/backup/import/preflight", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, t("settings.couldNotReadBackup"));
        return;
      }
      setPreflight(json as PreflightResult);
    } catch {
      toastError(t("settings.couldNotReachServer"), t("settings.couldNotReadBackup"));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!selected) return;
    setConfirming(false);
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", selected);
      body.append("confirmWipe", "true");
      const res = await fetch("/api/backup/import", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) {
        toastError(json.error, t("settings.importFailed"));
        return;
      }
      const total = Object.values(json.counts as Record<string, number>).reduce(
        (sum, n) => sum + n,
        0,
      );
      // Naming the snapshot is the whole point of taking one — a safety net
      // the user does not know exists is not a safety net.
      toastSuccess(
        `${t("settings.importCompleteMessage", {
          rows: total,
          files: json.filesWritten,
        })}${json.snapshotPath ? t("settings.importSnapshotNote") : ""}${t(
          "settings.importReloadNote",
        )}`,
        t("settings.importComplete"),
      );
      setPreflight(null);
      setSelected(null);
      if (fileInput.current) fileInput.current.value = "";
      await loadSnapshots();
    } catch {
      toastError(t("settings.couldNotReachServer"), t("settings.importFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-medium">{t("settings.exportYourData")}</CardTitle>
          <CardDescription>
            {t("settings.exportYourDataDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("settings.exportNoCredentialsLead")}
            <strong>{t("settings.noApiKeys")}</strong>
            {t("settings.exportNoCredentialsMid")}
            <strong> {t("settings.fullText")}</strong>
            {t("settings.exportNoCredentialsTail")}
          </p>
          <Button asChild>
            <a href="/api/backup/export" download>
              <Download className="mr-2 h-4 w-4" />
              {t("settings.downloadBackup")}
            </a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg font-medium">{t("settings.importABackup")}</CardTitle>
          <CardDescription>
            {t("settings.importABackupDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="backup-file">{t("settings.backupFile")}</Label>
            <Input
              id="backup-file"
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              onChange={onSelect}
              disabled={busy}
            />
          </div>

          {busy && !preflight && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("settings.readingBackup")}
            </p>
          )}

          {preflight && (
            <div className="space-y-3 rounded-md border p-4">
              <div className="text-sm">
                <p>
                  {t("settings.exportedFrom", {
                    date: format(new Date(preflight.manifest.exportedAt), "PPp"),
                    app: preflight.manifest.appName || "JobSync",
                    version: preflight.manifest.appVersion,
                  })}
                </p>
                <p className="text-muted-foreground">
                  {t("settings.sourceAccount", {
                    email: preflight.manifest.sourceEmail,
                  })}
                </p>
              </div>

              {!preflight.emailMatches && (
                <p className="rounded-sm bg-destructive/10 p-2 text-sm font-medium text-destructive">
                  {t("settings.differentAccountWarning", {
                    email: preflight.manifest.sourceEmail,
                  })}
                </p>
              )}

              <div>
                <p className="mb-1 text-sm font-medium">{t("settings.backupContains")}</p>
                <CountGrid counts={preflight.manifest.counts} />
              </div>

              <Button
                variant="destructive"
                onClick={() => setConfirming(true)}
                disabled={busy}
              >
                <Upload className="mr-2 h-4 w-4" />
                {t("settings.replaceMyData")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {snapshots.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-medium">{t("settings.undoImport")}</CardTitle>
            <CardDescription>
              {t("settings.undoImportDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {snapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {format(new Date(snapshot.exportedAt), "PPp")}
                  </p>
                  <p className="text-muted-foreground">
                    {t("settings.snapshotSummary", {
                      jobs: snapshot.counts.Job ?? 0,
                      resumes: snapshot.counts.Resume ?? 0,
                      size: (snapshot.sizeBytes / 1024 / 1024).toFixed(1),
                    })}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setRestoring(snapshot)}
                >
                  <History className="mr-2 h-4 w-4" />
                  {t("settings.restore")}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.rollbackSnapshot")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.rollbackDescription", {
                date: restoring
                  ? format(new Date(restoring.exportedAt), "PPp")
                  : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={runRollback}>
              {t("settings.rollBack")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.deleteAccountData")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t("settings.deleteAccountDataDescription")}
                </p>
                <ul className="list-inside list-disc text-sm">
                  {destroyed.map(([model, n]) => (
                    <li key={model}>
                      {n} {model.toLowerCase()}
                      {n === 1 ? "" : "s"}
                    </li>
                  ))}
                  {destroyed.length === 0 && (
                    <li>{t("settings.nothingAccountEmpty")}</li>
                  )}
                </ul>
                {preflight && !preflight.emailMatches && (
                  <p className="font-medium text-destructive">
                    {t("settings.backupDifferentAccount")}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={runImport}
            >
              {t("settings.deleteEverythingAndImport")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
