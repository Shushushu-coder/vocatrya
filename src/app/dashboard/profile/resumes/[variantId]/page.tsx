import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { ResumeVariantWorkspace } from "@/components/career/resume-variant/ResumeVariantWorkspace";
import { canReadCareerData } from "@/lib/career/access";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("resumeVariants.title") };
}

export default async function ResumeVariantWorkspacePage({
  params,
}: {
  params: Promise<{ variantId: string }>;
}) {
  const { variantId } = await params;
  const runtime = await getCareerRuntimeSnapshot();
  const { t } = await getServerI18n();
  if (!canReadCareerData(runtime.mode)) {
    return (
      <div className="col-span-3">
        <CareerRuntimeNotice mode={runtime.mode} />
        <div className="mt-2 text-sm text-muted-foreground">
          <Link className="text-primary underline" href="/dashboard/profile">
            {t("common.back")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      <ResumeVariantWorkspace variantId={variantId} />
    </div>
  );
}
