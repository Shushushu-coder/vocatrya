import { getJobSourceList, getStatusList } from "@/actions/job.actions";
import { getCareerRuntimeSnapshot } from "@/actions/career.runtime";
import { getServerI18n } from "@/i18n/server";
import { MyJobsPageTabs } from "@/components/myjobs/MyJobsPageTabs";
import { CareerRuntimeNotice } from "@/components/career/CareerRuntimeNotice";
import { getAllCompanies } from "@/actions/company.actions";
import { getAllJobTitles } from "@/actions/jobtitle.actions";
import { getAllJobLocations } from "@/actions/jobLocation.actions";
import { getAllTags } from "@/actions/tag.actions";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("jobs.pageTitle") };
}

async function MyJobs() {
  const [statuses, companies, titles, locations, sources, tags, runtime] =
    await Promise.all([
      getStatusList(),
      getAllCompanies(),
      getAllJobTitles(),
      getAllJobLocations(),
      getJobSourceList(),
      getAllTags(),
      getCareerRuntimeSnapshot(),
    ]);
  return (
    <div className="col-span-3 min-w-0">
      <CareerRuntimeNotice mode={runtime.mode} />
      <MyJobsPageTabs
        companies={companies}
        titles={titles}
        locations={locations}
        sources={sources}
        statuses={statuses}
        tags={tags ?? []}
        allowJobMutations={runtime.writeFamily !== "blocked"}
        careerRuntimeMode={runtime.mode}
        abRolloutScope={runtime.rolloutScope}
      />
    </div>
  );
}

export default MyJobs;
