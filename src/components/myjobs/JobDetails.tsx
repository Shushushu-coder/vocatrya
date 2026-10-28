"use client";
import {
  Company,
  JobLocation,
  JobResponse,
  JobSource,
  JobStatus,
  JobTitle,
  Tag,
} from "@/models/job.model";
import { TipTapContentViewer } from "../TipTapContentViewer";
import { Badge } from "../ui/badge";
import { Card } from "../ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTabQueryParam } from "@/hooks/useTabQueryParam";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { NotesSection } from "./NotesSection";
import { useState, useMemo } from "react";
import { MatchDetails } from "../automations/MatchDetails";
import type { JobMatchData } from "@/models/ai.schemas";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { AddJob } from "./AddJob";
import { deleteJobById, updateJobStatus } from "@/actions/job.actions";
import { toastError, toastSuccess } from "@/lib/toast";
import { JobDetailsHeader } from "./job-details/JobDetailsHeader";
import { JobSummaryCard } from "./job-details/JobSummaryCard";
import { JobTabEmptyState } from "./job-details/JobTabEmptyState";
import { CoverLetterTab } from "./job-details/CoverLetterTab";
import { useAutoMatch } from "./job-details/useAutoMatch";
import { JobContactsTab } from "./job-details/JobContactsTab";
import { ApplicationTimelineTab } from "./job-details/ApplicationTimelineTab";
import { ApplicationResumeBindingPanel } from "./job-details/ApplicationResumeBindingPanel";
import type { AbRolloutScope } from "@/lib/career/capabilities";
import { isAbJobReadMode } from "@/lib/career/jobsReadCapabilities";
import {
  isFullAbCapabilityEnabled,
  isRestrictedResumeBindingSurfaceEnabled,
} from "@/lib/career/capabilities";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";
import { useI18n } from "@/i18n";

const LEGACY_JOB_DETAIL_TABS = [
  "description",
  "match",
  "letter",
  "notes",
  "contacts",
] as const;

const AB_JOB_DETAIL_TABS = [
  "description",
  "timeline",
  "match",
  "letter",
  "notes",
  "contacts",
] as const;

// Match, cover letter and contacts have no canonical fresh-native
// implementation yet — under fresh + full the tabs are simply absent, so a
// retained ?tab=match link falls back to the description tab.
const FRESH_FULL_JOB_DETAIL_TABS = ["description", "timeline", "notes"] as const;

type JobDetailsProps = {
  job: JobResponse;
  jobStatuses: JobStatus[];
  companies: Company[];
  titles: JobTitle[];
  locations: JobLocation[];
  sources: JobSource[];
  tags: Tag[];
  careerRuntimeMode?: string;
  abRolloutScope?: AbRolloutScope;
  /** Account zone for deadline display/overdue semantics. */
  timeZone?: string;
};

