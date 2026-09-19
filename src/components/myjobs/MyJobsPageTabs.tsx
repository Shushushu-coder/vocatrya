"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabQueryParam } from "@/hooks/useTabQueryParam";
import type { AbRolloutScope } from "@/lib/career/capabilities";
import { isAbJobReadMode } from "@/lib/career/jobsReadCapabilities";
import { useI18n } from "@/i18n";
import JobsContainer from "./JobsContainer";
import { UpcomingContainer } from "./UpcomingContainer";
import type {
  Company,
  JobLocation,
  JobSource,
  JobStatus,
  JobTitle,
  Tag,
} from "@/models/job.model";

const JOBS_TABS = ["jobs", "upcoming"] as const;

type MyJobsPageTabsProps = {
  statuses: JobStatus[];
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
  tags: Tag[];
  allowJobMutations?: boolean;
  careerRuntimeMode?: string;
  abRolloutScope?: AbRolloutScope;
};

export function MyJobsPageTabs(props: MyJobsPageTabsProps) {
  const { t } = useI18n();
  const showUpcoming = isAbJobReadMode(
    props.careerRuntimeMode,
    props.abRolloutScope,
  );
  const [tab, setTab] = useTabQueryParam(
    showUpcoming ? JOBS_TABS : (["jobs"] as const),
    "jobs",
  );

  if (!showUpcoming) {
    return <JobsContainer {...props} />;
  }

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4">
        <TabsTrigger value="jobs">{t("jobs.title")}</TabsTrigger>
        <TabsTrigger value="upcoming">{t("jobs.upcomingTab")}</TabsTrigger>
      </TabsList>
      <TabsContent value="jobs">
        <JobsContainer {...props} />
      </TabsContent>
      <TabsContent value="upcoming">
        <UpcomingContainer />
      </TabsContent>
    </Tabs>
  );
}
