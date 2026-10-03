import { auth } from "@/auth";
import prisma from "@/lib/db";
import { notFound } from "next/navigation";
import { assertResumeV1Readable } from "@/lib/career/capabilities";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { ResumePreview } from "@/components/career/resume-variant/ResumePreview";
import { ResumePrintReady } from "@/components/career/resume-variant/ResumePrintReady";
import "./print.css";

export const dynamic = "force-dynamic";

export default async function ResumePrintPage({ params }: { params: Promise<{ versionId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) notFound();
  const { versionId } = await params;
  let version;
  try {
    await assertResumeV1Readable(prisma);
    version = await new ResumeVariantService(prisma, session.user.id).getVersion(versionId);
    if (version.status !== "FROZEN" && version.status !== "SUBMITTED") notFound();
  } catch { notFound(); }
  return (
    <main>
      <ResumePreview print headerSnapshot={version.headerSnapshot} sections={version.sections} />
      <ResumePrintReady versionId={version.id} />
    </main>
  );
}
