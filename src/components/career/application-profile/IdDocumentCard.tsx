"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  copyIdDocumentField,
  getIdDocumentOverview,
  revealIdDocument,
  updateIdDocument,
} from "@/actions/applicationProfile.actions";

type Overview = {
  hasData: boolean;
  idType: string | null;
  maskedIdNumber: string | null;
};

type Revealed = { idType: string | null; idNumber: string | null };
type Draft = { idType: string; idNumber: string };
const EMPTY_DRAFT: Draft = { idType: "", idNumber: "" };

// ID document card: same masked-by-default / explicit reveal / per-field copy
// contract as EmergencyContactCard (D16, §9). Never renders plaintext before
// an explicit reveal.
export function IdDocumentCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [form, setForm] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const readSeq = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await getIdDocumentOverview();
      if (res?.success && res.data) setOverview(res.data as Overview);
      else toastError(t("applicationProfile.loadFailed"));
    } catch {
      toastError(t("applicationProfile.loadFailed"));
    }
  }, [t]);

  // Only fetch once the sensitive section is expanded.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => () => { readSeq.current += 1; }, []);

  function toggleOpen() {
    if (!open) {
      setOpen(true);
      return;
    }
    readSeq.current += 1;
    setOpen(false);
    setRevealed(null);
    setEditing(false);
    setForm(EMPTY_DRAFT);
  }

  async function handleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    const seq = ++readSeq.current;
    setRevealing(true);
    try {
      const res = await revealIdDocument();
      if (readSeq.current !== seq) return;
      if (res.success && res.data) setRevealed(res.data as Revealed);
      else toastError(t("applicationProfile.loadFailed"));
    } finally {
      setRevealing(false);
    }
  }

  async function handleCopyField(field: "idType" | "idNumber") {
    try {
      const res = await copyIdDocumentField(field);
      if (!res.success || !res.data) {
        toastError(t("applicationProfile.copyFailed"));
        return;
      }
      const value = (res.data as { value: string | null }).value?.trim() ?? "";
      if (!value) return;
      await navigator.clipboard.writeText(value);
      toastSuccess(t("common.copied"));
    } catch {
      toastError(t("applicationProfile.copyFailed"));
    }
  }

  async function startEdit() {
    const seq = ++readSeq.current;
    setEditLoading(true);
    try {
      const res = await revealIdDocument();
      if (readSeq.current !== seq) return;
      if (!res.success || !res.data) {
        toastError(t("applicationProfile.editLoadFailed"));
        return;
      }
      const data = res.data as Revealed;
      setForm({ idType: data.idType ?? "", idNumber: data.idNumber ?? "" });
      setEditing(true);
    } finally {
      setEditLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await updateIdDocument({
        idType: form.idType.trim() || null,
        idNumber: form.idNumber.trim() || null,
      }).catch(() => null);
      if (res?.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        setEditing(false);
        setForm(EMPTY_DRAFT);
        setRevealed(null);
        await load();
      } else {
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      }
    } finally {
      setSaving(false);
    }
  }

  const displayType = revealed?.idType ?? overview?.idType ?? null;
  const displayNumber = revealed?.idNumber ?? overview?.maskedIdNumber ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">
            {t("applicationProfile.idDocumentTitle")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("applicationProfile.sensitiveMaskedHint")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={toggleOpen}>
          {open ? t("applicationProfile.hide") : t("applicationProfile.reveal")}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-md border p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">
              {t("applicationProfile.sensitiveLocalTitle")}
            </div>
            <div>{t("applicationProfile.sensitiveLocalDetail")}</div>
            <div>{t("applicationProfile.sensitiveNoAi")}</div>
          </div>
          {!editing ? (
            <div className="flex flex-col divide-y">
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">
                    {t("applicationProfile.idType")}
                  </div>
                  <div className="text-sm" data-testid="id-doc-type">
                    {displayType?.trim() ? displayType : t("applicationProfile.emptyValue")}
                  </div>
                </div>
                {displayType?.trim() && (
                  <Button variant="ghost" size="sm" onClick={() => handleCopyField("idType")}>
                    {t("common.copy")}
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">
                    {t("applicationProfile.idNumber")}
                  </div>
                  <div className="text-sm" data-testid="id-doc-number">
                    {displayNumber?.trim() ? displayNumber : t("applicationProfile.emptyValue")}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={handleReveal} disabled={revealing}>
                    {revealed ? t("applicationProfile.hide") : t("applicationProfile.reveal")}
                  </Button>
                  {displayNumber?.trim() && (
                    <Button variant="ghost" size="sm" onClick={() => handleCopyField("idNumber")}>
                      {t("common.copy")}
                    </Button>
                  )}
                </div>
              </div>
              <div className="pt-2">
                <Button variant="outline" size="sm" onClick={startEdit} disabled={editLoading}>
                  {editLoading ? t("common.loading") : t("common.edit")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">{t("applicationProfile.idType")}</label>
              <Input
                value={form.idType}
                disabled={saving}
                data-testid="id-doc-input-type"
                onChange={(e) => setForm((f) => ({ ...f, idType: e.target.value }))}
              />
              <label className="text-sm font-medium">{t("applicationProfile.idNumber")}</label>
              <Input
                value={form.idNumber}
                disabled={saving}
                data-testid="id-doc-input-number"
                onChange={(e) => setForm((f) => ({ ...f, idNumber: e.target.value }))}
              />
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setForm(EMPTY_DRAFT);
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
