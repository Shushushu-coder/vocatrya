import { notFound } from "next/navigation";
import {
  MockActivitiesCard,
  MockProfileCard,
  MockJobsCard,
} from "@/components/developer/DeveloperContainer";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.developer") };
}

export default async function DeveloperPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const { t } = await getServerI18n();
  return (
    <>
      <div className="col-span-3">
        <h1 className="text-3xl font-bold tracking-tight">{t("nav.developer")}</h1>
        <p className="text-muted-foreground mt-2">
          {t("developer.pageDescription")}
        </p>
      </div>
      <div className="col-start-1 self-start">
        <MockActivitiesCard />
      </div>
      <div className="col-start-2 self-start">
        <MockProfileCard />
      </div>
      <div className="col-start-3 self-start">
        <MockJobsCard />
      </div>
    </>
  );
}
