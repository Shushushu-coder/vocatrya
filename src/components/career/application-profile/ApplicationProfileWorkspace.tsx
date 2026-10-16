"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  buildApplicationProjectionText,
  buildEducationSectionText,
  buildExperienceSectionText,
  buildMaterialItemText,
  buildSkillsSectionText,
  type MaterialLike,
} from "@/lib/career/applicationCopy";
import {
  archiveApplicationMaterial,
  addApplicationMaterialEvidence,
  createApplicationMaterial,
  getApplicationCandidateProfile,
  getApplicationProjection,
  getJobSearchPreference,
  listApplicationMaterials,
  updateApplicationCandidateProfile,
  updateApplicationMaterial,
  upsertJobSearchPreference,
} from "@/actions/applicationProfile.actions";
import { ApplicationProfileField } from "./ApplicationProfileField";
import { EmergencyContactCard } from "./EmergencyContactCard";

type Profile = {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  gender?: string | null;
  birthDate?: string | null;
  ethnicity?: string | null;
  politicalStatus?: string | null;
  nativePlace?: string | null;
  householdRegistration?: string | null;
  graduationCohort?: string | null;
};

type Preference = {
  targetRoles?: string | null;
  preferredCities?: string | null;
  preferredIndustries?: string | null;
  recruitmentTypes?: string | null;
  availability?: string | null;
  hardConstraints?: string | null;
  softPreferences?: string | null;
};

type MaterialItem = MaterialLike & {
  id: string;
  type: string;
  title: string;
  notes?: string | null;
};

const EDITABLE_TYPES = [
  "EDUCATION",
  "INTERNSHIP",
  "PROJECT",
  "CAMPUS_ACTIVITY",
  "RESEARCH",
  "COMPETITION",
  "AWARD",
  "PUBLICATION",
  "SKILL",
  "CERTIFICATION",
] as const;

const EXPERIENCE_TYPES = new Set(["INTERNSHIP", "PROJECT", "CAMPUS_ACTIVITY", "RESEARCH", "COMPETITION", "AWARD", "PUBLICATION"]);
const SKILL_TYPES = new Set(["SKILL", "CERTIFICATION"]);

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

