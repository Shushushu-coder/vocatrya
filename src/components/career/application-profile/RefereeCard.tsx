"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  archiveCandidateReferee,
  copyCandidateRefereeField,
  createCandidateReferee,
  listCandidateReferees,
  revealCandidateReferee,
  updateCandidateReferee,
} from "@/actions/applicationProfile.actions";

type RefereeRow = {
  id: string;
  maskedName: string | null;
  organization: string | null;
  position: string | null;
  relationship: string | null;
  maskedPhone: string | null;
  maskedEmail: string | null;
};

type RefereeRevealed = {
  name: string | null;
  organization: string | null;
  position: string | null;
  relationship: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
};

type RefereeDraft = {
  name: string;
  organization: string;
  position: string;
  relationship: string;
  phone: string;
  email: string;
  note: string;
};

const EMPTY_DRAFT: RefereeDraft = {
  name: "",
  organization: "",
  position: "",
  relationship: "",
  phone: "",
  email: "",
  note: "",
};

const REFEREE_FIELD_KEYS = [
  "name",
  "organization",
  "position",
  "relationship",
  "phone",
  "email",
  "note",
] as const;
type RefereeFieldKey = (typeof REFEREE_FIELD_KEYS)[number];

// Referees are a sensitive dataset: the list renders masked values only, and
// each field copies through its own explicit copy action (D15/D16, §9).
export function RefereeCard() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RefereeRow[]>([]);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RefereeRevealed | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RefereeDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const readSeq = useRef(0);

  function toggleOpen() {
    readSeq.current += 1;
    setOpen((value) => !value);
    setRevealedId(null);
    setRevealed(null);
    setCreating(false);
    setEditingId(null);
    setForm(EMPTY_DRAFT);
  }

  useEffect(() => () => { readSeq.current += 1; }, []);

  const load = useCallback(async () => {
    try {
      const res = await listCandidateReferees();
      if (res?.success) setRows((res.data as RefereeRow[] | null) ?? []);
      else toastError(t("applicationProfile.loadFailed"));
    } catch {
      toastError(t("applicationProfile.loadFailed"));
    }
  }, [t]);

  // Only fetch once the sensitive section is expanded.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handleReveal(id: string) {
    const seq = ++readSeq.current;
    if (revealedId === id) {
      setRevealedId(null);
      setRevealed(null);
      return;
    }
    const res = await revealCandidateReferee(id);
    if (readSeq.current !== seq) return;
    if (res.success && res.data) {
      setRevealedId(id);
      setRevealed(res.data as RefereeRevealed);
    } else {
      toastError(t("applicationProfile.loadFailed"));
    }
  }

  async function handleCopy(id: string, field: RefereeFieldKey) {
    try {
      const res = await copyCandidateRefereeField(id, field);
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

  async function startEdit(row: RefereeRow) {
    const seq = ++readSeq.current;
    const res = await revealCandidateReferee(row.id);
    if (readSeq.current !== seq) return;
    if (!res.success || !res.data) {
      toastError(t("applicationProfile.editLoadFailed"));
      return;
    }
    const d = res.data as RefereeRevealed;
    setForm({
      name: d.name ?? "",
      organization: d.organization ?? "",
      position: d.position ?? "",
      relationship: d.relationship ?? "",
      phone: d.phone ?? "",
      email: d.email ?? "",
      note: d.note ?? "",
    });
    setEditingId(row.id);
    setCreating(false);
  }

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim() || null,
        organization: form.organization.trim() || null,
        position: form.position.trim() || null,
        relationship: form.relationship.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        note: form.note.trim() || null,
      };
      const res = editingId
        ? await updateCandidateReferee({ id: editingId, ...payload }).catch(() => null)
        : await createCandidateReferee(payload).catch(() => null);
      if (res?.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        setCreating(false);
        setEditingId(null);
        setForm(EMPTY_DRAFT);
        setRevealedId(null);
        setRevealed(null);
        await load();
      } else {
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(id: string) {
    if (!window.confirm(t("applicationProfile.archiveConfirm"))) return;
    const res = await archiveCandidateReferee(id);
    if (res.success) {
      readSeq.current += 1;
      toastSuccess(t("applicationProfile.saveSuccess"));
      if (revealedId === id) {
        setRevealedId(null);
        setRevealed(null);
      }
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY_DRAFT);
      }
      await load();
    } else {
      toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
    }
  }

  function fieldValue(row: RefereeRow, key: RefereeFieldKey): string | null {
    if (revealedId === row.id && revealed) return revealed[key];
    if (key === "name") return row.maskedName;
    if (key === "phone") return row.maskedPhone;
    if (key === "email") return row.maskedEmail;
    return (row as unknown as Record<string, string | null>)[key] ?? null;
  }

  const formOpen = creating || editingId !== null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">
            {t("applicationProfile.refereesTitle")}
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
          {rows.length === 0 && (
            <div className="text-sm text-muted-foreground">
              {t("applicationProfile.emptySection")}
            </div>
          )}
          {rows.map((row) => (
            <div key={row.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium" data-testid={`referee-name-${row.id}`}>
                  {fieldValue(row, "name") ?? t("applicationProfile.emptyValue")}
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => handleReveal(row.id)}>
                    {revealedId === row.id
                      ? t("applicationProfile.hide")
                      : t("applicationProfile.reveal")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => startEdit(row)}>
                    {t("common.edit")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleArchive(row.id)}>
                    {t("applicationProfile.archiveMaterial")}
                  </Button>
                </div>
              </div>
              <div className="mt-1 flex flex-col gap-1">
                {REFEREE_FIELD_KEYS.map((key) => {
                  const value = fieldValue(row, key);
                  return (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <div className="text-sm">
                        <span className="mr-2 text-muted-foreground">
                          {t(`applicationProfile.referee${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
                        </span>
                        {value?.trim() ? value : t("applicationProfile.emptyValue")}
                      </div>
                      {value?.trim() && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => handleCopy(row.id, key)}
                        >
                          {t("common.copy")}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {formOpen ? (
            <div className="flex flex-col gap-2 rounded-md border p-3">
              {REFEREE_FIELD_KEYS.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-sm font-medium">
                    {t(`applicationProfile.referee${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
                    {key === "name" ? " *" : ""}
                  </label>
                  <Input
                    value={form[key]}
                    disabled={saving}
                    data-testid={`referee-input-${key}`}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, [key]: e.target.value }))
                    }
                  />
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSave} disabled={saving || !form.name.trim()}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    readSeq.current += 1;
                    setCreating(false);
                    setEditingId(null);
                    setForm(EMPTY_DRAFT);
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                readSeq.current += 1;
                setCreating(true);
                setEditingId(null);
                setForm(EMPTY_DRAFT);
              }}
            >
              {t("applicationProfile.refereeAdd")}
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}
