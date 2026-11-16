import { getServerI18n } from "@/i18n/server";
import {
  getInterviewReadinessAction,
  listInterviewJobsAction,
} from "@/actions/interview.actions";
import { redirect } from "next/navigation";
import NewInterviewForm from "@/components/interview/NewInterviewForm";

export default async function NewInterviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Gate on the effective INTERVIEW resolver — the same semantics session
  // creation uses — never the legacy-only settings check.
  const readiness = await getInterviewReadinessAction();
  const ready =
    readiness.success && "data" in readiness && readiness.data.status === "ready";
  if (!ready) {
    redirect("/dashboard/interview");
  }
  const params = await searchParams;
  const pick = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const { t } = await getServerI18n();
  const listed = await listInterviewJobsAction();
  const jobs = listed.success && "data" in listed ? listed.data : [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("interview.newSession")}</h1>
      <NewInterviewForm
        jobs={jobs}
        initialJobId={pick("job")}
        initialJdId={pick("jd")}
        interviewPrepGoalId={pick("prepGoal")}
      />
    </div>
  );
}
