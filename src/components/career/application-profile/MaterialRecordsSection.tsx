"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  buildExperienceSectionText,
  buildMaterialItemText,
  type MaterialLike,
} from "@/lib/career/applicationCopy";
import {
  archiveApplicationMaterial,
  addApplicationMaterialEvidence,
  createApplicationMaterial,
  updateApplicationMaterial,
} from "@/actions/applicationProfile.actions";

export type MaterialItem = MaterialLike & {
  id: string;
  type: string;
  title: string;
  notes?: string | null;
};

type MaterialFormState = {
  title: string;
  organization: string;
  role: string;
  notes: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  institution: string;
  degree: string;
  fieldOfStudy: string;
  gpaValue: string;
  gpaScale: string;
  rankText: string;
};

const EMPTY_MATERIAL_FORM: MaterialFormState = {
  title: "",
  organization: "",
  role: "",
  notes: "",
  startDate: "",
  endDate: "",
  isCurrent: false,
  institution: "",
  degree: "",
  fieldOfStudy: "",
  gpaValue: "",
  gpaScale: "",
  rankText: "",
};

function toDateInput(value: unknown): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

async function copyText(text: string, copiedLabel: string, failedLabel: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    await navigator.clipboard.writeText(trimmed);
    toastSuccess(copiedLabel);
  } catch {
    toastError(failedLabel);
  }
}

type MaterialRecordsSectionProps = {
  /** Card title shown above the record list (usually the tab name). */
  title: string;
  /** Editable items belonging to this tab, already filtered. */
  items: MaterialItem[];
  /** Material types offered by this tab's create/edit picker. */
  creatableTypes: readonly string[];
  /** Legacy read-only items (e.g. EMPLOYMENT) rendered as plain text. */
  readonlyItems?: MaterialItem[];
  readonlyTitle?: string;
  /** Reload callback after any mutation. */
  onChanged: () => Promise<void> | void;
};

/**
 * One record tab's content: item cards with evidence, a section-level copy
 * action, and the create/edit form restricted to this tab's types. All
 * record CRUD is local to the section so every tab keeps an independent
 * edit session.
 */
