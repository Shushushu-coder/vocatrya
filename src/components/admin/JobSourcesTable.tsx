"use client";
import { useState } from "react";
import { Button } from "../ui/button";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { JobSource } from "@/models/job.model";
import { Briefcase, MoreVertical, Pencil, Trash } from "lucide-react";
import Link from "next/link";
import { AlertDialog } from "@/models/alertDialog.model";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import DictionaryLabelDialog from "./DictionaryLabelDialog";
import { SYSTEM_JOB_SOURCE_VALUES } from "@/lib/jobs/jobSources";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  deleteJobSourceById,
  updateJobSource,
} from "@/actions/jobSource.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

type JobSourcesTableProps = {
  jobSources: JobSource[];
  reloadJobSources: () => void;
};

function JobSourcesTable({
  jobSources,
  reloadJobSources,
}: JobSourcesTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });
  const [editTarget, setEditTarget] = useState<JobSource | null>(null);

  const onDeleteJobSource = (source: JobSource) => {
    const totalJobs = source._count?.jobsTotal ?? 0;
    if (totalJobs > 0) {
      setAlert({
        openState: true,
        title: t("companies.associatedJobsExist"),
        description: t(
          totalJobs === 1
            ? "library.associatedJobsDescriptionOne"
            : "library.associatedJobsDescriptionMany",
          {
            item: t("library.jobSourceItem"),
            count: totalJobs,
          },
        ),
        deleteAction: false,
      });
    } else {
      setAlert({
        openState: true,
        deleteAction: true,
        itemId: source.id,
      });
    }
  };

  const deleteJobSource = async (sourceId: string) => {
    if (sourceId) {
      const { success, message } = await deleteJobSourceById(sourceId);
      if (success) {
        toastSuccess(t("library.jobSourceDeleted"));
        reloadJobSources();
      } else {
        toastError(message);
      }
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("library.sources")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("library.value")}
            </TableHead>
            <TableHead>{t("library.totalJobs")}</TableHead>
            <TableHead>{t("library.jobsApplied")}</TableHead>
            <TableHead>{t("common.actions")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobSources.map((source: JobSource) => {
            return (
              <TableRow key={source.id}>
                <TableCell className="max-w-[16rem] font-medium">
                  <span className="block truncate" title={source.label}>
                    {source.label}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-[12rem] font-medium sm:table-cell">
                  <span className="block truncate" title={source.value}>
                    {source.value}
                  </span>
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {source._count?.jobsTotal ? (
                    <Link
                      href={`/dashboard/myjobs?source=${encodeURIComponent(source.value)}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {source._count.jobsTotal}
                    </Link>
                  ) : (
                    (source._count?.jobsTotal ?? 0)
                  )}
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {source._count?.jobsApplied ? (
                    <Link
                      href={`/dashboard/myjobs?source=${encodeURIComponent(source.value)}&applied=true`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {source._count.jobsApplied}
                    </Link>
                  ) : (
                    (source._count?.jobsApplied ?? 0)
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-haspopup="true" size="icon" variant="ghost">
                        <MoreVertical className="h-4 w-4" />
                        <span className="sr-only">{t("common.toggleMenu")}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
                      {source._count?.jobsApplied ? (
                        <DropdownMenuItem className="cursor-pointer" asChild>
                          <Link
                            href={`/dashboard/myjobs?source=${encodeURIComponent(source.value)}&applied=true`}
                          >
                            <Briefcase className="mr-2 h-4 w-4" />
                            {t("companies.viewJobs")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      {SYSTEM_JOB_SOURCE_VALUES.includes(source.value) ? null : (
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onClick={() => setEditTarget(source)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          {t("common.edit")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive-text focus:text-destructive-text"
                        onClick={() => onDeleteJobSource(source)}
                      >
                        <Trash className="mr-2 h-4 w-4" />
                        {t("common.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <DictionaryLabelDialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        title={`${t("common.edit")} ${t("library.jobSourceItem")}`}
        fieldLabel={t("common.name")}
        initialLabel={editTarget?.label ?? ""}
        maxLength={APP_CONSTANTS.MAX_JOB_SOURCE_LABEL_LENGTH}
        submit={(label) => updateJobSource(editTarget!.id, label)}
        onSaved={reloadJobSources}
      />
      <DeleteAlertDialog
        pageTitle="source"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteJobSource(alert.itemId!)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default JobSourcesTable;
