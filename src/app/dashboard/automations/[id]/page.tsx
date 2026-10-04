import { redirect } from "next/navigation";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { AutomationDetailContainer } from "@/components/automations/AutomationDetailContainer";

async function AutomationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runtime = await getCareerRuntimeSnapshot();
  if (isFreshNativeFullSurface(runtime)) {
    redirect("/dashboard");
  }

  return (
    <div className="col-span-3">
      <AutomationDetailContainer automationId={id} />
    </div>
  );
}

export default AutomationDetailPage;