export function MaterialRecordsSection({
  title,
  items,
  creatableTypes,
  readonlyItems = [],
  readonlyTitle,
  onChanged,
}: MaterialRecordsSectionProps) {
  const { t } = useI18n();
  const [materialType, setMaterialType] = useState<string>(
    creatableTypes[0] ?? "CUSTOM",
  );
  const [materialForm, setMaterialForm] =
    useState<MaterialFormState>(EMPTY_MATERIAL_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [evidenceForms, setEvidenceForms] = useState<
    Record<string, { content: string; metric: string }>
  >({});

  function detailForSubmit(type: string): Record<string, unknown> {
    const org = materialForm.organization.trim() || null;
    const role = materialForm.role.trim() || null;
    if (type === "EDUCATION") {
      return {
        institution: materialForm.institution.trim() || null,
        degree: materialForm.degree.trim() || null,
        fieldOfStudy: materialForm.fieldOfStudy.trim() || null,
        locationText: null,
        gpaValue: materialForm.gpaValue.trim()
          ? Number(materialForm.gpaValue.trim())
          : null,
        gpaScale: materialForm.gpaScale.trim()
          ? Number(materialForm.gpaScale.trim())
          : null,
        rankText: materialForm.rankText.trim() || null,
      };
    }
    if (type === "SKILL")
      return { skillName: materialForm.title.trim() || null, proficiency: role };
    if (type === "CERTIFICATION") return { organization: org };
    if (type === "INTERNSHIP" || type === "PROJECT" || type === "CAMPUS_ACTIVITY") {
      return { organizationName: org, roleTitle: role };
    }
    if (type === "RESEARCH") return { institution: org, roleTitle: role };
    if (type === "PUBLICATION") return { venue: org, authors: role };
    if (type === "COMPETITION") return { organizer: org, result: role };
    if (type === "AWARD") return { issuer: org };
    return {};
  }

  async function submitMaterial() {
    if (!materialForm.title.trim()) return;
    setSavingMaterial(true);
    try {
      const payload = {
        title: materialForm.title.trim(),
        notes: materialForm.notes.trim() ? materialForm.notes.trim() : null,
        startDate: materialForm.startDate || null,
        endDate: materialForm.endDate || null,
        isCurrent: materialForm.isCurrent,
        detail: detailForSubmit(materialType),
      };
      const res = editingId
        ? await updateApplicationMaterial({ id: editingId, ...payload })
        : await createApplicationMaterial({ type: materialType, ...payload });
      if (!res.success) {
        toastError(t("applicationProfile.saveFailed"), undefined, {
          sticky: true,
        });
        return;
      }
      toastSuccess(t("applicationProfile.saveSuccess"));
      setEditingId(null);
      setMaterialForm(EMPTY_MATERIAL_FORM);
      await onChanged();
    } finally {
      setSavingMaterial(false);
    }
  }

  function startEditMaterial(item: MaterialItem) {
    setMaterialType(item.type);
    setEditingId(item.id);
    const anyItem = item as unknown as Record<
      string,
      Record<string, string | number | null> | undefined
    >;
    const edu = anyItem.educationDetail;
    const intern = anyItem.internshipDetail;
    const project = anyItem.projectDetail;
    const campus = anyItem.campusActivityDetail;
    const research = anyItem.researchDetail;
    const publication = anyItem.publicationDetail;
    const competition = anyItem.competitionDetail;
    const award = anyItem.awardDetail;
    const skill = anyItem.skillDetail;
    const certification = anyItem.certificationDetail;
    setMaterialForm({
      title: item.title ?? "",
      organization:
        (edu?.institution as string) ??
        (intern?.organizationName as string) ??
        (project?.organizationName as string) ??
        (campus?.organizationName as string) ??
        (research?.institution as string) ??
        (publication?.venue as string) ??
        (competition?.organizer as string) ??
        (award?.issuer as string) ??
        (certification?.organization as string) ??
        "",
      role:
        (intern?.roleTitle as string) ??
        (project?.roleTitle as string) ??
        (campus?.roleTitle as string) ??
        (research?.roleTitle as string) ??
        (publication?.authors as string) ??
        (competition?.result as string) ??
        (skill?.proficiency as string) ??
        "",
      notes: (item.notes as string) ?? "",
      startDate: toDateInput(
        (item as unknown as { startDate?: unknown }).startDate,
      ),
      endDate: toDateInput((item as unknown as { endDate?: unknown }).endDate),
      isCurrent: Boolean(
        (item as unknown as { isCurrent?: boolean }).isCurrent,
      ),
      institution: (edu?.institution as string) ?? "",
      degree: (edu?.degree as string) ?? "",
      fieldOfStudy: (edu?.fieldOfStudy as string) ?? "",
      gpaValue:
        edu?.gpaValue !== null && edu?.gpaValue !== undefined
          ? String(edu.gpaValue)
          : "",
      gpaScale:
        edu?.gpaScale !== null && edu?.gpaScale !== undefined
          ? String(edu.gpaScale)
          : "",
      rankText: (edu?.rankText as string) ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setMaterialForm(EMPTY_MATERIAL_FORM);
  }

  async function archiveMaterial(id: string) {
    if (!window.confirm(t("applicationProfile.archiveConfirm"))) return;
    const res = await archiveApplicationMaterial(id);
    if (res.success) {
      toastSuccess(t("applicationProfile.saveSuccess"));
      await onChanged();
    } else {
      toastError(t("applicationProfile.saveFailed"), undefined, {
        sticky: true,
      });
    }
  }

  async function addEvidence(itemId: string) {
    const form = evidenceForms[itemId] ?? { content: "", metric: "" };
    if (!form.content.trim()) return;
    const res = await addApplicationMaterialEvidence({
      materialItemId: itemId,
      content: form.content,
      metricText: form.metric || null,
    });
    if (res.success) {
      toastSuccess(t("applicationProfile.saveSuccess"));
      setEvidenceForms((prev) => ({
        ...prev,
        [itemId]: { content: "", metric: "" },
      }));
      await onChanged();
    } else {
      toastError(t("applicationProfile.saveFailed"), undefined, {
        sticky: true,
      });
    }
  }

  function renderMaterialCard(item: MaterialItem) {
    const evidence = (
      (item as unknown as {
        evidence?: { content?: string | null; metricText?: string | null }[];
      }).evidence ?? []
    ).filter((e) => e.content?.trim());
    return (
      <Card key={item.id}>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm">{item.title}</CardTitle>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                copyText(
                  buildMaterialItemText(item),
                  t("common.copied"),
                  t("applicationProfile.copyFailed"),
                )
              }
            >
              {t("applicationProfile.copyItem")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startEditMaterial(item)}
            >
              {t("common.edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => archiveMaterial(item.id)}
            >
              {t("applicationProfile.archiveMaterial")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {item.notes?.trim() && (
            <div className="text-muted-foreground">{item.notes}</div>
          )}
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              {t("applicationProfile.evidenceTitle")}
            </div>
            {evidence.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                {t("applicationProfile.emptySection")}
              </div>
            ) : (
              evidence.map((e, idx) => (
                <div key={idx} className="text-sm">
                  - {e.content}
                  {e.metricText ? ` (${e.metricText})` : ""}
                </div>
              ))
            )}
            <div className="mt-2 flex flex-col gap-1">
              <Input
                placeholder={t("applicationProfile.evidenceContent")}
                value={evidenceForms[item.id]?.content ?? ""}
                onChange={(e) =>
                  setEvidenceForms((prev) => ({
                    ...prev,
                    [item.id]: {
                      content: e.target.value,
                      metric: prev[item.id]?.metric ?? "",
                    },
                  }))
                }
              />
              <div className="flex gap-1">
                <Input
                  placeholder={t("applicationProfile.evidenceMetric")}
                  value={evidenceForms[item.id]?.metric ?? ""}
                  onChange={(e) =>
                    setEvidenceForms((prev) => ({
                      ...prev,
                      [item.id]: {
                        content: prev[item.id]?.content ?? "",
                        metric: e.target.value,
                      },
                    }))
                  }
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addEvidence(item.id)}
                >
                  {t("applicationProfile.evidenceAdd")}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {items.length === 0 && (
            <div className="text-sm text-muted-foreground">
              {t("applicationProfile.emptySection")}
            </div>
          )}
          {items.map(renderMaterialCard)}
          {items.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                copyText(
                  buildExperienceSectionText(items),
                  t("common.copied"),
                  t("applicationProfile.copyFailed"),
                )
              }
            >
              {t("applicationProfile.copySection")}
            </Button>
          )}
        </CardContent>
      </Card>
      {readonlyItems.length > 0 && readonlyTitle && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{readonlyTitle}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {readonlyItems.map((item) => (
              <div key={item.id} className="text-sm">
                {item.title}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {editingId
              ? t("applicationProfile.editMaterial")
              : t("applicationProfile.addMaterial")}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            {creatableTypes.map((type) => (
              <Button
                key={type}
                size="sm"
                variant={materialType === type ? "default" : "outline"}
                onClick={() => setMaterialType(type)}
              >
                {t(`applicationProfile.materialType${type}`)}
              </Button>
            ))}
          </div>
          <label className="text-sm font-medium">
            {t("applicationProfile.materialTitle")}
          </label>
          <Input
            value={materialForm.title}
            onChange={(e) =>
              setMaterialForm((f) => ({ ...f, title: e.target.value }))
            }
          />
          {materialType === "EDUCATION" ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialInstitution")}
                </label>
                <Input
                  value={materialForm.institution}
                  onChange={(e) =>
                    setMaterialForm((f) => ({
                      ...f,
                      institution: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialDegree")}
                </label>
                <Input
                  value={materialForm.degree}
                  onChange={(e) =>
                    setMaterialForm((f) => ({ ...f, degree: e.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialFieldOfStudy")}
                </label>
                <Input
                  value={materialForm.fieldOfStudy}
                  onChange={(e) =>
                    setMaterialForm((f) => ({
                      ...f,
                      fieldOfStudy: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialGpa")}
                </label>
                <Input
                  value={materialForm.gpaValue}
                  onChange={(e) =>
                    setMaterialForm((f) => ({ ...f, gpaValue: e.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialGpaScale")}
                </label>
                <Input
                  value={materialForm.gpaScale}
                  onChange={(e) =>
                    setMaterialForm((f) => ({ ...f, gpaScale: e.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialRank")}
                </label>
                <Input
                  value={materialForm.rankText}
                  onChange={(e) =>
                    setMaterialForm((f) => ({ ...f, rankText: e.target.value }))
                  }
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialOrganization")}
                </label>
                <Input
                  value={materialForm.organization}
                  onChange={(e) =>
                    setMaterialForm((f) => ({
                      ...f,
                      organization: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm">
                  {t("applicationProfile.materialRole")}
                </label>
                <Input
                  value={materialForm.role}
                  onChange={(e) =>
                    setMaterialForm((f) => ({ ...f, role: e.target.value }))
                  }
                />
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <label className="text-sm">
                {t("applicationProfile.materialStartDate")}
              </label>
              <Input
                type="date"
                value={materialForm.startDate}
                onChange={(e) =>
                  setMaterialForm((f) => ({ ...f, startDate: e.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm">
                {t("applicationProfile.materialEndDate")}
              </label>
              <Input
                type="date"
                value={materialForm.endDate}
                onChange={(e) =>
                  setMaterialForm((f) => ({ ...f, endDate: e.target.value }))
                }
              />
            </div>
            <div className="flex items-end gap-2">
              <label className="text-sm">
                <input
                  type="checkbox"
                  checked={materialForm.isCurrent}
                  onChange={(e) =>
                    setMaterialForm((f) => ({
                      ...f,
                      isCurrent: e.target.checked,
                    }))
                  }
                />{" "}
                {t("applicationProfile.materialIsCurrent")}
              </label>
            </div>
          </div>
          <label className="text-sm font-medium">
            {t("applicationProfile.materialNotes")}
          </label>
          <Textarea
            value={materialForm.notes}
            onChange={(e) =>
              setMaterialForm((f) => ({ ...f, notes: e.target.value }))
            }
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={submitMaterial}
              disabled={savingMaterial}
            >
              {savingMaterial ? t("common.saving") : t("common.save")}
            </Button>
            {editingId && (
              <Button size="sm" variant="outline" onClick={cancelEdit}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
