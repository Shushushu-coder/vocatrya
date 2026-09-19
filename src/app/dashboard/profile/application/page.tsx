import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { ApplicationProfileWorkspace } from "@/components/career/application-profile/ApplicationProfileWorkspace";
import { isResumeV1CapabilityEnabled } from "@/lib/career/capabilities";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("applicationProfile.title") };
}

export default async function ApplicationProfilePage() {
  const runtime = await getCareerRuntimeSnapshot();
  const { t } = await getServerI18n();
  // Non-AB modes: never fetch B-side personal data. Render only the runtime
  // notice so no CandidateProfile / Material / Preference / Sensitive bytes
  // reach the HTML / RSC payload.
  if (!isResumeV1CapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
    return (
      <div className="col-span-3">
        <CareerRuntimeNotice mode={runtime.mode} />
        <div className="mt-2 text-sm text-muted-foreground">
          <Link className="text-primary underline" href="/dashboard/profile">
            {t("common.back")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{t("applicationProfile.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("applicationProfile.subtitle")}</p>
      </div>
      <ApplicationProfileWorkspace />
    </div>
  );
}
