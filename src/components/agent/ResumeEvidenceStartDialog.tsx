"use client";

import { useEffect, useState } from "react";
import { listApplicationMaterials } from "@/actions/applicationProfile.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import {
  buildResumeEvidenceStart,
  isResumeEvidenceMaterialType,
  type ResumeEvidenceMaterialSource,
} from "@/lib/agent/skills/resumeEvidence";

const NONE = "__none__";

type MaterialRow = ResumeEvidenceMaterialSource & { title: string };

// User-initiated entry for the Resume Evidence skill (contract §3). Reads the
// career materials list (read-only action), lets the user pick exactly ONE,
// and sends the single-experience authorization pack as the first message.
// It never calls a write action and never opens more than the picked item.
export function ResumeEvidenceStartDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { sendMessage } = useAgentChat();
  const [materials, setMaterials] = useState<MaterialRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pickedId, setPickedId] = useState(NONE);
  const [experienceText, setExperienceText] = useState("");
  const [jdText, setJdText] = useState("");

  useEffect(() => {
    if (!open || materials !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await listApplicationMaterials();
        if (cancelled) return;
        if (!result?.success || !Array.isArray(result.data)) {
          setLoadFailed(true);
          setMaterials([]);
          return;
        }
        setMaterials(
          (result.data as MaterialRow[]).filter((m) =>
            isResumeEvidenceMaterialType(m.type),
          ),
        );
      } catch {
        if (cancelled) return;
        setLoadFailed(true);
        setMaterials([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, materials]);

  const start = () => {
    const material =
      pickedId === NONE
        ? null
        : (materials?.find((m) => m.id === pickedId) ?? null);
    const result = buildResumeEvidenceStart({
      material,
      experienceText,
      targetJdText: jdText,
    });
    if (!result.ok) return;
    void sendMessage({ parts: [{ type: "text", text: result.message }] });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="resume-evidence-start-dialog">
        <DialogHeader>
          <DialogTitle>{t("agent.resumeEvidence.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("agent.resumeEvidence.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("agent.resumeEvidence.materialLabel")}
            </label>
            {materials === null ? (
              <p className="text-xs text-muted-foreground">
                {t("agent.resumeEvidence.materialLoading")}
              </p>
            ) : (
              <Select value={pickedId} onValueChange={setPickedId}>
                <SelectTrigger
                  aria-label={t("agent.resumeEvidence.materialLabel")}
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>
                    {t("agent.resumeEvidence.materialNone")}
                  </SelectItem>
                  {materials.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {loadFailed && (
              <p className="text-xs text-muted-foreground">
                {t("agent.resumeEvidence.materialError")}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("agent.resumeEvidence.experienceLabel")}
            </label>
            <Textarea
              value={experienceText}
              onChange={(e) => setExperienceText(e.target.value)}
              rows={3}
              aria-label={t("agent.resumeEvidence.experienceLabel")}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t("agent.resumeEvidence.jdLabel")}
            </label>
            <Textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={3}
              aria-label={t("agent.resumeEvidence.jdLabel")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t("agent.resumeEvidence.cancel")}
          </Button>
          <Button type="button" onClick={start}>
            {t("agent.resumeEvidence.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
