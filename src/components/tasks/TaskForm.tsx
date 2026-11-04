"use client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { createTask, updateTask } from "@/actions/task.actions";
import { Loader } from "lucide-react";
import { Button } from "../ui/button";
import { useForm } from "react-hook-form";
import { useEffect, useTransition } from "react";
import { AddTaskFormSchema } from "@/models/addTaskForm.schema";
import { zodResolver } from "@hookform/resolvers/zod";
import { Task, TASK_STATUSES, TaskStatus } from "@/models/task.model";
import { z } from "zod";
import { toastActionResult } from "@/lib/toast";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import SelectFormCtrl from "../Select";
import { DatePicker } from "../DatePicker";
import TiptapEditor from "../TiptapEditor";
import { Input } from "../ui/input";
import { Combobox } from "../ComboBox";
import { Slider } from "../ui/slider";
import { ActivityType } from "@/models/activity.model";
import { useI18n, getLocalizedTaskStatus } from "@/i18n";
import {
  compareDateOnly,
  dateOnlyFromPickerDate,
  runtimeTimeZone,
  todayDateOnly,
} from "@/lib/datetime";
import { taskDuePickerDate } from "@/lib/tasks/dueTime";

type TaskFormProps = {
  activityTypes: ActivityType[];
  editTask?: Task | null;
  resetEditTask: () => void;
  onTaskSaved: () => void;
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  timeZone?: string;
  /** New-task seeds (e.g. reflection-to-task). Ignored while editing. */
  initialValues?: { title?: string; description?: string } | null;
};

