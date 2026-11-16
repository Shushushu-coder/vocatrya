import { notFound } from "next/navigation";
import { requireUser } from "@/actions/shared";
import prisma from "@/lib/db";
import { assertPrepSurfaceEnabled } from "@/lib/interviewPrep/surfaceGate";
import InterviewSessionPage from "@/app/dashboard/interview/[sessionId]/page";

export default async function PrepInterviewSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const user = await requireUser();
  await assertPrepSurfaceEnabled(prisma);
  const { sessionId } = await params;
  const session = await prisma.interviewSession.findFirst({
    where: { id: sessionId, userId: user.id, interviewPrepGoalId: { not: null } },
    select: { id: true },
  });
  if (!session) notFound();
  return InterviewSessionPage({ params: Promise.resolve({ sessionId: session.id }) });
}