export function ApplicationProfileWorkspace() {
  const { t } = useI18n();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [preference, setPreference] = useState<Preference | null>(null);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [editingBasics, setEditingBasics] = useState(false);
  const [basicsForm, setBasicsForm] = useState<Profile>({});
  const [savingBasics, setSavingBasics] = useState(false);
  const [editingIntent, setEditingIntent] = useState(false);
  const [intentForm, setIntentForm] = useState<Preference>({});
  const [savingIntent, setSavingIntent] = useState(false);
  const [materialType, setMaterialType] = useState<string>("EDUCATION");
  const [materialForm, setMaterialForm] = useState({ title: "", organization: "", role: "", notes: "", startDate: "", endDate: "", isCurrent: false, institution: "", degree: "", fieldOfStudy: "", gpaValue: "", gpaScale: "", rankText: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [evidenceForms, setEvidenceForms] = useState<Record<string, { content: string; metric: string }>>({});

  const load = useCallback(async () => {
    const [p, pref, mats] = await Promise.all([
      getApplicationCandidateProfile(),
      getJobSearchPreference(),
      listApplicationMaterials(),
    ]);
    if (p.success) setProfile((p.data as Profile | null) ?? null);
    else toastError(t("applicationProfile.loadFailed"));
    if (pref.success) setPreference((pref.data as Preference | null) ?? null);
    if (mats.success) setMaterials(((mats.data as MaterialItem[] | null) ?? []) as MaterialItem[]);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const educationItems = useMemo(() => materials.filter((m) => m.type === "EDUCATION"), [materials]);
  const experienceItems = useMemo(() => materials.filter((m) => EXPERIENCE_TYPES.has(m.type)), [materials]);
  const skillItems = useMemo(() => materials.filter((m) => SKILL_TYPES.has(m.type)), [materials]);
  const employmentItems = useMemo(() => materials.filter((m) => m.type === "EMPLOYMENT"), [materials]);

  const isProfileEmpty = !profile || !Object.values(profile).some((v) => v?.trim());

  function startEditBasics() {
    setBasicsForm({ ...(profile ?? {}) });
    setEditingBasics(true);
  }

  async function saveBasics() {
    setSavingBasics(true);
    try {
      const res = await updateApplicationCandidateProfile({
        fullName: basicsForm.fullName ?? null,
        email: basicsForm.email ?? null,
        phone: basicsForm.phone ?? null,
        address: basicsForm.address ?? null,
        gender: basicsForm.gender ?? null,
        birthDate: basicsForm.birthDate ?? null,
        ethnicity: basicsForm.ethnicity ?? null,
        politicalStatus: basicsForm.politicalStatus ?? null,
        nativePlace: basicsForm.nativePlace ?? null,
        householdRegistration: basicsForm.householdRegistration ?? null,
        graduationCohort: basicsForm.graduationCohort ?? null,
      });
      if (res.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        setEditingBasics(false);
        await load();
      } else {
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      }
    } finally {
      setSavingBasics(false);
    }
  }

  function startEditIntent() {
    setIntentForm({ ...(preference ?? {}) });
    setEditingIntent(true);
  }

  async function saveIntent() {
    setSavingIntent(true);
    try {
      const res = await upsertJobSearchPreference({
        targetRoles: intentForm.targetRoles ?? null,
        preferredCities: intentForm.preferredCities ?? null,
        preferredIndustries: intentForm.preferredIndustries ?? null,
        recruitmentTypes: intentForm.recruitmentTypes ?? null,
        availability: intentForm.availability ?? null,
        hardConstraints: intentForm.hardConstraints ?? null,
        softPreferences: intentForm.softPreferences ?? null,
      });
      if (res.success) {
        toastSuccess(t("applicationProfile.saveSuccess"));
        setEditingIntent(false);
        await load();
      } else {
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      }
    } finally {
      setSavingIntent(false);
    }
  }

  function detailForSubmit(type: string): Record<string, unknown> {
    const org = materialForm.organization.trim() || null;
    const role = materialForm.role.trim() || null;
    if (type === "EDUCATION") {
      return {
        institution: materialForm.institution.trim() || null,
        degree: materialForm.degree.trim() || null,
        fieldOfStudy: materialForm.fieldOfStudy.trim() || null,
        locationText: null,
        gpaValue: materialForm.gpaValue.trim() ? Number(materialForm.gpaValue.trim()) : null,
        gpaScale: materialForm.gpaScale.trim() ? Number(materialForm.gpaScale.trim()) : null,
        rankText: materialForm.rankText.trim() || null,
      };
    }
    if (type === "SKILL") return { skillName: materialForm.title.trim() || null, proficiency: role };
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
      if (editingId) {
        const res = await updateApplicationMaterial({
          id: editingId,
          title: materialForm.title.trim(),
          notes: materialForm.notes.trim() ? materialForm.notes.trim() : null,
          startDate: materialForm.startDate || null,
          endDate: materialForm.endDate || null,
          isCurrent: materialForm.isCurrent,
          detail: detailForSubmit(materialType),
        });
        if (!res.success) toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
        else toastSuccess(t("applicationProfile.saveSuccess"));
      } else {
        const res = await createApplicationMaterial({
          type: materialType,
          title: materialForm.title.trim(),
          notes: materialForm.notes.trim() ? materialForm.notes.trim() : null,
          startDate: materialForm.startDate || null,
          endDate: materialForm.endDate || null,
          isCurrent: materialForm.isCurrent,
          detail: detailForSubmit(materialType),
        });
        if (!res.success) toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
        else toastSuccess(t("applicationProfile.saveSuccess"));
      }
      setEditingId(null);
      setMaterialForm({ title: "", organization: "", role: "", notes: "", startDate: "", endDate: "", isCurrent: false, institution: "", degree: "", fieldOfStudy: "", gpaValue: "", gpaScale: "", rankText: "" });
      await load();
    } finally {
      setSavingMaterial(false);
    }
  }

  function startEditMaterial(item: MaterialItem) {
    setMaterialType(item.type);
    setEditingId(item.id);
    const anyItem = item as unknown as Record<string, Record<string, string | number | null> | undefined>;
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
      startDate: toDateInput((item as unknown as { startDate?: unknown }).startDate),
      endDate: toDateInput((item as unknown as { endDate?: unknown }).endDate),
      isCurrent: Boolean((item as unknown as { isCurrent?: boolean }).isCurrent),
      institution: (edu?.institution as string) ?? "",
      degree: (edu?.degree as string) ?? "",
      fieldOfStudy: (edu?.fieldOfStudy as string) ?? "",
      gpaValue: edu?.gpaValue !== null && edu?.gpaValue !== undefined ? String(edu.gpaValue) : "",
      gpaScale: edu?.gpaScale !== null && edu?.gpaScale !== undefined ? String(edu.gpaScale) : "",
      rankText: (edu?.rankText as string) ?? "",
    });
  }

  async function archiveMaterial(id: string) {
    if (!window.confirm(t("applicationProfile.archiveConfirm"))) return;
    const res = await archiveApplicationMaterial(id);
    if (res.success) {
      toastSuccess(t("applicationProfile.saveSuccess"));
      await load();
    } else toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
  }

  async function addEvidence(itemId: string) {
    const form = evidenceForms[itemId] ?? { content: "", metric: "" };
    if (!form.content.trim()) return;
    const res = await addApplicationMaterialEvidence({ materialItemId: itemId, content: form.content, metricText: form.metric || null });
    if (res.success) {
      toastSuccess(t("applicationProfile.saveSuccess"));
      setEvidenceForms((prev) => ({ ...prev, [itemId]: { content: "", metric: "" } }));
      await load();
    } else toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
  }

  const projection = useMemo(() => {
    return buildApplicationProjectionText({
      profile: profile
        ? {
            fullName: profile.fullName,
            email: profile.email,
            phone: profile.phone,
            address: profile.address,
            gender: profile.gender,
            birthDate: profile.birthDate,
            ethnicity: profile.ethnicity,
            politicalStatus: profile.politicalStatus,
            nativePlace: profile.nativePlace,
            householdRegistration: profile.householdRegistration,
            graduationCohort: profile.graduationCohort,
          }
        : null,
      preference: preference
        ? {
            targetRoles: preference.targetRoles,
            preferredCities: preference.preferredCities,
            preferredIndustries: preference.preferredIndustries,
            recruitmentTypes: preference.recruitmentTypes,
            availability: preference.availability,
          }
        : null,
      education: educationItems,
      experience: experienceItems,
      skills: skillItems,
    });
  }, [profile, preference, educationItems, experienceItems, skillItems]);

  function renderMaterialCard(item: MaterialItem) {
    const evidence = ((item as unknown as { evidence?: { content?: string | null; metricText?: string | null }[] }).evidence ?? []).filter((e) => e.content?.trim());
    return (
      <Card key={item.id}>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm">{item.title}</CardTitle>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => copyText(buildMaterialItemText(item), t("common.copied"), t("applicationProfile.copyFailed"))}>
              {t("applicationProfile.copyItem")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => startEditMaterial(item)}>
              {t("common.edit")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => archiveMaterial(item.id)}>
              {t("applicationProfile.archiveMaterial")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {item.notes?.trim() && <div className="text-muted-foreground">{item.notes}</div>}
          <div>
            <div className="text-xs font-medium text-muted-foreground">{t("applicationProfile.evidenceTitle")}</div>
            {evidence.length === 0 ? (
              <div className="text-xs text-muted-foreground">{t("applicationProfile.emptySection")}</div>
            ) : (
              evidence.map((e, idx) => (
                <div key={idx} className="text-sm">- {e.content}{e.metricText ? ` (${e.metricText})` : ""}</div>
              ))
            )}
            <div className="mt-2 flex flex-col gap-1">
              <Input
                placeholder={t("applicationProfile.evidenceContent")}
                value={evidenceForms[item.id]?.content ?? ""}
                onChange={(e) => setEvidenceForms((prev) => ({ ...prev, [item.id]: { content: e.target.value, metric: prev[item.id]?.metric ?? "" } }))}
              />
              <div className="flex gap-1">
                <Input
                  placeholder={t("applicationProfile.evidenceMetric")}
                  value={evidenceForms[item.id]?.metric ?? ""}
                  onChange={(e) => setEvidenceForms((prev) => ({ ...prev, [item.id]: { content: prev[item.id]?.content ?? "", metric: e.target.value } }))}
                />
                <Button size="sm" variant="outline" onClick={() => addEvidence(item.id)}>
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
      <div className="rounded-md border p-3 text-xs text-muted-foreground" data-testid="legacy-independent-notice">
        {t("applicationProfile.legacyIndependentNotice")}
      </div>
      <Tabs defaultValue="basics">
        <TabsList>
          <TabsTrigger value="basics">{t("applicationProfile.tabsBasics")}</TabsTrigger>
          <TabsTrigger value="intent">{t("applicationProfile.tabsIntent")}</TabsTrigger>
          <TabsTrigger value="materials">{t("applicationProfile.tabsMaterials")}</TabsTrigger>
          <TabsTrigger value="overview">{t("applicationProfile.tabsOverview")}</TabsTrigger>
        </TabsList>

        <TabsContent value="basics">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{t("applicationProfile.tabsBasics")}</CardTitle>
              {!editingBasics ? (
                <Button size="sm" variant="outline" onClick={startEditBasics}>{t("common.edit")}</Button>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveBasics} disabled={savingBasics}>{savingBasics ? t("common.saving") : t("common.save")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingBasics(false)}>{t("common.cancel")}</Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {!editingBasics ? (
                <div className="flex flex-col divide-y">
                  <ApplicationProfileField label={t("applicationProfile.fieldFullName")} value={profile?.fullName} />
                  <ApplicationProfileField label={t("applicationProfile.fieldEmail")} value={profile?.email} />
                  <ApplicationProfileField label={t("applicationProfile.fieldPhone")} value={profile?.phone} />
                  <ApplicationProfileField label={t("applicationProfile.fieldAddress")} value={profile?.address} />
                  <ApplicationProfileField label={t("applicationProfile.fieldGender")} value={profile?.gender} />
                  <ApplicationProfileField label={t("applicationProfile.fieldBirthDate")} value={profile?.birthDate} />
                  <ApplicationProfileField label={t("applicationProfile.fieldEthnicity")} value={profile?.ethnicity} />
                  <ApplicationProfileField label={t("applicationProfile.fieldPoliticalStatus")} value={profile?.politicalStatus} />
                  <ApplicationProfileField label={t("applicationProfile.fieldNativePlace")} value={profile?.nativePlace} />
                  <ApplicationProfileField label={t("applicationProfile.fieldHouseholdRegistration")} value={profile?.householdRegistration} />
                  <ApplicationProfileField label={t("applicationProfile.fieldGraduationCohort")} value={profile?.graduationCohort} />
                  {isProfileEmpty && (
                    <div className="flex flex-col gap-2 py-3 text-sm text-muted-foreground">
                      <span>{t("applicationProfile.legacyNoSyncHint")}</span>
                      <Link className="text-primary underline" href="/dashboard/profile">{t("applicationProfile.viewExistingResume")}</Link>
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  {(["fullName", "email", "phone", "address", "gender", "birthDate", "ethnicity", "politicalStatus", "nativePlace", "householdRegistration", "graduationCohort"] as const).map((key) => (
                    <div key={key} className="flex flex-col gap-1">
                      <label className="text-sm font-medium">{t(`applicationProfile.field${key.charAt(0).toUpperCase()}${key.slice(1)}`)}</label>
                      <Input value={(basicsForm[key] as string) ?? ""} onChange={(e) => setBasicsForm((f) => ({ ...f, [key]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <div className="mt-4">
            <EmergencyContactCard />
          </div>
        </TabsContent>

        <TabsContent value="intent">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{t("applicationProfile.tabsIntent")}</CardTitle>
              {!editingIntent ? (
                <Button size="sm" variant="outline" onClick={startEditIntent}>{t("common.edit")}</Button>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveIntent} disabled={savingIntent}>{savingIntent ? t("common.saving") : t("common.save")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingIntent(false)}>{t("common.cancel")}</Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {!editingIntent ? (
                <div className="flex flex-col divide-y">
                  <ApplicationProfileField label={t("applicationProfile.intentTargetRoles")} value={preference?.targetRoles} />
                  <ApplicationProfileField label={t("applicationProfile.intentPreferredCities")} value={preference?.preferredCities} />
                  <ApplicationProfileField label={t("applicationProfile.intentPreferredIndustries")} value={preference?.preferredIndustries} />
                  <ApplicationProfileField label={t("applicationProfile.intentRecruitmentTypes")} value={preference?.recruitmentTypes} />
                  <ApplicationProfileField label={t("applicationProfile.intentAvailability")} value={preference?.availability} />
                  <div className="py-2">
                    <div className="text-sm font-medium">{t("applicationProfile.intentInternalTitle")}</div>
                    <div className="text-xs text-muted-foreground">{t("applicationProfile.intentInternalHint")}</div>
                    <div className="text-sm text-muted-foreground">
                      {[preference?.hardConstraints, preference?.softPreferences].filter((v) => v?.trim()).length > 0
                        ? [preference?.hardConstraints, preference?.softPreferences].filter(Boolean).join(" / ")
                        : t("applicationProfile.emptyValue")}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {(["targetRoles", "preferredCities", "preferredIndustries", "recruitmentTypes", "availability"] as const).map((key) => (
                    <div key={key} className="flex flex-col gap-1">
                      <label className="text-sm font-medium">{t(`applicationProfile.intent${key.charAt(0).toUpperCase()}${key.slice(1)}`)}</label>
                      <Textarea value={(intentForm[key] as string) ?? ""} onChange={(e) => setIntentForm((f) => ({ ...f, [key]: e.target.value }))} />
                    </div>
                  ))}
                  <div className="text-sm font-medium">{t("applicationProfile.intentInternalTitle")}</div>
                  <div className="text-xs text-muted-foreground">{t("applicationProfile.intentInternalHint")}</div>
                  <label className="text-sm font-medium">{t("applicationProfile.intentHardConstraints")}</label>
                  <Textarea value={intentForm.hardConstraints ?? ""} onChange={(e) => setIntentForm((f) => ({ ...f, hardConstraints: e.target.value }))} />
                  <label className="text-sm font-medium">{t("applicationProfile.intentSoftPreferences")}</label>
                  <Textarea value={intentForm.softPreferences ?? ""} onChange={(e) => setIntentForm((f) => ({ ...f, softPreferences: e.target.value }))} />
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="materials">
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("applicationProfile.materialsEducation")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {educationItems.length === 0 && <div className="text-sm text-muted-foreground">{t("applicationProfile.emptySection")}</div>}
                {educationItems.map(renderMaterialCard)}
                {educationItems.length > 0 && (
                  <Button variant="outline" size="sm" className="w-fit" onClick={() => copyText(buildEducationSectionText(educationItems), t("common.copied"), t("applicationProfile.copyFailed"))}>
                    {t("applicationProfile.copySection")}
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("applicationProfile.materialsExperience")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {experienceItems.length === 0 && <div className="text-sm text-muted-foreground">{t("applicationProfile.emptySection")}</div>}
                {experienceItems.map(renderMaterialCard)}
                {experienceItems.length > 0 && (
                  <Button variant="outline" size="sm" className="w-fit" onClick={() => copyText(buildExperienceSectionText(experienceItems), t("common.copied"), t("applicationProfile.copyFailed"))}>
                    {t("applicationProfile.copySection")}
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("applicationProfile.materialsSkills")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {skillItems.length === 0 && <div className="text-sm text-muted-foreground">{t("applicationProfile.emptySection")}</div>}
                {skillItems.map(renderMaterialCard)}
                {skillItems.length > 0 && (
                  <Button variant="outline" size="sm" className="w-fit" onClick={() => copyText(buildSkillsSectionText(skillItems), t("common.copied"), t("applicationProfile.copyFailed"))}>
                    {t("applicationProfile.copySection")}
                  </Button>
                )}
                <div className="text-xs text-muted-foreground">{t("applicationProfile.languageTestUnsupported")}</div>
              </CardContent>
            </Card>
            {employmentItems.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("applicationProfile.materialsEmploymentReadonly")}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {employmentItems.map((item) => (
                    <div key={item.id} className="text-sm">{item.title}</div>
                  ))}
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{editingId ? t("applicationProfile.editMaterial") : t("applicationProfile.addMaterial")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  {EDITABLE_TYPES.map((type) => (
                    <Button key={type} size="sm" variant={materialType === type ? "default" : "outline"} onClick={() => setMaterialType(type)}>
                      {t(`applicationProfile.materialType${type}`)}
                    </Button>
                  ))}
                </div>
                <label className="text-sm font-medium">{t("applicationProfile.materialTitle")}</label>
                <Input value={materialForm.title} onChange={(e) => setMaterialForm((f) => ({ ...f, title: e.target.value }))} />
                {materialType === "EDUCATION" ? (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialInstitution")}</label><Input value={materialForm.institution} onChange={(e) => setMaterialForm((f) => ({ ...f, institution: e.target.value }))} /></div>
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialDegree")}</label><Input value={materialForm.degree} onChange={(e) => setMaterialForm((f) => ({ ...f, degree: e.target.value }))} /></div>
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialFieldOfStudy")}</label><Input value={materialForm.fieldOfStudy} onChange={(e) => setMaterialForm((f) => ({ ...f, fieldOfStudy: e.target.value }))} /></div>
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialGpa")}</label><Input value={materialForm.gpaValue} onChange={(e) => setMaterialForm((f) => ({ ...f, gpaValue: e.target.value }))} /></div>
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialGpaScale")}</label><Input value={materialForm.gpaScale} onChange={(e) => setMaterialForm((f) => ({ ...f, gpaScale: e.target.value }))} /></div>
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialRank")}</label><Input value={materialForm.rankText} onChange={(e) => setMaterialForm((f) => ({ ...f, rankText: e.target.value }))} /></div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialOrganization")}</label><Input value={materialForm.organization} onChange={(e) => setMaterialForm((f) => ({ ...f, organization: e.target.value }))} /></div>
                    <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialRole")}</label><Input value={materialForm.role} onChange={(e) => setMaterialForm((f) => ({ ...f, role: e.target.value }))} /></div>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialStartDate")}</label><Input type="date" value={materialForm.startDate} onChange={(e) => setMaterialForm((f) => ({ ...f, startDate: e.target.value }))} /></div>
                  <div className="flex flex-col gap-1"><label className="text-sm">{t("applicationProfile.materialEndDate")}</label><Input type="date" value={materialForm.endDate} onChange={(e) => setMaterialForm((f) => ({ ...f, endDate: e.target.value }))} /></div>
                  <div className="flex items-end gap-2"><label className="text-sm"><input type="checkbox" checked={materialForm.isCurrent} onChange={(e) => setMaterialForm((f) => ({ ...f, isCurrent: e.target.checked }))} /> {t("applicationProfile.materialIsCurrent")}</label></div>
                </div>
                <label className="text-sm font-medium">{t("applicationProfile.materialNotes")}</label>
                <Textarea value={materialForm.notes} onChange={(e) => setMaterialForm((f) => ({ ...f, notes: e.target.value }))} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={submitMaterial} disabled={savingMaterial}>{savingMaterial ? t("common.saving") : t("common.save")}</Button>
                  {editingId && <Button size="sm" variant="outline" onClick={() => { setEditingId(null); setMaterialForm({ title: "", organization: "", role: "", notes: "", startDate: "", endDate: "", isCurrent: false, institution: "", degree: "", fieldOfStudy: "", gpaValue: "", gpaScale: "", rankText: "" }); }}>{t("common.cancel")}</Button>}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="overview">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">{t("applicationProfile.tabsOverview")}</CardTitle>
              <Button size="sm" variant="outline" onClick={() => copyText(projection, t("common.copied"), t("applicationProfile.copyFailed"))}>{t("common.copy")}</Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div>
                <div className="font-medium">{t("applicationProfile.overviewBasics")}</div>
                <div className="whitespace-pre-wrap text-muted-foreground">{projection.split("\n\n")[0] ?? t("applicationProfile.emptySection")}</div>
              </div>
              <div>
                <div className="font-medium">{t("applicationProfile.overviewIntent")}</div>
                <div className="flex flex-col">
                  <ApplicationProfileField label={t("applicationProfile.intentTargetRoles")} value={preference?.targetRoles} />
                  <ApplicationProfileField label={t("applicationProfile.intentPreferredCities")} value={preference?.preferredCities} />
                  <ApplicationProfileField label={t("applicationProfile.intentPreferredIndustries")} value={preference?.preferredIndustries} />
                </div>
              </div>
              <div>
                <div className="font-medium">{t("applicationProfile.overviewEducation")}</div>
                <div className="whitespace-pre-wrap">{buildEducationSectionText(educationItems) || t("applicationProfile.emptySection")}</div>
                {educationItems.length > 0 && <Button size="sm" variant="outline" className="mt-1 w-fit" onClick={() => copyText(buildEducationSectionText(educationItems), t("common.copied"), t("applicationProfile.copyFailed"))}>{t("applicationProfile.copySection")}</Button>}
              </div>
              <div>
                <div className="font-medium">{t("applicationProfile.overviewExperience")}</div>
                <div className="whitespace-pre-wrap">{buildExperienceSectionText(experienceItems) || t("applicationProfile.emptySection")}</div>
                {experienceItems.length > 0 && <Button size="sm" variant="outline" className="mt-1 w-fit" onClick={() => copyText(buildExperienceSectionText(experienceItems), t("common.copied"), t("applicationProfile.copyFailed"))}>{t("applicationProfile.copySection")}</Button>}
              </div>
              <div>
                <div className="font-medium">{t("applicationProfile.overviewSkills")}</div>
                <div className="whitespace-pre-wrap">{buildSkillsSectionText(skillItems) || t("applicationProfile.emptySection")}</div>
              </div>
              <div className="text-xs text-muted-foreground">{t("applicationProfile.languageTestUnsupported")}</div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function useApplicationProjectionLoader() {
  return useCallback(async () => getApplicationProjection(), []);
}
