"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import { findReusableResumeExport, freezeResumeVersion } from "@/actions/resumeVariant.actions";
import { useI18n } from "@/i18n";

type Artifact = { id: string; fileName: string };
type Stage = "exportFreezing" | "exportLookingUp" | "exportRendering" | "exportSaving" | "exportDownloading";

export function ResumeExportControl({ versionId, status, archived, onFrozen }: {
  versionId: string;
  status: string;
  archived: boolean;
  onFrozen: (versionId: string) => void;
}) {
  const { t } = useI18n();
  const [desktop, setDesktop] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => { setDesktop(typeof window.vocatryaResume?.printToPDF === "function"); }, []);

  const exportPDF = async () => {
    const bridge = window.vocatryaResume;
    if (busy.current || !bridge) return;
    busy.current = true;
    setConfirm(false);
    setError(null);
    let failure = "exportLookupFailed";
    try {
      if (status === "DRAFT" && !archived) {
        failure = "exportFreezeFailed";
        setStage("exportFreezing");
        const frozen = await freezeResumeVersion(versionId);
        if (!frozen.success) throw new Error(frozen.message);
        // Keep the workspace read-only even if rendering or persistence later fails.
        onFrozen(versionId);
      }
      failure = "exportLookupFailed";
      setStage("exportLookingUp");
      const reusable = await findReusableResumeExport(versionId);
      if (!reusable.success) throw new Error(reusable.message);
      let artifact = reusable.data as Artifact | null;
      if (!artifact) {
        if (archived) { failure = "exportArchivedUnavailable"; throw new Error(); }
        failure = "exportRenderFailed";
        setStage("exportRendering");
        const rendered = await bridge.printToPDF(versionId);
        if (!rendered.ok) {
          failure = rendered.code === "timeout" ? "exportRenderTimeout" : "exportRenderFailed";
          throw new Error();
        }
        failure = "exportSaveFailed";
        setStage("exportSaving");
        const response = await fetch(`/api/profile/resume-artifacts?versionId=${encodeURIComponent(versionId)}`, {
          method: "POST", headers: { "Content-Type": "application/pdf" },
          body: new Blob([new Uint8Array(rendered.bytes)], { type: "application/pdf" }),
        });
        if (!response.ok) throw new Error();
        artifact = await response.json() as Artifact;
      }
      failure = "exportDownloadFailed";
      setStage("exportDownloading");
      const response = await fetch(`/api/profile/resume-artifacts/${encodeURIComponent(artifact.id)}`, { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        if (result?.code === "ARTIFACT_BYTES_MISSING") failure = "exportBytesMissing";
        throw new Error();
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError(t(`resumeVariants.${failure}`));
    } finally {
      busy.current = false;
      setStage(null);
    }
  };

  const supportedStatus = status === "DRAFT" || status === "FROZEN" || status === "SUBMITTED";
  return (
    <div className="space-y-1">
      <Button variant="outline" disabled={!desktop || stage !== null || (!archived && !supportedStatus)} onClick={() => {
        if (status === "DRAFT" && !archived) setConfirm(true);
        else void exportPDF();
      }}>
        {stage ? t(`resumeVariants.${stage}`) : t(archived ? "resumeVariants.downloadExport" : "resumeVariants.exportPDF")}
      </Button>
      {!desktop && <p className="text-xs text-muted-foreground">{t("resumeVariants.exportDesktopOnly")}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <DeleteAlertDialog pageTitle="" open={confirm} onOpenChange={setConfirm}
        onDelete={() => void exportPDF()}
        alertTitle={t("resumeVariants.exportConfirmTitle")}
        alertDescription={t("resumeVariants.exportConfirmDescription")}
        actionLabel={t("resumeVariants.exportConfirmAction")} actionVariant="default" />
    </div>
  );
}
