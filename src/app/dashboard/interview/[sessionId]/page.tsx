import { getInterviewSessionAction } from "@/actions/interview.actions";
import { redirect, notFound } from "next/navigation";
import InterviewSessionClient from "@/components/interview/InterviewSessionClient";

export default async function InterviewSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  // Load the session's own data first — the global AI gate must never
  // hide existing transcripts/feedback/history. AI operations surface
  // errors at the point of use via the session's persisted lock.
  const result = await getInterviewSessionAction(sessionId);
  if (!result.success) {
    if ("code" in result && result.code === "SESSION_NOT_FOUND") notFound();
    if ("code" in result && result.code === "SESSION_FORBIDDEN") notFound();
    redirect("/dashboard/interview");
  }
  if (!("data" in result)) redirect("/dashboard/interview");
  return (
    <InterviewSessionClient sessionId={sessionId} initial={result.data} />
  );
}
