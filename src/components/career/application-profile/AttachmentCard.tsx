"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  archiveCandidateAttachment,
  listCandidateAttachments,
  uploadCandidateAttachment,
} from "@/actions/applicationProfile.actions";

type AttachmentRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

// Sensitive attachment block: metadata-only list, explicit download link to
// the authenticated route, upload + archive (D14/D16, §8).
export function AttachmentCard({
  category,
  materialItemId,
  titleKey,
}: {
  category: "ID_PHOTO" | "AWARD_PROOF";
  materialItemId?: string;
  titleKey: string;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listCandidateAttachments({ category, materialItemId });
      if (res?.success) setRows((res.data as AttachmentRow[] | null) ?? []);
      else toastError(t("applicationProfile.loadFailed"));
    } catch {
      toastError(t("applicationProfile.loadFailed"));
    }
  }, [category, materialItemId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("category", category);
      fd.set("file", file);
      if (materialItemId) fd.set("materialItemId", materialItemId);
      const res = await uploadCandidateAttachment(fd).catch(() => null);
      if (res?.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        await load();
      } else {
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleArchive(id: string) {
    if (!window.confirm(t("applicationProfile.archiveConfirm"))) return;
    const res = await archiveCandidateAttachment(id);
    if (res.success) {
      toastSuccess(t("applicationProfile.saveSuccess"));
      await load();
    } else {
      toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
    }
  }

  const accept = category === "ID_PHOTO" ? "image/jpeg,image/png" : "image/jpeg,image/png,application/pdf";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">{t(titleKey)}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("applicationProfile.sensitiveMaskedHint")}
          </p>
        </div>
        <div>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            data-testid={`attachment-upload-${category}`}
            onChange={handleUpload}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? t("common.saving") : t("applicationProfile.attachmentUpload")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="rounded-md border p-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">
            {t("applicationProfile.sensitiveLocalTitle")}
          </div>
          <div>{t("applicationProfile.sensitiveLocalDetail")}</div>
          <div>{t("applicationProfile.sensitiveNoAi")}</div>
        </div>
        {rows.length === 0 && (
          <div className="text-sm text-muted-foreground">
            {t("applicationProfile.emptySection")}
          </div>
        )}
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between gap-2 text-sm"
            data-testid={`attachment-row-${row.id}`}
          >
            <span>
              {row.fileName}
              <span className="ml-2 text-xs text-muted-foreground">
                ({Math.ceil(row.sizeBytes / 1024)} KB)
              </span>
            </span>
            <span className="flex gap-1">
              <Button variant="ghost" size="sm" asChild>
                <a
                  href={`/api/profile/career-attachments/${row.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("applicationProfile.attachmentDownload")}
                </a>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => handleArchive(row.id)}>
                {t("applicationProfile.archiveMaterial")}
              </Button>
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// Compact variant used inside a material record card (award proof files per
// AWARD item); same actions and download route, no card chrome.
export function AttachmentInlineList({
  category,
  materialItemId,
}: {
  category: "ID_PHOTO" | "AWARD_PROOF";
  materialItemId?: string;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listCandidateAttachments({ category, materialItemId });
      if (res?.success) setRows((res.data as AttachmentRow[] | null) ?? []);
    } catch {
      // Metadata-only list; a failed load leaves the section empty.
    }
  }, [category, materialItemId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("category", category);
      fd.set("file", file);
      if (materialItemId) fd.set("materialItemId", materialItemId);
      const res = await uploadCandidateAttachment(fd).catch(() => null);
      if (res?.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        await load();
      } else {
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleArchive(id: string) {
    if (!window.confirm(t("applicationProfile.archiveConfirm"))) return;
    const res = await archiveCandidateAttachment(id);
    if (res.success) {
      toastSuccess(t("applicationProfile.saveSuccess"));
      await load();
    } else {
      toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
    }
  }

  return (
    <div className="flex flex-col gap-1" data-testid={`attachments-${materialItemId ?? category}`}>
      <div className="text-xs font-medium text-muted-foreground">
        {t("applicationProfile.attachmentsTitle")}
      </div>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="text-xs">
            {row.fileName}
            <span className="ml-1 text-muted-foreground">
              ({Math.ceil(row.sizeBytes / 1024)} KB)
            </span>
          </span>
          <span className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2" asChild>
              <a href={`/api/profile/career-attachments/${row.id}`} target="_blank" rel="noreferrer">
                {t("applicationProfile.attachmentDownload")}
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => handleArchive(row.id)}
            >
              {t("applicationProfile.archiveMaterial")}
            </Button>
          </span>
        </div>
      ))}
      <div>
        <input
          ref={fileRef}
          type="file"
          accept={category === "ID_PHOTO" ? "image/jpeg,image/png" : "image/jpeg,image/png,application/pdf"}
          className="hidden"
          onChange={handleUpload}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? t("common.saving") : t("applicationProfile.attachmentUpload")}
        </Button>
      </div>
    </div>
  );
}
