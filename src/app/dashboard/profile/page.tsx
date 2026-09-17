import ProfileContainer from "@/components/profile/ProfileContainer";
import React from "react";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.profile") };
}

async function Profile() {
  const runtime = await getCareerRuntimeSnapshot();
  const resumeReadOnly = runtime.mode !== CAREER_RUNTIME_MODE.LEGACY_ONLY;
  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      <ProfileContainer resumeReadOnly={resumeReadOnly} />
    </div>
  );
}

export default Profile;
