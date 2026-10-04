import { redirect } from "next/navigation";
import { getResumeList } from "@/actions/profile.actions";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { AutomationContainer } from "@/components/automations/AutomationContainer";
import { APP_CONSTANTS } from "@/lib/constants";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.automations") };
}

export default async function AutomationsPage() {
  const runtime = await getCareerRuntimeSnapshot();
  // ATS discovery is not part of the fresh-native beta: a pasted URL must
  // not reopen the legacy workflow.
  if (isFreshNativeFullSurface(runtime)) {
    redirect("/dashboard");
  }
  const resumeResult = await getResumeList(
    1,
    100,
    APP_CONSTANTS.MIN_RESUME_SECTIONS_FOR_SELECTION,
  );
  const resumes =
    resumeResult?.data?.map((r: { id: string; title: string }) => ({
      id: r.id,
      title: r.title,
    })) || [];

  return (
    <div className="col-span-3">
      <AutomationContainer resumes={resumes} />
    </div>
  );
}
