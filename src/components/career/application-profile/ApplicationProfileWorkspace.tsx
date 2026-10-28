"use client";
import { ProfileCopyButton } from "./ProfileCopyButton";
import { useCallback, useEffect, useMemo, useState } from "react";
import { INPUT_PREF_REGION_ATTR } from "@/lib/inputPreferences";
import Link from "next/link";
import {
  assertEmail,
  assertPhone,
  assertGender,
  assertPoliticalStatus,
  assertBirthDate,
  assertPhoneCountryCode,
} from "@/lib/career/candidateProfileValidation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  buildApplicationProjectionSections,
  buildEducationSectionText,
  buildExperienceSectionText,
  buildPersonalInfoText,
  buildSkillsSectionText,
} from "@/lib/career/applicationCopy";
import {
  getApplicationCandidateProfile,
  getApplicationProjection,
  listApplicationMaterials,
  updateApplicationCandidateProfile,
} from "@/actions/applicationProfile.actions";
import {
  getCareerProfileTabVisibility,
  setCareerProfileTabVisible,
} from "@/actions/careerProfileTabs.actions";
import { ApplicationProfileField } from "./ApplicationProfileField";
import { AttachmentCard } from "./AttachmentCard";
import { EmergencyContactCard } from "./EmergencyContactCard";
import { IdDocumentCard } from "./IdDocumentCard";
import { RefereeCard } from "./RefereeCard";
import { deriveEducationSummary } from "@/lib/career/educationDerivation";
import {
  MaterialRecordsSection,
  type MaterialItem,
} from "./MaterialRecordsSection";
import { CareerProfileTabManager } from "./CareerProfileTabManager";
import {
  CAREER_PROFILE_TAB_IDS,
  CAREER_PROFILE_RECORD_TAB_IDS,
  CAREER_PROFILE_TAB_CREATABLE_TYPES,
  CAREER_PROFILE_TAB_READONLY_TYPES,
  itemsForRecordTab,
  normalizeTabVisibility,
  visibleCareerProfileTabs,
  type CareerProfileTabId,
  type CareerProfileTabVisibility,
} from "./careerProfileTabs";

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
  phoneCountryCode?: string | null;
  wechatId?: string | null;
  qqNumber?: string | null;
  countryOrRegion?: string | null;
  currentCity?: string | null;
  homeCity?: string | null;
  homeAddress?: string | null;
  linksData?: string | null;
};

const EXPERIENCE_TYPES = new Set([
  "INTERNSHIP",
  "PROJECT",
  "CAMPUS_ACTIVITY",
  "RESEARCH",
  "COMPETITION",
  "AWARD",
  "PUBLICATION",
]);
const SKILL_TYPES = new Set(["SKILL", "CERTIFICATION"]);

async function copyText(
  text: string,
  copiedLabel: string,
  failedLabel: string,
) {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    await navigator.clipboard.writeText(trimmed);
    toastSuccess(copiedLabel);
  } catch {
    toastError(failedLabel);
  }
}

const PROFILE_VALIDATORS: Record<string, (value: string) => unknown> = {
  email: assertEmail,
  phone: assertPhone,
  gender: assertGender,
  politicalStatus: assertPoliticalStatus,
  birthDate: assertBirthDate,
  phoneCountryCode: assertPhoneCountryCode,
};

