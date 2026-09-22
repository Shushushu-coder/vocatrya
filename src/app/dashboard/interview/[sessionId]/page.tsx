import { getInterviewConfigAction, getInterviewSessionAction } from "@/actions/interview.actions";
import { redirect, notFound } from "next/navigation";
import InterviewSessionClient from "@/components/interview/InterviewSessionClient";

export default async function InterviewSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const config = await getInterviewConfigAction();
  const result = await getInterviewSessionAction(sessionId);
  if (!result.success) {
    if ("code" in result && result.code === "SESSION_NOT_FOUND") notFound();
    if ("code" in result && result.code === "SESSION_FORBIDDEN") notFound();
    redirect("/dashboard/interview");
  }
  if (!("data" in result)) redirect("/dashboard/interview");
  const configured = config.success && "data" in config ? config.data.configured : false;
  return (
    <InterviewSessionClient
      sessionId={sessionId}
      initial={result.data}
      configured={configured}
    />
  );
}
