"use client";
import ActivityTypesContainer from "@/components/admin/ActivityTypesContainer";
import CompaniesContainer from "@/components/admin/CompaniesContainer";
import ContactRolesContainer from "@/components/admin/ContactRolesContainer";
import ContactsContainer from "@/components/admin/ContactsContainer";
import JobLocationsContainer from "@/components/admin/JobLocationsContainer";
import JobSourcesContainer from "@/components/admin/JobSourcesContainer";
import JobTitlesContainer from "@/components/admin/JobTitlesContainer";
import TagsContainer from "@/components/admin/TagsContainer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { useI18n } from "@/i18n";

function AdminTabsContainer() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const queryParams = useSearchParams();

  const createQueryString = useCallback(
    (name: string, value: string) => {
      const params = new URLSearchParams(queryParams.toString());
      params.set(name, value);

      return params.toString();
    },
    [queryParams],
  );

  const onTabChange = (tab: string) => {
    router.push(pathname + "?" + createQueryString("tab", tab));
  };
  return (
    <Tabs
      defaultValue={queryParams.get("tab") || "companies"}
      onValueChange={(e) => onTabChange(e)}
    >
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="companies">{t("library.companies")}</TabsTrigger>
        <TabsTrigger value="job-titles">{t("library.jobTitles")}</TabsTrigger>
        <TabsTrigger value="locations">{t("library.locations")}</TabsTrigger>
        <TabsTrigger value="sources">{t("library.sources")}</TabsTrigger>
        <TabsTrigger value="skills">{t("library.skills")}</TabsTrigger>
        <TabsTrigger value="activity-types">{t("library.activityTypes")}</TabsTrigger>
        <TabsTrigger value="contacts">{t("library.contacts")}</TabsTrigger>
        <TabsTrigger value="roles">{t("library.roles")}</TabsTrigger>
      </TabsList>
      <TabsContent value="companies">
        <CompaniesContainer />
      </TabsContent>
      <TabsContent value="job-titles">
        <JobTitlesContainer />
      </TabsContent>
      <TabsContent value="locations">
        <JobLocationsContainer />
      </TabsContent>
      <TabsContent value="sources">
        <JobSourcesContainer />
      </TabsContent>
      <TabsContent value="skills">
        <TagsContainer />
      </TabsContent>
      <TabsContent value="activity-types">
        <ActivityTypesContainer />
      </TabsContent>
      <TabsContent value="contacts">
        <ContactsContainer />
      </TabsContent>
      <TabsContent value="roles">
        <ContactRolesContainer />
      </TabsContent>
    </Tabs>
  );
}

export default AdminTabsContainer;
