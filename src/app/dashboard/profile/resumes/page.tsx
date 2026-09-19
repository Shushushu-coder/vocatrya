import Link from "next/link";
import { getServerI18n } from "@/i18n/server";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { ResumeVariantList } from "@/components/career/resume-variant/ResumeVariantList";
import { canReadCareerData } from "@/lib/career/access";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("resumeVariants.title") };
}

export default async function ResumeVariantsPage() {
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
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{t("resumeVariants.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("resumeVariants.subtitle")}</p>
      </div>
      <ResumeVariantList />
    </div>
  );
}