function JobDetails({
  job,
  jobStatuses,
  companies,
  titles,
  locations,
  sources,
  tags,
  careerRuntimeMode,
  abRolloutScope,
  timeZone,
}: JobDetailsProps) {
  const { t } = useI18n();
  const showTimeline = isAbJobReadMode(careerRuntimeMode, abRolloutScope);
  const showRestrictedResumePanel = isRestrictedResumeBindingSurfaceEnabled(
    careerRuntimeMode ?? "",
    abRolloutScope ?? "none",
  );
  const canMutateTimeline = isFullAbCapabilityEnabled(
    careerRuntimeMode ?? "",
    abRolloutScope ?? "none",
  );
  const { freshNativeFull, jobMutationsEnabled } = useCareerSurfaces();
  const jobDetailTabs = freshNativeFull
    ? FRESH_FULL_JOB_DETAIL_TABS
    : showTimeline
      ? AB_JOB_DETAIL_TABS
      : LEGACY_JOB_DETAIL_TABS;
  const {
    open: openChat,
    startNewConversation,
    sendMessage,
    approvalPending,
    busy: chatBusy,
  } = useAgentChat();
  const [showClearChatConfirm, setShowClearChatConfirm] = useState(false);
  const [pendingChatMessage, setPendingChatMessage] = useState("");
  const [currentStatus, setCurrentStatus] = useState(job.Status);
  const [editJobTarget, setEditJobTarget] = useState<JobResponse | null>(
    null,
  );
  const [deleteAlertOpen, setDeleteAlertOpen] = useState(false);
  const [noteOpenTrigger, setNoteOpenTrigger] = useState(0);
  const [notesCount, setNotesCount] = useState(0);
  const [timelineRefreshKey, setTimelineRefreshKey] = useState(0);
  const router = useRouter();
  const [activeTab, handleTabChange] = useTabQueryParam(
    jobDetailTabs,
    "description",
  );
  const goBack = () => router.back();

  // Derived from the server prop, not local state: the chat saves the match
  // server-side and fires router.refresh(), so mirrored state would go stale.
  const parsedMatchData = useMemo(() => {
    if (!job.matchData) return null;
    try {
      return JSON.parse(job.matchData) as JobMatchData;
    } catch {
      return null;
    }
  }, [job.matchData]);

  const jobLabel = `${job.JobTitle?.label ?? "this job"}${
    job.Company?.label ? ` at ${job.Company.label}` : ""
  }`;

  // Panel first so a failed clear can never leave a button looking dead, and
  // the message is sent either way — a conversation that would not clear is no
  // reason to withhold it.
  const startChat = async (text: string) => {
    openChat();
    try {
      await startNewConversation();
    } catch {
      // The message still goes out if the draft could not be prepared.
    }
    void sendMessage({ parts: [{ type: "text", text }] });
  };

  const requestChat = (text: string) => {
    if (approvalPending) {
      setPendingChatMessage(text);
      setShowClearChatConfirm(true);
      return;
    }
    void startChat(text);
  };

  const onMatch = () => requestChat(`Match my resume to ${jobLabel}`);
  const onCoverLetter = () =>
    requestChat(`Write a cover letter for ${jobLabel}`);

  useAutoMatch(onMatch, !freshNativeFull && jobMutationsEnabled);

  // Doubles as the busy gate: the header button, the empty state and
  // Regenerate all key on this one reason.
  const coverLetterBlockedReason =
    !jobMutationsEnabled
      ? t("career.jobsReadOnlyTitle")
      : job.descriptionCompleteness === "title-only"
        ? t("jobs.addDescriptionFirst")
        : chatBusy
          ? t("jobs.assistantBusy")
          : undefined;

  const onEditJob = () => {
    setEditJobTarget({ ...job, Status: currentStatus });
  };

  const resetEditJob = () => setEditJobTarget(null);

  const onAddNote = () => {
    handleTabChange("notes");
    setNoteOpenTrigger((prev) => prev + 1);
  };

  const onChangeStatus = async (status: JobStatus) => {
    const { success, message } = await updateJobStatus(job.id, status);
    if (success) {
      setCurrentStatus(status);
      setTimelineRefreshKey((prev) => prev + 1);
      toastSuccess(t("jobs.updatedSuccess"));
    } else {
      toastError(message);
    }
  };

  const onDeleteJob = async () => {
    const { success, message } = await deleteJobById(job.id);
    if (success) {
      toastSuccess(
        showTimeline ? t("jobs.archivedSuccess") : t("jobs.deletedSuccess"),
      );
      router.push("/dashboard/myjobs");
    } else {
      toastError(message);
    }
  };

  return (
    <>
      <div className="py-6 space-y-6">
        <JobDetailsHeader
          job={job}
          jobStatuses={jobStatuses}
          currentStatus={currentStatus}
          coverLetterBlockedReason={coverLetterBlockedReason}
          chatBusy={chatBusy}
          showAiActions={!freshNativeFull}
          onBack={goBack}
          onMatch={onMatch}
          onCoverLetter={onCoverLetter}
          onEdit={onEditJob}
          onDelete={() => setDeleteAlertOpen(true)}
          onAddNote={onAddNote}
          onChangeStatus={onChangeStatus}
        />

        <JobSummaryCard
          job={job}
          currentStatus={currentStatus}
          matchData={parsedMatchData}
          showCampusFields={showTimeline}
          showMatchScore={!freshNativeFull}
          timeZone={timeZone}
        />

        {showRestrictedResumePanel && (
          <Card
            className="p-6"
            data-testid="restricted-submitted-resume-panel"
          >
            <ApplicationResumeBindingPanel
              jobId={job.id}
              refreshKey={timelineRefreshKey}
            />
          </Card>
        )}

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="description">{t("common.description")}</TabsTrigger>
            {showTimeline && (
              <TabsTrigger value="timeline">{t("jobs.timelineTab")}</TabsTrigger>
            )}
            {!freshNativeFull && (
              <TabsTrigger value="match">{t("automations.aiMatch")}</TabsTrigger>
            )}
            {!freshNativeFull && (
              <TabsTrigger value="letter">{t("jobs.coverLetter")}</TabsTrigger>
            )}
            <TabsTrigger value="notes">
              {t("common.notes")}
              {notesCount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {notesCount}
                </Badge>
              )}
            </TabsTrigger>
            {!freshNativeFull && (
              <TabsTrigger value="contacts">
                {t("jobs.contactsTab")}
                {(job.contactLinks?.length ?? 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {job.contactLinks!.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="description" className="mt-4">
            <Card className="p-6">
              <TipTapContentViewer content={job?.description} />
            </Card>
          </TabsContent>
          {showTimeline && (
            <TabsContent value="timeline" className="mt-4">
              <Card className="p-6">
                <ApplicationTimelineTab
                  jobId={job.id}
                  refreshKey={timelineRefreshKey}
                  canMutate={canMutateTimeline}
                  companyName={job.Company?.label}
                  roleTitle={job.JobTitle?.label}
                />
              </Card>
            </TabsContent>
          )}
          {!freshNativeFull && (
            <TabsContent value="match" className="mt-4">
              <Card className="p-6">
                {parsedMatchData && parsedMatchData.analyzed !== false ? (
                  <MatchDetails matchData={parsedMatchData} />
                ) : (
                  <JobTabEmptyState
                    icon={Sparkles}
                    title={t("jobs.noMatchYet")}
                    description={t("jobs.noMatchDescription")}
                    actionLabel={t("jobs.matchWithAi")}
                    onAction={onMatch}
                    actionDisabled={chatBusy || !jobMutationsEnabled}
                    actionTitle={chatBusy ? t("jobs.assistantBusy") : undefined}
                  />
                )}
              </Card>
            </TabsContent>
          )}
          {!freshNativeFull && (
            <TabsContent value="letter" className="mt-4">
              <Card className="p-6">
                <CoverLetterTab
                  letter={job.CoverLetter}
                  blockedReason={coverLetterBlockedReason}
                  onGenerate={onCoverLetter}
                />
              </Card>
            </TabsContent>
          )}
          {/* forceMount keeps ⋮ → Add a Note and the count badge working off-tab. */}
          <TabsContent
            value="notes"
            className="mt-4 data-[state=inactive]:hidden"
            forceMount
          >
            <Card className="p-6">
              <NotesSection
                jobId={job.id}
                openTrigger={noteOpenTrigger}
                onCountChange={setNotesCount}
              />
            </Card>
          </TabsContent>
          {!freshNativeFull && (
            <TabsContent value="contacts" className="mt-4">
              <Card className="p-6">
                <JobContactsTab
                  jobId={job.id}
                  links={job.contactLinks ?? []}
                  companies={companies}
                  locations={locations}
                />
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>
      <AddJob
        jobStatuses={jobStatuses}
        companies={companies}
        jobTitles={titles}
        locations={locations}
        jobSources={sources}
        tags={tags}
        editJob={editJobTarget}
        resetEditJob={resetEditJob}
        hideTrigger
        careerRuntimeMode={careerRuntimeMode}
        abRolloutScope={abRolloutScope}
        timeZone={timeZone}
        redirectPath={`/dashboard/myjobs/${job.id}?tab=${activeTab}`}
      />
      <DeleteAlertDialog
        pageTitle="job"
        alertTitle={
          showTimeline ? t("jobs.archiveConfirm") : t("jobs.deleteConfirm")
        }
        alertDescription={
          showTimeline ? t("jobs.archiveConfirmDescription") : undefined
        }
        actionLabel={showTimeline ? t("jobs.archiveAction") : undefined}
        open={deleteAlertOpen}
        onOpenChange={setDeleteAlertOpen}
        onDelete={onDeleteJob}
      />
      {/* CLEAR CHAT BEFORE AN AI ACTION CONFIRM */}
      <AlertDialog
        open={showClearChatConfirm}
        onOpenChange={setShowClearChatConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("jobs.clearChatTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("jobs.clearChatDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void startChat(pendingChatMessage)}>
              {t("jobs.clearAndContinue")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default JobDetails;
