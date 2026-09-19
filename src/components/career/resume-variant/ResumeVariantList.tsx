"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import {
  archiveResumeVariant,
  createResumeVariant,
  listResumeVariants,
  renameResumeVariant,
} from "@/actions/resumeVariant.actions";
import { toastError, toastSuccess } from "@/lib/toast";
import { useI18n } from "@/i18n";

type VariantRow = {
  id: string;
  name: string;
  targetJobOpportunityId: string | null;
  targetJobTitle: string | null;
  updatedAt: string | Date;
  currentVersion: {
    id: string;
    versionNumber: number;
    status: string;
    frozenAt: string | Date | null;
  } | null;
};

function statusKey(status: string): string {
  if (status === "FROZEN") return "resumeVariants.statusFrozen";
  if (status === "SUBMITTED") return "resumeVariants.statusSubmitted";
  if (status === "ARCHIVED") return "resumeVariants.statusArchived";
  return "resumeVariants.statusDraft";
}

export function ResumeVariantList() {
  const { t, formatDateTime } = useI18n();
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const result = await listResumeVariants();
    if (!result.success) {
      toastError(result.message || t("resumeVariants.loadFailed"));
      return;
    }
    setRows((result.data as VariantRow[]) ?? []);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toastError(t("resumeVariants.nameRequired"));
      return;
    }
    setCreating(true);
    const result = await createResumeVariant({ name: trimmed });
    setCreating(false);
    if (!result.success) {
      toastError(result.message);
      return;
    }
    setName("");
    toastSuccess(t("resumeVariants.createSuccess"));
    await load();
  };

  const onRename = async (variantId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toastError(t("resumeVariants.nameRequired"));
      return;
    }
    const result = await renameResumeVariant({ variantId, name: trimmed });
    if (!result.success) {
      toastError(result.message);
      return;
    }
    toastSuccess(t("resumeVariants.renameSuccess"));
    setRenamingId(null);
    await load();
  };

  const onArchive = async () => {
    if (!archiveId) return;
    const result = await archiveResumeVariant(archiveId);
    if (!result.success) {
      toastError(result.message);
      return;
    }
    toastSuccess(t("resumeVariants.archiveSuccess"));
    setArchiveId(null);
    await load();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("resumeVariants.createTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input
            ref={nameInputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("resumeVariants.name")}
            className="max-w-sm"
            data-testid="resume-variant-name-input"
          />
          <Button onClick={() => void onCreate()} disabled={creating}>
            {t("resumeVariants.create")}
          </Button>
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <Card data-testid="resume-variant-empty-state">
          <CardContent className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              {t("resumeVariants.emptyLead")}
            </p>
            <p className="text-sm font-medium">{t("resumeVariants.emptyHowTo")}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("resumeVariants.emptyStep1")}</li>
              <li>{t("resumeVariants.emptyStep2")}</li>
              <li>{t("resumeVariants.emptyStep3")}</li>
              <li>{t("resumeVariants.emptyStep4")}</li>
            </ol>
            <p className="text-sm text-muted-foreground">
              {t("resumeVariants.emptyProfileHint")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  nameInputRef.current?.scrollIntoView({
                    block: "center",
                    behavior: "smooth",
                  });
                  nameInputRef.current?.focus();
                }}
              >
                {t("resumeVariants.create")}
              </Button>
              <Button variant="outline" asChild>
                <Link href="/dashboard/profile/application">
                  {t("resumeVariants.completeApplicationProfile")}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.id} data-testid="resume-variant-row">
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  {renamingId === row.id ? (
                    <div className="flex flex-wrap gap-2">
                      <Input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        className="max-w-sm"
                      />
                      <Button size="sm" onClick={() => void onRename(row.id)}>
                        {t("common.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenamingId(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="font-medium">{row.name}</div>
                  )}
                  <div className="mt-1 text-sm text-muted-foreground">
                    {row.targetJobTitle
                      ? `${t("resumeVariants.targetJob")}: ${row.targetJobTitle}`
                      : t("resumeVariants.noTargetJob")}
                    {" · "}
                    {row.currentVersion
                      ? `${t("resumeVariants.versionNumber", {
                          number: row.currentVersion.versionNumber,
                        })} · ${t(statusKey(row.currentVersion.status))}`
                      : t("resumeVariants.version")}
                    {" · "}
                    {t("resumeVariants.updatedAt")}{" "}
                    {formatDateTime(row.updatedAt)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" asChild>
                    <Link href={`/dashboard/profile/resumes/${row.id}`}>
                      {t("resumeVariants.open")}
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRenamingId(row.id);
                      setRenameValue(row.name);
                    }}
                  >
                    {t("resumeVariants.rename")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setArchiveId(row.id)}
                  >
                    {t("resumeVariants.archive")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <DeleteAlertDialog
        pageTitle=""
        open={archiveId != null}
        onOpenChange={(open) => {
          if (!open) setArchiveId(null);
        }}
        onDelete={() => void onArchive()}
        alertTitle={t("resumeVariants.archiveConfirmTitle")}
        alertDescription={t("resumeVariants.archiveConfirmDescription")}
        actionLabel={t("resumeVariants.archive")}
      />
    </div>
  );
}
