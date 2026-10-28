import ProfileContainer from "@/components/profile/ProfileContainer";
import React from "react";
import Link from "next/link";
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
  // legacy document card is dead surface — the canonical entries above
  // replace it. Fresh + full is the first mode where that card would
  // otherwise render (read-only), so it is suppressed explicitly here.
  const hideLegacyProfile =
    runtime.origin === "fresh" &&
    (!showApplicationEntry || isFreshNativeFullSurface(runtime));
  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      {showApplicationEntry && (
        <div className="mb-4 space-y-3">
          <div className="rounded-lg border p-4">
            <div className="text-sm font-medium">{t("applicationProfile.entryTitle")}</div>
            <div className="text-sm text-muted-foreground">{t("applicationProfile.entryDescription")}</div>
            <Link className="text-sm text-primary underline underline-offset-2" href="/dashboard/profile/application">
              {t("applicationProfile.openApplicationProfile")}
            </Link>
          </div>
        </div>
      )}
      {hideLegacyProfile ? null : (
        <ProfileContainer resumeReadOnly={resumeReadOnly} />
      )}
    </div>
  );
}

export default Profile;
