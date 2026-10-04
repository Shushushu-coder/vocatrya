import { redirect } from "next/navigation";
import {
  getDefaultResumeId,
  getResumeById,
} from "@/actions/profile.actions";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import ResumeContainer from "@/components/profile/ResumeContainer";

async function ResumePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = await getCareerRuntimeSnapshot();
  // The legacy resume editor (and its import flow) never writes canonical
  // data: fresh-native users land on the variant list instead.
  if (isFreshNativeFullSurface(runtime)) {
    redirect("/dashboard/profile/resumes");
  }
  const [{ data: resume }, defaultResumeId] = await Promise.all([
    getResumeById(id),
    getDefaultResumeId(),
  ]);
  return (
    <div className="col-span-3">
      <ResumeContainer resume={resume} defaultResumeId={defaultResumeId} />
    </div>
  );
}

export default ResumePage;
