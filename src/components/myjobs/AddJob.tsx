"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { addJob, updateJob } from "@/actions/job.actions";
import { Loader, PlusCircle } from "lucide-react";
import { Button } from "../ui/button";
import { useForm } from "react-hook-form";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  AddJobFormValues,
  createAddJobFormSchema,
} from "@/models/addJobForm.schema";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Company,
  JOB_TYPES,
  JobLocation,
  JobResponse,
  JobSource,
  JobStatus,
  JobTitle,
  Tag,
  WORKPLACE_TYPES,
} from "@/models/job.model";
import { addDays } from "date-fns";
import { toastActionResult } from "@/lib/toast";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import SelectFormCtrl from "../Select";
import { DatePicker } from "../DatePicker";
import { SALARY_RANGES } from "@/lib/data/salaryRangeData";
import { RECRUITMENT_BATCH_SUGGESTIONS } from "@/lib/data/recruitmentBatchData";
import TiptapEditor from "../TiptapEditor";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { redirect, useRouter, useSearchParams } from "next/navigation";
import { Combobox } from "../ComboBox";
import { NotesCollapsibleSection } from "./NotesCollapsibleSection";
import { CoverLetter, Resume } from "@/models/profile.model";
import CreateResume from "../profile/CreateResume";
import { getResumeList } from "@/actions/profile.actions";
import { getCoverLetterList } from "@/actions/coverLetter.actions";
import { TagInput } from "./TagInput";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  useI18n,
  getLocalizedJobStatus,
  getLocalizedJobSource,
  getLocalizedJobType,
  getLocalizedWorkplaceType,
} from "@/i18n";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";
import type { AbRolloutScope } from "@/lib/career/capabilities";
import { isAbJobReadMode } from "@/lib/career/jobsReadCapabilities";

type AddJobProps = {
  jobStatuses: JobStatus[];
  companies: Company[];
  jobTitles: JobTitle[];
  locations: JobLocation[];
  jobSources: JobSource[];
  tags: Tag[];
  editJob?: JobResponse | null;
  resetEditJob: () => void;
  initialOpen?: boolean;
  hideTrigger?: boolean;
  redirectPath?: string;
  careerRuntimeMode?: string;
  abRolloutScope?: AbRolloutScope;
  onSaved?: () => void;
};

