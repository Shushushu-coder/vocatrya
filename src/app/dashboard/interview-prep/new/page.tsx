import { notFound, redirect } from "next/navigation";
import { continueInterviewPrepGoal } from "@/actions/interviewPrep.actions";
import NewInterviewPage from "@/app/dashboard/interview/new/page";

// Goal-bound practice uses the local session store. An external practice
// service cannot resume these sessions; the generic interview entry stays retired.
export default async function NewPrepInterviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { prepGoal } = await searchParams;
  if (typeof prepGoal !== "string" || !prepGoal.trim()) notFound();
  const result = await continueInterviewPrepGoal({ goalId: prepGoal });
  if (!result.success || !result.data) notFound();
  const goal = result.data.goal;
  if (goal.nextAction.kind === "OPEN_SESSION" || goal.nextAction.kind === "VIEW_SUMMARY") {
    redirect(`/dashboard/interview-prep/${goal.nextAction.sessionId}`);
  }
  if (goal.nextAction.kind !== "START_PRACTICE") notFound();
  return NewInterviewPage({
    searchParams: Promise.resolve({
      job: goal.jobOpportunityId,
      jd: goal.pinnedJd.versionId,
      prepGoal: goal.id,
    }),
  });
}
