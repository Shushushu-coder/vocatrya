"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  MaterialCurrentCheckbox,
  MaterialDateField,
  MaterialNotesField,
  MaterialTextField,
} from "./MaterialAutosaveField";
import {
  focusFirstRegionField,
  INPUT_PREF_REGION_ATTR,
  useInputPreferences,
} from "@/lib/inputPreferences";
import {
  StructuredCheckbox,
  StructuredInput,
  StructuredTextarea,
} from "./StructuredField";
import {
  detailFieldDraft,
  detailFieldWire,
  isEditableMaterialType,
  MATERIAL_DETAIL_FIELDS,
  toDateInput,
} from "./materialFields";
import { SkillTagField } from "./SkillTagField";
import { AttachmentInlineList } from "./AttachmentCard";

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
 * One record tab's content: every item card edits its own fields inline and
 * each field auto-saves through a single-key patch, so a commit can never
 * clear sibling fields, undisplayed detail columns, or history. Evidence,
 * copy actions, the read-only block and the create form stay unchanged.
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
  const inputPrefs = useInputPreferences();
  const [materialType, setMaterialType] = useState<string>(
    creatableTypes[0] ?? "CUSTOM",
  );
  const [materialForm, setMaterialForm] =
    useState<MaterialFormState>(EMPTY_MATERIAL_FORM);
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [evidenceForms, setEvidenceForms] = useState<
    Record<string, { content: string; metric: string }>
  >({});

  function detailForSubmit(type: string): Record<string, unknown> {
    const org = materialForm.organization.trim() || null;
    const role = materialForm.role.trim() || null;
    if (type === "LANGUAGE") {
      return {
        // Language records reuse the generic org/role inputs as
        // examOrLevel/score so no extra create-form state is needed.
        language: materialForm.title.trim() || null,
        examOrLevel: materialForm.organization.trim() || null,
        score: materialForm.role.trim() || null,
      };
    }
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
      const res = await createApplicationMaterial({
        type: materialType,
        ...payload,
      });
      if (!res.success) {
        toastError(t("applicationProfile.saveFailed"), undefined, {
          sticky: true,
        });
        return;
      }
      toastSuccess(t("applicationProfile.saveSuccess"));
      setMaterialForm(EMPTY_MATERIAL_FORM);
      await onChanged();
    } finally {
      setSavingMaterial(false);
    }
  }

  /**
   * Single-field incremental write: the patch carries exactly one edited key
   * (one base column, or one key inside `detail`), so untouched fields are
   * never sent and cannot be cleared by the update.
   */
  async function saveMaterialPatch(
    item: MaterialItem,
    patch: {
      title?: string;
      notes?: string | null;
      startDate?: string | null;
      endDate?: string | null;
      isCurrent?: boolean;
      detail?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const res = await updateApplicationMaterial({ id: item.id, ...patch });
    if (!res.success) return false;
    await onChanged();
    return true;
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

  function renderEvidenceBlock(item: MaterialItem) {
    const evidence = (
      (item as unknown as {
        evidence?: { content?: string | null; metricText?: string | null }[];
      }).evidence ?? []
    ).filter((e) => e.content?.trim());
    return (
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
          <StructuredInput
            required
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
            <StructuredInput
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
    );
  }

  function renderMaterialCard(item: MaterialItem) {
    if (!isEditableMaterialType(item.type)) {
      // Legacy/non-allowlist records (EMPLOYMENT, CUSTOM, unknown types)
      // stay read-only, same as before.
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
            {renderEvidenceBlock(item)}
          </CardContent>
        </Card>
      );
    }

    const fieldPrefix = `material-${item.id}`;
    return (
      <Card key={item.id} {...{ [INPUT_PREF_REGION_ATTR]: true }}>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm">
            <span className="mr-2 font-normal text-muted-foreground">
              {t(`applicationProfile.materialType${item.type}`)}
            </span>
            <span>{item.title}</span>
          </CardTitle>
          <div className="flex gap-1">
            {inputPrefs.autoFocus && (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`${fieldPrefix}-start-fill`}
                onClick={(e) =>
                  focusFirstRegionField(
                    e.currentTarget.closest(`[${INPUT_PREF_REGION_ATTR}]`),
                  )
                }
              >
                {t("inputPrefs.startFill")}
              </Button>
            )}
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
              onClick={() => archiveMaterial(item.id)}
            >
              {t("applicationProfile.archiveMaterial")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <MaterialTextField
              label={t("applicationProfile.materialTitle")}
              committed={item.title?.trim() ?? ""}
              required
              onSave={(v) => saveMaterialPatch(item, { title: v })}
              testId={`${fieldPrefix}-title`}
            />
            {MATERIAL_DETAIL_FIELDS[item.type].map((def) =>
              item.type === "SKILL" && def.key === "skillName" ? (
                // Linked skill records take their name from the live Tag —
                // the text editor must not coexist as a second source.
                <SkillTagField
                  key={def.key}
                  materialId={item.id}
                  tag={item.skillDetail?.tag}
                  skillName={detailFieldDraft(item, def)}
                  label={t(`applicationProfile.${def.labelKey}`)}
                  onSaveSkillName={(v) =>
                    saveMaterialPatch(item, {
                      detail: { [def.key]: detailFieldWire(def, v) },
                    })
                  }
                  onChanged={onChanged}
                  testId={`${fieldPrefix}-${def.key}`}
                />
              ) : def.kind === "boolean" ? (
                <MaterialCurrentCheckbox
                  key={def.key}
                  label={t(`applicationProfile.${def.labelKey}`)}
                  committed={detailFieldDraft(item, def) === "true"}
                  onSave={(v) =>
                    saveMaterialPatch(item, {
                      detail: { [def.key]: v },
                    })
                  }
                  testId={`${fieldPrefix}-${def.key}`}
                />
              ) : def.kind === "date" ? (
                <MaterialDateField
                  key={def.key}
                  label={t(`applicationProfile.${def.labelKey}`)}
                  committed={detailFieldDraft(item, def)}
                  onSave={(v) =>
                    saveMaterialPatch(item, {
                      detail: { [def.key]: detailFieldWire(def, v) },
                    })
                  }
                  testId={`${fieldPrefix}-${def.key}`}
                />
              ) : (
                <MaterialTextField
                  key={def.key}
                  label={t(`applicationProfile.${def.labelKey}`)}
                  committed={detailFieldDraft(item, def)}
                  onSave={(v) =>
                    saveMaterialPatch(item, {
                      detail: { [def.key]: detailFieldWire(def, v) },
                    })
                  }
                  testId={`${fieldPrefix}-${def.key}`}
                />
              ),
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <MaterialDateField
              label={t("applicationProfile.materialStartDate")}
              committed={toDateInput(item.startDate)}
              onSave={(v) =>
                saveMaterialPatch(item, { startDate: v || null })
              }
              testId={`${fieldPrefix}-startDate`}
            />
            <MaterialDateField
              label={t("applicationProfile.materialEndDate")}
              committed={toDateInput(item.endDate)}
              onSave={(v) => saveMaterialPatch(item, { endDate: v || null })}
              testId={`${fieldPrefix}-endDate`}
            />
            <MaterialCurrentCheckbox
              label={t("applicationProfile.materialIsCurrent")}
              committed={Boolean(item.isCurrent)}
              onSave={(v) => saveMaterialPatch(item, { isCurrent: v })}
              testId={`${fieldPrefix}-isCurrent`}
            />
          </div>
          <MaterialNotesField
            label={t("applicationProfile.materialNotes")}
            committed={item.notes?.trim() ?? ""}
            onSave={(v) =>
              saveMaterialPatch(item, { notes: v === "" ? null : v })
            }
            testId={`${fieldPrefix}-notes`}
          />
          {renderEvidenceBlock(item)}
          {item.type === "AWARD" && (
            <AttachmentInlineList category="AWARD_PROOF" materialItemId={item.id} />
          )}
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
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">{readonlyTitle}</CardTitle>
            <Button
              variant="outline"
              size="sm"
              data-testid="readonly-copy-section"
              onClick={() =>
                copyText(
                  buildExperienceSectionText(readonlyItems),
                  t("common.copied"),
                  t("applicationProfile.copyFailed"),
                )
              }
            >
              {t("applicationProfile.copySection")}
            </Button>
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
      <Card {...{ [INPUT_PREF_REGION_ATTR]: true }}>
        <CardHeader>
          <CardTitle className="text-base">
            {t("applicationProfile.addMaterial")}
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
            {materialType === "LANGUAGE"
              ? t("applicationProfile.materialLanguage")
              : t("applicationProfile.materialTitle")}
          </label>
          <StructuredInput
            required
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
                <StructuredInput
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
                <StructuredInput
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
                <StructuredInput
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
                <StructuredInput
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
                <StructuredInput
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
                <StructuredInput
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
                  {materialType === "LANGUAGE"
                    ? t("applicationProfile.materialLanguageExam")
                    : t("applicationProfile.materialOrganization")}
                </label>
                <StructuredInput
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
                  {materialType === "LANGUAGE"
                    ? t("applicationProfile.materialLanguageScore")
                    : t("applicationProfile.materialRole")}
                </label>
                <StructuredInput
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
              <StructuredInput
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
              <StructuredInput
                type="date"
                value={materialForm.endDate}
                onChange={(e) =>
                  setMaterialForm((f) => ({ ...f, endDate: e.target.value }))
                }
              />
            </div>
            <div className="flex items-end gap-2">
              <label className="text-sm">
                <StructuredCheckbox
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
          <StructuredTextarea
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
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