export function AddJob({
  jobStatuses,
  companies,
  jobTitles,
  locations,
  jobSources,
  tags,
  editJob,
  resetEditJob,
  initialOpen,
  hideTrigger,
  redirectPath,
  careerRuntimeMode,
  abRolloutScope,
  onSaved,
}: AddJobProps) {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [dialogOpen, setDialogOpen] = useState(initialOpen ?? false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [coverLetters, setCoverLetters] = useState<CoverLetter[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>(tags);
  const [isPending, startTransition] = useTransition();
  const hideUnsupportedAbFields = isAbJobReadMode(
    careerRuntimeMode,
    abRolloutScope,
  );

  useEffect(() => {
    if (!dialogOpen && searchParams.get("add-job") === "true") {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("add-job");
      const newPath = params.toString()
        ? `?${params.toString()}`
        : window.location.pathname;
      router.replace(newPath);
    }
  }, [dialogOpen, router, searchParams]);
  // Status semantics are keyed by `value`, never by array position: the list
  // order is whatever the database happens to return.
  const statusIdByValue = useMemo(
    () => new Map(jobStatuses.map((s) => [s.value, s.id])),
    [jobStatuses],
  );

  // Pre-fill with the last-used location/source, but only if that entity
  // still exists (handles deletion and cross-user localStorage collisions,
  // since `locations`/`jobSources` are already scoped to the current user).
  const lastLocationId = getFromLocalStorage(
    APP_CONSTANTS.LAST_JOB_LOCATION_STORAGE_KEY,
    null,
  );
  const lastSourceId = getFromLocalStorage(
    APP_CONSTANTS.LAST_JOB_SOURCE_STORAGE_KEY,
    null,
  );
  const newJobDefaultValues = {
    type: Object.keys(JOB_TYPES)[0],
    workplaceType: "ONSITE",
    dueDate: hideUnsupportedAbFields ? null : addDays(new Date(), 3),
    status: statusIdByValue.get("new"),
    salaryRange: "",
    jobUrl: "",
    jobDescription: "N/A",
    location: locations.find((l) => l.id === lastLocationId)?.id,
    source: jobSources.find((s) => s.id === lastSourceId)?.id,
    ...(hideUnsupportedAbFields
      ? { recruitmentCohort: "", recruitmentBatch: "" }
      : {}),
  };

  const formSchema = useMemo(() => createAddJobFormSchema(t), [t]);
  const form = useForm<AddJobFormValues>({
    resolver: zodResolver(formSchema) as any,
    defaultValues: newJobDefaultValues,
  });

  const { setValue, reset, watch, getValues } = form;

  const appliedValue = watch("applied");

  const loadResumes = useCallback(async () => {
    try {
      const resumes = await getResumeList(
        1,
        APP_CONSTANTS.RECORDS_PER_PAGE,
        APP_CONSTANTS.MIN_RESUME_SECTIONS_FOR_SELECTION,
      );
      setResumes(resumes.data);
    } catch (error) {
      console.error("Failed to load resumes:", error);
    }
  }, [setResumes]);

  const loadCoverLetters = useCallback(async () => {
    try {
      const result = await getCoverLetterList(1, 100);
      setCoverLetters(result.data);
    } catch (error) {
      console.error("Failed to load cover letters:", error);
    }
  }, [setCoverLetters]);

  useEffect(() => {
    if (editJob) {
      reset({
        id: editJob.id,
        userId: editJob.userId,
        title: editJob.JobTitle.id,
        company: editJob.Company.id,
        location: editJob.Location?.id,
        type: editJob.jobType,
        workplaceType: editJob.workplaceType ?? undefined,
        source: editJob.JobSource?.id,
        status: editJob.Status.id,
        dueDate: editJob.dueDate ?? null,
        recruitmentCohort: editJob.recruitmentCohort ?? "",
        recruitmentBatch: editJob.recruitmentBatch ?? "",
        salaryRange: editJob.salaryRange ?? "",
        jobDescription: editJob.description,
        applied: editJob.applied,
        jobUrl: editJob.jobUrl ?? "",
        dateApplied: editJob.appliedDate ?? undefined,
        resume: editJob.Resume?.id ?? undefined,
        coverLetter: editJob.CoverLetter?.id ?? undefined,
        tags: editJob.tags?.map((t) => t.id) ?? [],
      });
      // Merge any tags from editJob into the local pool so they're selectable
      if (editJob.tags && editJob.tags.length > 0) {
        setAvailableTags((prev) => {
          const existing = new Set(prev.map((t) => t.id));
          const incoming = editJob.tags!.filter((t) => !existing.has(t.id));
          return incoming.length > 0 ? [...prev, ...incoming] : prev;
        });
      }
      setDialogOpen(true);
    }
  }, [editJob, reset]);

  useEffect(() => {
    if (!dialogOpen || hideUnsupportedAbFields) return;
    loadResumes();
    loadCoverLetters();
  }, [dialogOpen, hideUnsupportedAbFields, loadResumes, loadCoverLetters]);

  const setNewResumeId = (id: string) => {
    setTimeout(() => {
      setValue("resume", id);
    }, 500);
  };

  function onSubmit(data: AddJobFormValues) {
    startTransition(async () => {
      const payload = hideUnsupportedAbFields
        ? { ...data, resume: undefined, coverLetter: undefined, tags: [] }
        : data;
      const result = editJob ? await updateJob(payload) : await addJob(payload);
      toastActionResult(result, {
        success: editJob ? t("jobs.updatedSuccess") : t("jobs.createdSuccess"),
        onSuccess: () => {
          saveToLocalStorage(
            APP_CONSTANTS.LAST_JOB_LOCATION_STORAGE_KEY,
            data.location,
          );
          saveToLocalStorage(
            APP_CONSTANTS.LAST_JOB_SOURCE_STORAGE_KEY,
            data.source,
          );
          reset();
          setDialogOpen(false);
          // Same list reload the toolbar button and note save already use.
          // redirect() to the current My Jobs URL does not refetch client state.
          onSaved?.();
          // A late same-page redirect can dismiss the next dialog the user opens.
          if (redirectPath || !onSaved) {
            redirect(redirectPath ?? "/dashboard/myjobs");
          }
        },
      });
    });
  }

  const pageTitle = editJob ? t("jobs.editJob") : t("jobs.addJob");
  const pageDescription = editJob
    ? t("jobs.editJobDescription")
    : t("jobs.addJobDescription");

  const addJobForm = () => {
    reset(newJobDefaultValues);
    resetEditJob();
    setDialogOpen(true);
  };

  const jobAppliedChange = (applied: boolean) => {
    // Applied is a one-way historical fact: the switch is disabled once it is
    // on, so a false edge should never arrive — guard anyway.
    if (!applied) return;
    // A job in a pre-application stage advances to `applied`; a job already
    // in a later stage (interview/offer/rejected/…) keeps its status.
    const currentStatusValue = jobStatuses.find(
      (s) => s.id === getValues("status"),
    )?.value;
    if (
      currentStatusValue === "new" ||
      currentStatusValue === "draft" ||
      currentStatusValue === undefined
    ) {
      const appliedStatusId = statusIdByValue.get("applied");
      if (appliedStatusId) setValue("status", appliedStatusId);
    }
    // appliedDate records the FIRST application only.
    if (!getValues("dateApplied")) {
      setValue("dateApplied", new Date());
    }
  };

  const closeDialog = () => setDialogOpen(false);

  const createResume = () => {
    setResumeDialogOpen(true);
  };

  return (
    <>
      {!hideTrigger && (
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1"
          onClick={addJobForm}
          data-testid="add-job-btn"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
            {t("jobs.newJob")}
          </span>
        </Button>
      )}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="h-full xl:h-[85vh] lg:h-[95vh] lg:max-w-screen-lg lg:max-h-screen overflow-y-scroll"
          >
            <DialogHeader>
              <DialogTitle data-testid="add-job-dialog-title">
                {pageTitle}
              </DialogTitle>
              <DialogDescription>{pageDescription}</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4"
              >
                {/* Job Title */}
                <div>
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.jobTitle")}</FormLabel>
                        <FormControl>
                          <Combobox
                            options={jobTitles}
                            field={field}
                            creatable
                            label={t("jobs.jobTitle")}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Job URL */}
                <div>
                  <FormField
                    control={form.control}
                    name="jobUrl"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.url")}</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={t("jobs.urlPlaceholder")}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {/* Company */}
                <div>
                  <FormField
                    control={form.control}
                    name="company"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.company")}</FormLabel>
                        <FormControl>
                          <Combobox
                            options={companies}
                            field={field}
                            creatable
                            label={t("jobs.company")}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {/* Location */}
                <div>
                  <FormField
                    control={form.control}
                    name="location"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.jobLocation")}</FormLabel>
                        <FormControl>
                          <Combobox
                            options={locations}
                            field={field}
                            creatable
                            label={t("jobs.jobLocation")}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {/* Job Type */}
                <div>
                  <FormField
                    control={form.control}
                    name="type"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel className="mb-2">{t("jobs.jobType")}</FormLabel>
                        <RadioGroup
                          name="type"
                          onValueChange={field.onChange}
                          value={field.value}
                          className="flex flex-wrap gap-x-4 gap-y-1"
                        >
                          {Object.entries(JOB_TYPES).map(([key, value]) => (
                            <FormItem
                              key={key}
                              className="flex items-center space-x-3 space-y-0"
                            >
                              <FormControl>
                                <RadioGroupItem value={key} />
                              </FormControl>
                              <FormLabel className="font-normal">
                                {getLocalizedJobType(value, t)}
                              </FormLabel>
                            </FormItem>
                          ))}
                        </RadioGroup>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {/* Workplace Type */}
                <div>
                  <FormField
                    control={form.control}
                    name="workplaceType"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel className="mb-2">{t("jobs.workplaceType")}</FormLabel>
                        <RadioGroup
                          name="workplaceType"
                          onValueChange={field.onChange}
                          value={field.value}
                          className="flex flex-wrap gap-x-4 gap-y-1"
                        >
                          {Object.entries(WORKPLACE_TYPES).map(
                            ([key, value]) => (
                              <FormItem
                                key={key}
                                className="flex items-center space-x-3 space-y-0"
                              >
                                <FormControl>
                                  <RadioGroupItem value={key} />
                                </FormControl>
                                <FormLabel className="font-normal">
                                  {getLocalizedWorkplaceType(value, t)}
                                </FormLabel>
                              </FormItem>
                            ),
                          )}
                        </RadioGroup>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {/* Job Source */}
                <div>
                  <FormField
                    control={form.control}
                    name="source"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.jobSourceLabel")}</FormLabel>
                        <Combobox
                          options={jobSources}
                          getOptionLabel={(source) => getLocalizedJobSource(source, t)}
                          field={field}
                          creatable
                          label={t("jobs.jobSourceLabel")}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Applied */}
                <div
                  className="flex items-center"
                  data-testid="switch-container"
                >
                  <FormField
                    control={form.control}
                    name="applied"
                    render={({ field }) => (
                      <FormItem className="flex flex-row">
                        <Switch
                          id="applied-switch"
                          checked={field.value ?? false}
                          // Applied is a recorded fact, not a toggle — once a
                          // job is applied the control locks in the on state.
                          disabled={field.value === true}
                          onCheckedChange={(a) => {
                            field.onChange(a);
                            jobAppliedChange(a);
                          }}
                        />
                        <FormLabel
                          htmlFor="applied-switch"
                          className="flex items-center ml-4 mb-2"
                        >
                          {field.value
                            ? t("jobs.statuses.applied")
                            : t("jobs.notAppliedSwitch")}
                        </FormLabel>

                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Status */}
                <div>
                  <FormField
                    control={form.control}
                    name="status"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.jobStatus")}</FormLabel>
                        <SelectFormCtrl
                          label={t("jobs.jobStatusSelect")}
                          options={jobStatuses.map((status) => ({
                            ...status,
                            label: getLocalizedJobStatus(status, t),
                          }))}
                          field={field}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Date Applied */}
                <div className="flex flex-col">
                  <FormField
                    control={form.control}
                    name="dateApplied"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.dateApplied")}</FormLabel>
                        <DatePicker
                          field={field}
                          presets={false}
                          isEnabled={appliedValue}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Due Date */}
                <div>
                  <FormField
                    control={form.control}
                    name="dueDate"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>
                          {t("jobs.dueDate")}
                          {hideUnsupportedAbFields
                            ? ` (${t("common.optional")})`
                            : ""}
                        </FormLabel>
                        <DatePicker
                          field={field}
                          presets={true}
                          isEnabled={true}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {hideUnsupportedAbFields && (
                  <>
                    <div>
                      <FormField
                        control={form.control}
                        name="recruitmentCohort"
                        render={({ field }) => (
                          <FormItem className="flex flex-col">
                            <FormLabel>
                              {t("jobs.recruitmentCohort")}{" "}
                              ({t("common.optional")})
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder={t("jobs.recruitmentCohortPlaceholder")}
                                {...field}
                                value={field.value ?? ""}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div>
                      <FormField
                        control={form.control}
                        name="recruitmentBatch"
                        render={({ field }) => (
                          <FormItem className="flex flex-col">
                            <FormLabel>
                              {t("jobs.recruitmentBatch")}{" "}
                              ({t("common.optional")})
                            </FormLabel>
                            <Combobox
                              options={RECRUITMENT_BATCH_SUGGESTIONS}
                              field={field}
                              creatable
                              freeText
                              label={t("jobs.recruitmentBatch")}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </>
                )}

                {/* Salary Range */}
                <div>
                  <FormField
                    control={form.control}
                    name="salaryRange"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel>{t("jobs.salaryRange")}</FormLabel>
                        <Combobox
                          options={SALARY_RANGES}
                          field={field}
                          creatable
                          freeText
                          label={t("jobs.salaryRange")}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {hideUnsupportedAbFields ? (
                  <div className="md:col-span-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                    {t("jobs.abUnsupportedFieldsHint")}
                  </div>
                ) : (
                  <>
                    <div className="flex items-end">
                      <FormField
                        control={form.control}
                        name="resume"
                        render={({ field }) => (
                          <FormItem className="flex flex-col">
                            <FormLabel>{t("jobs.resume")}</FormLabel>
                            <SelectFormCtrl
                              label={t("jobs.resume")}
                              options={resumes}
                              field={field}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <Button variant="link" type="button" onClick={createResume}>
                        {t("jobs.addNew")}
                      </Button>
                      <CreateResume
                        resumeDialogOpen={resumeDialogOpen}
                        setResumeDialogOpen={setResumeDialogOpen}
                        reloadResumes={loadResumes}
                        setNewResumeId={setNewResumeId}
                      />
                    </div>

                    <div className="flex items-end">
                      <FormField
                        control={form.control}
                        name="coverLetter"
                        render={({ field }) => (
                          <FormItem className="flex flex-col">
                            <FormLabel>{t("jobs.coverLetter")}</FormLabel>
                            <SelectFormCtrl
                              label={t("jobs.coverLetter")}
                              options={coverLetters}
                              field={field}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="md:col-span-2">
                      <FormField
                        control={form.control}
                        name="tags"
                        render={({ field }) => (
                          <FormItem className="flex flex-col">
                            <FormLabel>{t("jobs.addSkill")}</FormLabel>
                            <FormControl>
                              <TagInput
                                availableTags={availableTags}
                                selectedTagIds={field.value ?? []}
                                onChange={(ids) => field.onChange(ids)}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </>
                )}

                {/* Job Description */}
                <div className="md:col-span-2">
                  <FormField
                    control={form.control}
                    name="jobDescription"
                    render={({ field }) => (
                      <FormItem className="flex flex-col">
                        <FormLabel id="job-description-label">
                          {t("jobs.description")}
                        </FormLabel>
                        <FormControl>
                          <TiptapEditor field={field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {editJob && <NotesCollapsibleSection jobId={editJob.id} />}
                <div className="md:col-span-2">
                  <DialogFooter
                  // className="md:col-span
                  >
                    <div>
                      <Button
                        type="reset"
                        variant="outline"
                        className="mt-2 md:mt-0 w-full"
                        onClick={closeDialog}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                    <Button disabled={isPending} aria-busy={isPending} type="submit" data-testid="save-job-btn">
                      {t("common.save")}
                      {isPending && (
                        <Loader className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
                      )}
                    </Button>
                  </DialogFooter>
                </div>
              </form>
            </Form>
          </DialogContent>
      </Dialog>
    </>
  );
}
