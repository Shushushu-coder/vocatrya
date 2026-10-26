"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  copyEmergencyContactField,
  getEmergencyContactOverview,
  getLocalDbPathDisplay,
  revealEmergencyContact,
  updateEmergencyContact,
} from "@/actions/applicationProfile.actions";

type Overview = {
  hasData: boolean;
  maskedName: string | null;
  relation: string | null;
  maskedPhone: string | null;
};

type Revealed = {
  name: string | null;
  relation: string | null;
  phone: string | null;
};

type Draft = { name: string; relation: string; phone: string };

const EMPTY_DRAFT: Draft = { name: "", relation: "", phone: "" };

export function EmergencyContactCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [form, setForm] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [storagePath, setStoragePath] = useState<
    { status: "loading" } | { status: "known"; path: string } | { status: "unavailable" }
  >({ status: "loading" });
  // Latest plaintext read wins: collapsing or starting a newer read invalidates
  // in-flight reveal/edit reads so a late response cannot repopulate plaintext.
  const readSeq = useRef(0);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await getEmergencyContactOverview();
    if (loadSeq.current !== seq) return;
    if (res.success && res.data) {
      setOverview(res.data as Overview);
    } else {
      toastError(t("applicationProfile.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setStoragePath({ status: "loading" });
    void (async () => {
      const res = await getLocalDbPathDisplay();
      if (stale) return;
      if (!res.success || !res.data) {
        setStoragePath({ status: "unavailable" });
        return;
      }
      if (res.data.kind === "local-file") {
        setStoragePath({ status: "known", path: res.data.path });
        return;
      }
      setStoragePath({ status: "unavailable" });
    })();
    return () => {
      stale = true;
    };
  }, [open]);

  function toggleOpen() {
    if (!open) {
      setOpen(true);
      return;
    }
    readSeq.current += 1;
    setOpen(false);
    setRevealed(null);
    // A save already in flight keeps its draft so a failure can still be
    // retried; every other collapse drops plaintext draft state entirely.
    if (!saving) {
      setEditing(false);
      setBaseline(null);
      setForm(EMPTY_DRAFT);
    }
  }

  async function handleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    const seq = ++readSeq.current;
    setRevealing(true);
    try {
      const res = await revealEmergencyContact();
      if (readSeq.current !== seq) return;
      if (res.success && res.data) {
        setRevealed(res.data as Revealed);
      } else {
        toastError(t("applicationProfile.loadFailed"));
      }
    } finally {
      setRevealing(false);
    }
  }

  async function handleCopyField(field: "emergencyContactName" | "emergencyContactRelation" | "emergencyContactPhone") {
    try {
      const res = await copyEmergencyContactField(field);
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
      const res = await revealEmergencyContact();
      if (readSeq.current !== seq) return;
      if (!res.success || !res.data) {
        toastError(t("applicationProfile.editLoadFailed"));
        return;
      }
      const data = res.data as Revealed;
      setBaseline({
        name: (data.name ?? "").trim(),
        relation: (data.relation ?? "").trim(),
        phone: (data.phone ?? "").trim(),
      });
      setForm({
        name: data.name ?? "",
        relation: data.relation ?? "",
        phone: data.phone ?? "",
      });
      setEditing(true);
    } finally {
      setEditLoading(false);
    }
  }

  function cancelEdit() {
    setEditing(false);
    setBaseline(null);
    setForm(EMPTY_DRAFT);
  }

  async function handleSave() {
    if (!baseline) return;
    const next: Draft = {
      name: form.name.trim(),
      relation: form.relation.trim(),
      phone: form.phone.trim(),
    };
    const payload: {
      emergencyContactName?: string | null;
      emergencyContactRelation?: string | null;
      emergencyContactPhone?: string | null;
    } = {};
    if (next.name !== baseline.name) {
      payload.emergencyContactName = next.name || null;
    }
    if (next.relation !== baseline.relation) {
      payload.emergencyContactRelation = next.relation || null;
    }
    if (next.phone !== baseline.phone) {
      payload.emergencyContactPhone = next.phone || null;
    }
    if (Object.keys(payload).length === 0) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      const res = await updateEmergencyContact(payload);
      if (res.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        setEditing(false);
        setBaseline(null);
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

  const displayName = revealed?.name ?? overview?.maskedName ?? null;
  const displayRelation = revealed?.relation ?? overview?.relation ?? null;
  const displayPhone = revealed?.phone ?? overview?.maskedPhone ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">{t("applicationProfile.emergencyContactTitle")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("applicationProfile.emergencyContactHint")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={toggleOpen}>
          {open ? t("applicationProfile.hide") : t("applicationProfile.reveal")}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3">
          <div
            className="rounded-md border p-3 text-xs text-muted-foreground"
            data-testid="sensitive-storage-notice"
          >
            <div className="font-medium text-foreground">{t("applicationProfile.sensitiveLocalTitle")}</div>
            <div>{t("applicationProfile.sensitiveLocalDetail")}</div>
            <div>{t("applicationProfile.sensitiveNoAi")}</div>
            <div>
              {storagePath.status === "known"
                ? t("applicationProfile.sensitiveStoragePath", { path: storagePath.path })
                : storagePath.status === "unavailable"
                  ? t("applicationProfile.sensitiveStorageUnknown")
                  : t("applicationProfile.sensitiveStorageLoading")}
            </div>
          </div>

          {!editing ? (
            <div className="flex flex-col divide-y">
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">{t("applicationProfile.emergencyContactName")}</div>
                  <div className="text-sm" data-testid="emergency-name">
                    {displayName?.trim() ? displayName : t("applicationProfile.emptyValue")}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={handleReveal} disabled={revealing}>
                    {revealed ? t("applicationProfile.hide") : t("applicationProfile.reveal")}
                  </Button>
                  {displayName?.trim() && (
                    <Button variant="ghost" size="sm" onClick={() => handleCopyField("emergencyContactName")}>
                      {t("common.copy")}
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">{t("applicationProfile.emergencyContactRelation")}</div>
                  <div className="text-sm" data-testid="emergency-relation">
                    {displayRelation?.trim() ? displayRelation : t("applicationProfile.emptyValue")}
                  </div>
                </div>
                <div className="flex gap-1">
                  {displayRelation?.trim() && (
                    <Button variant="ghost" size="sm" onClick={() => handleCopyField("emergencyContactRelation")}>
                      {t("common.copy")}
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between py-2">
                <div>
                  <div className="text-sm font-medium">{t("applicationProfile.emergencyContactPhone")}</div>
                  <div className="text-sm" data-testid="emergency-phone">
                    {displayPhone?.trim() ? displayPhone : t("applicationProfile.emptyValue")}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={handleReveal} disabled={revealing}>
                    {revealed ? t("applicationProfile.hide") : t("applicationProfile.reveal")}
                  </Button>
                  {displayPhone?.trim() && (
                    <Button variant="ghost" size="sm" onClick={() => handleCopyField("emergencyContactPhone")}>
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
              <label className="text-sm font-medium">{t("applicationProfile.emergencyContactName")}</label>
              <Input
                value={form.name}
                disabled={saving}
                data-testid="emergency-input-name"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              <label className="text-sm font-medium">{t("applicationProfile.emergencyContactRelation")}</label>
              <Input
                value={form.relation}
                disabled={saving}
                data-testid="emergency-input-relation"
                onChange={(e) => setForm((f) => ({ ...f, relation: e.target.value }))}
              />
              <label className="text-sm font-medium">{t("applicationProfile.emergencyContactPhone")}</label>
              <Input
                value={form.phone}
                disabled={saving}
                data-testid="emergency-input-phone"
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
                <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saving}>
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
