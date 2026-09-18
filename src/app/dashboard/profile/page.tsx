import ProfileContainer from "@/components/profile/ProfileContainer";
import React from "react";
import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { canReadCareerData } from "@/lib/career/access";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.profile") };
}

async function Profile() {
  const runtime = await getCareerRuntimeSnapshot();
  const { t } = await getServerI18n();
  const resumeReadOnly = runtime.mode !== CAREER_RUNTIME_MODE.LEGACY_ONLY;
  const showApplicationEntry = canReadCareerData(runtime.mode);
  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      {showApplicationEntry && (
        <div className="mb-4 rounded-lg border p-4">
          <div className="text-sm font-medium">{t("applicationProfile.entryTitle")}</div>
          <div className="text-sm text-muted-foreground">{t("applicationProfile.entryDescription")}</div>
          <Link className="text-sm text-primary underline underline-offset-2" href="/dashboard/profile/application">
            {t("applicationProfile.openApplicationProfile")}
          </Link>
        </div>
      )}
      <ProfileContainer resumeReadOnly={resumeReadOnly} />
    </div>
  );
}

export default Profile;
