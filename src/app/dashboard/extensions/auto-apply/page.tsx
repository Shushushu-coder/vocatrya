import Link from "next/link";
import { getServerLocale } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { isResumeV1CapabilityEnabled } from "@/lib/career/capabilities";
import { getCurrentUser } from "@/utils/user.utils";
import prisma from "@/lib/db";
import { getAutoApplyExtensionStatus } from "@/lib/extensions/autoApply/status";
import { listConnections } from "@/lib/extensions/autoApply/connect";
import { AutoApplyExportPanel } from "@/components/extensions/auto-apply/AutoApplyExportPanel";
import { AutoApplyConnectPanel } from "@/components/extensions/auto-apply/AutoApplyConnectPanel";
import { getAutoApplyCopy } from "@/components/extensions/auto-apply/autoApplyCopy";

export async function generateMetadata() {
  const locale = await getServerLocale();
  return { title: getAutoApplyCopy(locale).title };
}

export default async function AutoApplyDetailPage() {
  const runtime = await getCareerRuntimeSnapshot();
  const locale = await getServerLocale();
  const copy = getAutoApplyCopy(locale);

  const backLink = (
    <Link className="text-sm text-primary underline" href="/dashboard/extensions">
      {copy.backToTools}
    </Link>
  );

  const unavailable = (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">{copy.readUnavailable}</p>
      </div>
      {backLink}
    </div>
  );

  // Same gate as the application-profile page: in non-AB modes no
  // CandidateProfile / Material / Preference bytes reach the page.
  if (!isResumeV1CapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
    return unavailable;
  }

  const user = await getCurrentUser();
  if (!user) {
    // The dashboard layout redirects unsigned sessions; this only fires on a
    // stale session whose user row no longer exists.
    return unavailable;
  }

  const status = await getAutoApplyExtensionStatus(prisma, user.id, {
    includePreview: true,
  });
  if (!status.available || !status.preview) {
    return unavailable;
  }
  const connections = await listConnections(user.id).catch(() => []);

  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        {backLink}
      </div>
      <div className="space-y-4">
        <AutoApplyConnectPanel initialConnections={connections} />
        <AutoApplyExportPanel
          preview={status.preview}
          pluginVersion={status.plugin.version}
          upstreamCommit={status.plugin.upstreamCommit}
        />
      </div>
    </div>
  );
}
