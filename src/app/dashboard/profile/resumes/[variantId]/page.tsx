import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { resolveResumeVariantWorkspaceVersion } from "@/actions/resumeVariant.actions";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { ResumeVariantWorkspace } from "@/components/career/resume-variant/ResumeVariantWorkspace";
import { canReadCareerData } from "@/lib/career/access";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("resumeVariants.title") };
}

export default async function ResumeVariantWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const { variantId } = await params;
  const query = await searchParams;
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

  const requested = Array.isArray(query.version) ? query.version[0] : query.version;
  let initialVersionId: string | undefined;
  if (requested && requested.trim() !== "") {
    const resolved = await resolveResumeVariantWorkspaceVersion({
      variantId,
      versionId: requested.trim(),
    });
    // Fail closed: a non-empty ?version= that does not resolve (missing,
    // cross-variant, foreign, or malformed) must 404 instead of silently
    // falling back to the current version.
    if (!resolved.success || !resolved.data) {
      notFound();
    }
    initialVersionId = (resolved.data as { versionId: string }).versionId;
  }

  return (
    <div className="col-span-3">
      <CareerRuntimeNotice mode={runtime.mode} />
      <ResumeVariantWorkspace
        variantId={variantId}
        initialVersionId={initialVersionId}
      />
    </div>
  );
}