export function TaskForm({
  activityTypes,
  editTask,
  resetEditTask,
  onTaskSaved,
  dialogOpen,
  setDialogOpen,
  timeZone = runtimeTimeZone(),
  initialValues,
}: TaskFormProps) {
  const { t, formatDateTime } = useI18n();
  const [isPending, startTransition] = useTransition();
  const statusOptions = (Object.keys(TASK_STATUSES) as TaskStatus[]).map(
    (value) => ({
      id: value,
      label: getLocalizedTaskStatus(value, t),
      value,
    }),
  );
  const form = useForm<z.infer<typeof AddTaskFormSchema>>({
    resolver: zodResolver(AddTaskFormSchema),
    defaultValues: {
      title: "",
      description: "",
      status: "in-progress" as TaskStatus,
      priority: 5,
      percentComplete: 0,
      dueDate: undefined,
      activityTypeId: undefined,
    },
  });

  const { reset, watch } = form;

  const priorityValue = watch("priority");
  const percentCompleteValue = watch("percentComplete");

  useEffect(() => {
    if (editTask) {
      let dueDate: Date | undefined;
      try {
        // DateOnly -> its calendar day; unknown instant -> its account-zone
        // wall date. A corrupt stored value never blocks the edit dialog.
        dueDate = taskDuePickerDate(editTask, timeZone) ?? undefined;
      } catch {
        dueDate = undefined;
      }
      reset({
        id: editTask.id,
        userId: editTask.userId,
        title: editTask.title,
        description: editTask.description || "",
        status: editTask.status,
        priority: editTask.priority,
        percentComplete: editTask.percentComplete,
        dueDate,
        activityTypeId: editTask.activityTypeId || undefined,
      });
    } else {
      reset({
        title: initialValues?.title ?? "",
        description: initialValues?.description ?? "",
        status: "in-progress",
        priority: 5,
        percentComplete: 0,
        dueDate: undefined,
        activityTypeId: undefined,
      });
    }
  }, [editTask, reset, timeZone, initialValues]);

  function onSubmit(data: z.infer<typeof AddTaskFormSchema>) {
    // dueOn is the write contract: undefined keeps stored values on edit,
    // null clears, a YYYY-MM-DD string sets a calendar-day due.
    const dueDateTouched = form.formState.dirtyFields.dueDate === true;
    const dueOn =
      editTask && !dueDateTouched
        ? undefined
        : data.dueDate
          ? dateOnlyFromPickerDate(data.dueDate)
          : null;
    if (
      typeof dueOn === "string" &&
      compareDateOnly(dueOn, todayDateOnly(timeZone)) < 0
    ) {
      form.setError("dueDate", {
        type: "manual",
        message: "Due date cannot be in the past.",
      });
      return;
    }
    startTransition(async () => {
      const result = editTask
        ? await updateTask({ ...data, dueOn })
        : await createTask({ ...data, dueOn });
      toastActionResult<Task>(result, {
        success: editTask ? t("tasks.taskUpdated") : t("tasks.taskCreated"),
        onSuccess: () => {
          reset();
          setDialogOpen(false);
          resetEditTask();
          onTaskSaved();
        },
      });
    });
  }

  const onSaveClick = form.handleSubmit((data) => onSubmit(data));

  const pageTitle = editTask ? t("tasks.editTask") : t("tasks.addTask");
  const pageDescription = editTask
    ? t("tasks.editTaskDescription")
    : t("tasks.addTaskDescription");

  const closeDialog = () => {
    reset();
    resetEditTask();
    setDialogOpen(false);
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="sm:max-w-[725px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle data-testid="task-form-dialog-title">
            {pageTitle}
          </DialogTitle>
          <DialogDescription>{pageDescription}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={onSaveClick}
            className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4"
          >
            {/* Title */}
            <div className="md:col-span-2">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t("tasks.titleRequired")}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t("tasks.titlePlaceholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Activity Type */}
            <div>
              <FormField
                control={form.control}
                name="activityTypeId"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t("tasks.activityType")}</FormLabel>
                    <FormControl>
                      <Combobox
                        options={activityTypes}
                        field={{
                          ...field,
                          name: "activityType",
                        }}
                        creatable
                      />
                    </FormControl>
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
                    <FormLabel>{t("common.status")}</FormLabel>
                    <SelectFormCtrl
                      label={t("tasks.taskStatus")}
                      options={statusOptions}
                      field={field}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Priority */}
            <div>
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>
                      {t("tasks.priorityValue", { value: priorityValue })}
                    </FormLabel>
                    <FormControl>
                      <Slider
                        min={0}
                        max={10}
                        step={1}
                        value={[field.value]}
                        onValueChange={(value) => field.onChange(value[0])}
                        className="mt-2"
                      />
                    </FormControl>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{t("tasks.lowZero")}</span>
                      <span>{t("tasks.highTen")}</span>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Percent Complete */}
            <div>
              <FormField
                control={form.control}
                name="percentComplete"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>
                      {t("tasks.percentCompleteValue", {
                        value: percentCompleteValue,
                      })}
                    </FormLabel>
                    <FormControl>
                      <Slider
                        min={0}
                        max={100}
                        step={5}
                        value={[field.value]}
                        onValueChange={(value) => field.onChange(value[0])}
                        className="mt-2"
                      />
                    </FormControl>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>0%</span>
                      <span>100%</span>
                    </div>
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
                    <FormLabel>{t("tasks.dueDate")}</FormLabel>
                    <DatePicker
                      field={field}
                      // Shared presets use the host calendar. Keep them only
                      // when it matches the account; manual days stay usable.
                      presets={timeZone === runtimeTimeZone()}
                      isEnabled={true}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Created and Updated Dates */}
            {editTask && (
              <div className="flex flex-col gap-2">
                <div>
                  <p className="text-sm font-medium">{t("common.created")}</p>
                  <p className="text-sm text-muted-foreground">
                    {editTask.createdAt
                      ? formatDateTime(new Date(editTask.createdAt))
                      : t("common.notAvailable")}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">{t("common.updated")}</p>
                  <p className="text-sm text-muted-foreground">
                    {editTask.updatedAt
                      ? formatDateTime(new Date(editTask.updatedAt))
                      : t("common.notAvailable")}
                  </p>
                </div>
              </div>
            )}

            {/* Description */}
            <div className="md:col-span-2">
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>{t("common.description")}</FormLabel>
                    <FormControl>
                      <TiptapEditor field={field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="md:col-span-2">
              <DialogFooter>
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
                <Button
                  type="submit"
                  disabled={isPending}
                  data-testid="save-task-btn"
                >
                  {t("common.save")}
                  {isPending && (
                    <Loader className="h-4 w-4 shrink-0 spinner ml-2" />
                  )}
                </Button>
              </DialogFooter>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