function validProfileField(key: string, value: string) {
  try {
    PROFILE_VALIDATORS[key]?.(value);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_VISIBILITY = normalizeTabVisibility(undefined);

// CP-EDIT: the personal-info rows in display order; each row writes exactly
// its own key through `saveProfileField`, never a whole-profile form.
const PROFILE_FIELD_KEYS = [
  "fullName",
  "email",
  "phone",
  "address",
  "gender",
  "birthDate",
  "ethnicity",
  "politicalStatus",
  "nativePlace",
  "householdRegistration",
  "countryOrRegion",
  "currentCity",
  "homeCity",
  "homeAddress",
  "phoneCountryCode",
  "wechatId",
  "qqNumber",
  "linksData",
] as const;

type ProfileFieldKey = (typeof PROFILE_FIELD_KEYS)[number];

// CP-COPY: on-demand 网申汇总 selection. `preference` never reaches the UI
// (the workspace always passes null), so only these four rendered sections
// are selectable.
const PROJECTION_UI_SECTION_IDS = [
  "basics",
  "education",
  "experience",
  "skills",
] as const;
type ProjectionUiSectionId = (typeof PROJECTION_UI_SECTION_IDS)[number];
const ALL_SECTIONS_SELECTED: Record<ProjectionUiSectionId, boolean> = {
  basics: true,
  education: true,
  experience: true,
  skills: true,
};

export function ApplicationProfileWorkspace() {
  const { t } = useI18n();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [tabVisibility, setTabVisibility] =
    useState<CareerProfileTabVisibility>(DEFAULT_VISIBILITY);
  const [activeTab, setActiveTab] = useState<CareerProfileTabId>("personal");
  const [sectionSelection, setSectionSelection] = useState<
    Record<ProjectionUiSectionId, boolean>
  >(ALL_SECTIONS_SELECTED);

  const load = useCallback(async () => {
    const [p, mats, visibility] = await Promise.all([
      getApplicationCandidateProfile(),
      listApplicationMaterials(),
      getCareerProfileTabVisibility(),
    ]);
    if (p.success) setProfile((p.data as Profile | null) ?? null);
    else toastError(t("applicationProfile.loadFailed"));
    if (mats.success)
      setMaterials(
        ((mats.data as MaterialItem[] | null) ?? []) as MaterialItem[],
      );
    if (visibility.success && visibility.data) {
      setTabVisibility(normalizeTabVisibility(visibility.data));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Clamp the active tab when a hidden-tab preference arrives (or changes):
  // a tab that is not visible can never stay selected.
  useEffect(() => {
    if (tabVisibility[activeTab]) return;
    const firstVisible = visibleCareerProfileTabs(tabVisibility)[0];
    if (firstVisible) setActiveTab(firstVisible);
  }, [tabVisibility, activeTab]);

  async function toggleTab(tabId: CareerProfileTabId, visible: boolean) {
    const res = await setCareerProfileTabVisible({ tabId, visible });
    if (!res.success || !res.data) {
      toastError(t("careerProfileTabs.visibilitySaveFailed"), undefined, {
        sticky: true,
      });
      return;
    }
    setTabVisibility(normalizeTabVisibility(res.data));
  }

  const educationItems = useMemo(
    () => materials.filter((m) => m.type === "EDUCATION"),
    [materials],
  );
  const experienceItems = useMemo(
    () => materials.filter((m) => EXPERIENCE_TYPES.has(m.type)),
    [materials],
  );
  const skillItems = useMemo(
    () => materials.filter((m) => SKILL_TYPES.has(m.type)),
    [materials],
  );

  // Read-time derivation (§4): highest education/degree come only from
  // explicitly obtained facts; the manual cohort field stays editable only
  // as a fallback when nothing can be derived.
  const derived = useMemo(
    () =>
      deriveEducationSummary(
        educationItems as never,
        profile?.graduationCohort,
      ),
    [educationItems, profile?.graduationCohort],
  );

  const isProfileEmpty =
    !profile || !Object.values(profile).some((v) => v?.trim());

  // A single-field commit sends only that key: the action treats omitted
  // fields as "unchanged", so concurrent row saves can never overwrite each
  // other. Merging only the saved key keeps this row correct even if a
  // slower sibling save resolves afterwards.
  async function saveProfileField(
    key: ProfileFieldKey | "graduationCohort",
    value: string | null,
  ): Promise<boolean> {
    const res = await updateApplicationCandidateProfile({ [key]: value });
    if (!res.success) return false;
    const saved = ((res.data as Profile | null | undefined) ?? null)?.[key] ?? null;
    setProfile((p) => ({ ...(p ?? {}), [key]: saved }));
    return true;
  }

  const profileForCopy = useMemo(
    () => ({
      ...(profile ?? {}),
      graduationCohort: derived.graduationCohort ?? profile?.graduationCohort ?? null,
      highestEducation: derived.highestEducation,
      schoolCity: derived.schoolCity,
    }),
    [profile, derived],
  );

  const projectionSections = useMemo(() => {
    return buildApplicationProjectionSections({
      profile: profileForCopy,
      // Global job intent is no longer part of the workspace; historical
      // JobSearchPreference rows stay in the database untouched.
      preference: null,
      education: educationItems,
      experience: experienceItems,
      skills: skillItems,
    });
  }, [profileForCopy, educationItems, experienceItems, skillItems]);

  const sectionText = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of projectionSections) map.set(s.id, s.text);
    return map;
  }, [projectionSections]);

  const availableSectionIds = PROJECTION_UI_SECTION_IDS.filter((id) =>
    sectionText.has(id),
  );
  const allSectionsSelected = availableSectionIds.every(
    (id) => sectionSelection[id],
  );
  const selectedProjectionText = projectionSections
    .filter((s) => sectionSelection[s.id as ProjectionUiSectionId])
    .map((s) => s.text)
    .join("\n\n");

  function toggleProjectionSection(id: ProjectionUiSectionId) {
    setSectionSelection((s) => ({ ...s, [id]: !s[id] }));
  }

  function toggleAllProjectionSections() {
    const next = !allSectionsSelected;
    setSectionSelection((s) => {
      const copy = { ...s };
      for (const id of availableSectionIds) copy[id] = next;
      return copy;
    });
  }

  const visibleTabs = visibleCareerProfileTabs(tabVisibility);

  return (
    <div className="flex flex-col gap-4">
      <div
        className="rounded-md border p-3 text-xs text-muted-foreground"
        data-testid="legacy-independent-notice"
      >
        {t("applicationProfile.legacyIndependentNotice")}
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (tabVisibility[value as CareerProfileTabId]) {
            setActiveTab(value as CareerProfileTabId);
          }
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <TabsList className="h-auto flex-wrap">
            {visibleTabs.map((tabId) => (
              <TabsTrigger
                key={tabId}
                value={tabId}
                data-testid={`career-profile-tab-${tabId}`}
              >
                {t(`careerProfileTabs.${tabId}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <CareerProfileTabManager
            visibility={tabVisibility}
            onToggle={toggleTab}
          />
        </div>

        <TabsContent value="personal" forceMount hidden={activeTab !== "personal"}>
          <Card {...{ [INPUT_PREF_REGION_ATTR]: true }}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">
                {t("careerProfileTabs.personal")}
              </CardTitle>
              {!isProfileEmpty && (
                <ProfileCopyButton
                  label={t("applicationProfile.copyGroup")}
                  variant="outline"
                  data-testid="personal-copy-group"
                  onClick={() =>
                    copyText(
                      buildPersonalInfoText(profileForCopy),
                      t("common.copied"),
                      t("applicationProfile.copyFailed"),
                    )
                  }
                />
              )}
            </CardHeader>
            <CardContent>
              <div className="flex flex-col divide-y">
                {PROFILE_FIELD_KEYS.map((key) => (
                  <ApplicationProfileField
                    key={key}
                    testId={`profile-field-${key}`}
                    label={t(
                      `applicationProfile.field${key.charAt(0).toUpperCase()}${key.slice(1)}`,
                    )}
                    value={profile?.[key]}
                    validate={(value) => validProfileField(key, value)}
                    onSave={(v) => saveProfileField(key, v)}
                  />
                ))}
                {/* Derived education summary (§4): read-only, assembled at
                    read time from explicit obtained facts only. */}
                <div className="flex flex-col gap-1 py-2" data-testid="derived-education">
                  <div className="text-sm font-medium">
                    {t("applicationProfile.derivedEducationTitle")}
                  </div>
                  <div className="text-sm">
                    {t("applicationProfile.fieldHighestEducation")}：
                    {derived.highestEducation ?? t("applicationProfile.derivedUnknown")}
                  </div>
                  <div className="text-sm">
                    {t("applicationProfile.fieldSchoolCity")}：
                    {derived.schoolCity ?? t("applicationProfile.derivedUnknown")}
                  </div>
                  <div className="text-sm">
                    {t("applicationProfile.fieldGraduationCohort")}：
                    {derived.graduationCohort ?? t("applicationProfile.derivedUnknown")}
                  </div>
                  {derived.inProgressDegree && (
                    <div className="text-xs text-muted-foreground">
                      {t("applicationProfile.derivedInProgress")}：
                      {derived.inProgressDegree}
                    </div>
                  )}
                </div>
                {/* graduationCohort stays editable only as the manual
                    fallback while no explicit obtained facts can derive it. */}
                {derived.cohortSource !== "derived" && (
                  <ApplicationProfileField
                    testId="profile-field-graduationCohort"
                    label={t("applicationProfile.fieldGraduationCohort")}
                    value={profile?.graduationCohort}
                    onSave={(v) => saveProfileField("graduationCohort", v)}
                  />
                )}
                {isProfileEmpty && (
                  <div className="flex flex-col gap-2 py-3 text-sm text-muted-foreground">
                    <span>{t("applicationProfile.legacyNoSyncHint")}</span>
                    <Link
                      className="text-primary underline"
                      href="/dashboard/profile"
                    >
                      {t("applicationProfile.viewExistingResume")}
                    </Link>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          <div className="mt-4 flex flex-col gap-4">
            <IdDocumentCard />
            <EmergencyContactCard />
            <AttachmentCard
              category="ID_PHOTO"
              titleKey="applicationProfile.idPhotoTitle"
            />
          </div>
        </TabsContent>

        {/* Record panels stay mounted like `personal`: MaterialRecordsSection
            owns per-tab edit drafts, in-flight saves and failure-retry state,
            so a tab switch must hide the panel instead of unmounting it. */}
        {CAREER_PROFILE_RECORD_TAB_IDS.map((tabId) => (
          <TabsContent
            key={tabId}
            value={tabId}
            forceMount
            hidden={activeTab !== tabId}
            data-testid={`record-panel-${tabId}`}
          >
            <div className="flex flex-col gap-4">
              <ProfileCopyButton
                label={t("applicationProfile.copyTab")}
                variant="outline"
                className="self-end"
                data-testid={`copy-tab-${tabId}`}
                onClick={() =>
                  copyText(
                    buildExperienceSectionText([
                      ...itemsForRecordTab(materials, tabId),
                      ...(CAREER_PROFILE_TAB_READONLY_TYPES[tabId] ?? [])
                        .flatMap((type) => materials.filter((m) => m.type === type)),
                    ]),
                    t("common.copied"),
                    t("applicationProfile.copyFailed"),
                  )
                }
              />
              <MaterialRecordsSection
                title={t(`careerProfileTabs.${tabId}`)}
                items={itemsForRecordTab(materials, tabId)}
                creatableTypes={CAREER_PROFILE_TAB_CREATABLE_TYPES[tabId]}
                readonlyItems={(CAREER_PROFILE_TAB_READONLY_TYPES[tabId] ?? [])
                  .flatMap((type) => materials.filter((m) => m.type === type))}
                readonlyTitle={
                  CAREER_PROFILE_TAB_READONLY_TYPES[tabId]
                    ? t("applicationProfile.materialsEmploymentReadonly")
                    : undefined
                }
                onChanged={load}
              />
              {tabId === "other" && <RefereeCard />}
            </div>
          </TabsContent>
        ))}

        <TabsContent value="application">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">
                {t("careerProfileTabs.application")}
              </CardTitle>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="projection-select-toggle"
                  disabled={availableSectionIds.length === 0}
                  onClick={toggleAllProjectionSections}
                >
                  {allSectionsSelected
                    ? t("applicationProfile.copySelectNone")
                    : t("applicationProfile.copySelectAll")}
                </Button>
                <ProfileCopyButton
                  label={t("applicationProfile.copySelected")}
                  variant="outline"
                  data-testid="projection-copy-selected"
                  disabled={!selectedProjectionText}
                  onClick={() =>
                    copyText(
                      selectedProjectionText,
                      t("common.copied"),
                      t("applicationProfile.copyFailed"),
                    )
                  }
                />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div>
                <label className="flex items-center gap-1 font-medium">
                  <input
                    type="checkbox"
                    data-testid="projection-select-basics"
                    disabled={!sectionText.has("basics")}
                    checked={
                      sectionText.has("basics") && sectionSelection.basics
                    }
                    onChange={() => toggleProjectionSection("basics")}
                  />
                  {t("applicationProfile.overviewBasics")}
                </label>
                <div className="whitespace-pre-wrap text-muted-foreground">
                  {sectionText.get("basics") ??
                    t("applicationProfile.emptySection")}
                </div>
                {sectionText.has("basics") && (
                  <ProfileCopyButton
                    label={t("applicationProfile.copySection")}
                    variant="outline"
                    className="mt-1"
                    onClick={() =>
                      copyText(
                        sectionText.get("basics") ?? "",
                        t("common.copied"),
                        t("applicationProfile.copyFailed"),
                      )
                    }
                  />
                )}
              </div>
              <div>
                <label className="flex items-center gap-1 font-medium">
                  <input
                    type="checkbox"
                    data-testid="projection-select-education"
                    disabled={!sectionText.has("education")}
                    checked={
                      sectionText.has("education") && sectionSelection.education
                    }
                    onChange={() => toggleProjectionSection("education")}
                  />
                  {t("applicationProfile.overviewEducation")}
                </label>
                <div className="whitespace-pre-wrap">
                  {buildEducationSectionText(educationItems) ||
                    t("applicationProfile.emptySection")}
                </div>
                {educationItems.length > 0 && (
                  <ProfileCopyButton
                    label={t("applicationProfile.copySection")}
                    variant="outline"
                    className="mt-1"
                    onClick={() =>
                      copyText(
                        buildEducationSectionText(educationItems),
                        t("common.copied"),
                        t("applicationProfile.copyFailed"),
                      )
                    }
                  />
                )}
              </div>
              <div>
                <label className="flex items-center gap-1 font-medium">
                  <input
                    type="checkbox"
                    data-testid="projection-select-experience"
                    disabled={!sectionText.has("experience")}
                    checked={
                      sectionText.has("experience") &&
                      sectionSelection.experience
                    }
                    onChange={() => toggleProjectionSection("experience")}
                  />
                  {t("applicationProfile.overviewExperience")}
                </label>
                <div className="whitespace-pre-wrap">
                  {buildExperienceSectionText(experienceItems) ||
                    t("applicationProfile.emptySection")}
                </div>
                {experienceItems.length > 0 && (
                  <ProfileCopyButton
                    label={t("applicationProfile.copySection")}
                    variant="outline"
                    className="mt-1"
                    onClick={() =>
                      copyText(
                        buildExperienceSectionText(experienceItems),
                        t("common.copied"),
                        t("applicationProfile.copyFailed"),
                      )
                    }
                  />
                )}
              </div>
              <div>
                <label className="flex items-center gap-1 font-medium">
                  <input
                    type="checkbox"
                    data-testid="projection-select-skills"
                    disabled={!sectionText.has("skills")}
                    checked={
                      sectionText.has("skills") && sectionSelection.skills
                    }
                    onChange={() => toggleProjectionSection("skills")}
                  />
                  {t("applicationProfile.overviewSkills")}
                </label>
                <div className="whitespace-pre-wrap">
                  {buildSkillsSectionText(skillItems) ||
                    t("applicationProfile.emptySection")}
                </div>
                {skillItems.length > 0 && (
                  <ProfileCopyButton
                    label={t("applicationProfile.copySection")}
                    variant="outline"
                    className="mt-1"
                    onClick={() =>
                      copyText(
                        buildSkillsSectionText(skillItems),
                        t("common.copied"),
                        t("applicationProfile.copyFailed"),
                      )
                    }
                  />
                )}
              </div>
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
