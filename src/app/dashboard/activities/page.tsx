import ActivitiesContainer from "@/components/activities/ActivitiesContainer";
import React from "react";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.activities") };
}

function Activities() {
  return (
    <div className="col-span-3">
      <ActivitiesContainer />
    </div>
  );
}

export default Activities;
