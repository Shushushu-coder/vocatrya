import ProfileContainer from "@/components/profile/ProfileContainer";
import React from "react";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import {
  isLegacyResumeEditorReadOnly,
  isResumeV1CapabilityEnabled,
} from "@/lib/career/capabilities";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.profile") };
}

async function Profile() {
  const runtime = await getCareerRuntimeSnapshot();
  const { t } = await getServerI18n();
  const resumeReadOnly = isLegacyResumeEditorReadOnly(
    runtime.mode,
    runtime.rolloutScope,
  );
  const showApplicationEntry = isResumeV1CapabilityEnabled(
    runtime.mode,
    runtime.rolloutScope,
  );
  // A fresh instance has no legacy Resume/CoverLetter rows to list, so the
  // legacy document card is dead surface — the canonical workspace above
  // replace it. Fresh + full is the first mode where that card would
  // otherwise render (read-only), so it is suppressed explicitly here.
  const hideLegacyProfile =
    runtime.origin === "fresh" &&
    (!showApplicationEntry || isFreshNativeFullSurface(runtime));
  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      {showApplicationEntry && (
        <div className="mb-4">
          <div className="mb-4">
            <h1 className="text-xl font-semibold">{t("applicationProfile.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("applicationProfile.subtitle")}</p>
          </div>
          <ApplicationProfileWorkspace />
        </div>
      )}
      {hideLegacyProfile ? null : (
        <ProfileContainer resumeReadOnly={resumeReadOnly} />
      )}
    </div>
  );
}

export default Profile;
