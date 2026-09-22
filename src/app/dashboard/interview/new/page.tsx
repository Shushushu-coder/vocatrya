import { getServerI18n } from "@/i18n/server";
import { getInterviewConfigAction, listInterviewPresetsAction } from "@/actions/interview.actions";
import { redirect } from "next/navigation";
import NewInterviewForm from "@/components/interview/NewInterviewForm";

export default async function NewInterviewPage() {
  const config = await getInterviewConfigAction();
  if (!config.success || !("data" in config) || !config.data.configured) {
    redirect("/dashboard/interview");
  }
  const { t } = await getServerI18n();
  const listed = await listInterviewPresetsAction();
  const data =
    listed.success && "data" in listed
      ? listed.data
      : { presets: [], questions: [], jobs: [] };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("interview.newSession")}</h1>
      <NewInterviewForm
        presets={data.presets}
        questions={data.questions}
        jobs={data.jobs}
      />
    </div>
  );
}
