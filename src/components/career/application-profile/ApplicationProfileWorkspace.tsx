"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  buildApplicationProjectionText,
  buildEducationSectionText,
  buildExperienceSectionText,
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
import { EmergencyContactCard } from "./EmergencyContactCard";
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
  "graduationCohort",
] as const;

type ProfileFieldKey = (typeof PROFILE_FIELD_KEYS)[number];

export function ApplicationProfileWorkspace() {
  const { t } = useI18n();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [tabVisibility, setTabVisibility] =
    useState<CareerProfileTabVisibility>(DEFAULT_VISIBILITY);
  const [activeTab, setActiveTab] = useState<CareerProfileTabId>("personal");

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

  const isProfileEmpty =
    !profile || !Object.values(profile).some((v) => v?.trim());

  // A single-field commit sends only that key: the action treats omitted
  // fields as "unchanged", so concurrent row saves can never overwrite each
  // other. Merging only the saved key keeps this row correct even if a
  // slower sibling save resolves afterwards.
  async function saveProfileField(
    key: ProfileFieldKey,
    value: string | null,
  ): Promise<boolean> {
    const res = await updateApplicationCandidateProfile({ [key]: value });
    if (!res.success) return false;
    const saved = ((res.data as Profile | null | undefined) ?? null)?.[key] ?? null;
    setProfile((p) => ({ ...(p ?? {}), [key]: saved }));
    return true;
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
      // Global job intent is no longer part of the workspace; historical
      // JobSearchPreference rows stay in the database untouched.
      preference: null,
      education: educationItems,
      experience: experienceItems,
      skills: skillItems,
    });
  }, [profile, educationItems, experienceItems, skillItems]);

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
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("careerProfileTabs.personal")}
              </CardTitle>
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
                    onSave={(v) => saveProfileField(key, v)}
                  />
                ))}
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
          <div className="mt-4">
            <EmergencyContactCard />
          </div>
        </TabsContent>

        {CAREER_PROFILE_RECORD_TAB_IDS.map((tabId) => (
          <TabsContent key={tabId} value={tabId}>
            <div className="flex flex-col gap-4">
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
              {tabId === "education" && (
                <div className="text-xs text-muted-foreground">
                  {t("applicationProfile.languageTestUnsupported")}
                </div>
              )}
            </div>
          </TabsContent>
        ))}

        <TabsContent value="application">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">
                {t("careerProfileTabs.application")}
              </CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  copyText(
                    projection,
                    t("common.copied"),
                    t("applicationProfile.copyFailed"),
                  )
                }
              >
                {t("common.copy")}
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div>
                <div className="font-medium">
                  {t("applicationProfile.overviewBasics")}
                </div>
                <div className="whitespace-pre-wrap text-muted-foreground">
                  {projection.split("\n\n")[0] ??
                    t("applicationProfile.emptySection")}
                </div>
              </div>
              <div>
                <div className="font-medium">
                  {t("applicationProfile.overviewEducation")}
                </div>
                <div className="whitespace-pre-wrap">
                  {buildEducationSectionText(educationItems) ||
                    t("applicationProfile.emptySection")}
                </div>
                {educationItems.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 w-fit"
                    onClick={() =>
                      copyText(
                        buildEducationSectionText(educationItems),
                        t("common.copied"),
                        t("applicationProfile.copyFailed"),
                      )
                    }
                  >
                    {t("applicationProfile.copySection")}
                  </Button>
                )}
              </div>
              <div>
                <div className="font-medium">
                  {t("applicationProfile.overviewExperience")}
                </div>
                <div className="whitespace-pre-wrap">
                  {buildExperienceSectionText(experienceItems) ||
                    t("applicationProfile.emptySection")}
                </div>
                {experienceItems.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 w-fit"
                    onClick={() =>
                      copyText(
                        buildExperienceSectionText(experienceItems),
                        t("common.copied"),
                        t("applicationProfile.copyFailed"),
                      )
                    }
                  >
                    {t("applicationProfile.copySection")}
                  </Button>
                )}
              </div>
              <div>
                <div className="font-medium">
                  {t("applicationProfile.overviewSkills")}
                </div>
                <div className="whitespace-pre-wrap">
                  {buildSkillsSectionText(skillItems) ||
                    t("applicationProfile.emptySection")}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {t("applicationProfile.languageTestUnsupported")}
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
