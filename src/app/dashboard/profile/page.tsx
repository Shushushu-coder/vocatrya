import ProfileContainer from "@/components/profile/ProfileContainer";
import React from "react";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.profile") };
}

function Profile() {
  return (
    <div className="col-span-3">
      <ProfileContainer />
    </div>
  );
}

export default Profile;
