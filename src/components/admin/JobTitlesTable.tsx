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
import { JobTitle } from "@/models/job.model";
import { Briefcase, MoreVertical, Pencil, Trash } from "lucide-react";
import Link from "next/link";
import { AlertDialog } from "@/models/alertDialog.model";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import DictionaryLabelDialog from "./DictionaryLabelDialog";
import {
  deleteJobTitleById,
  updateJobTitle,
} from "@/actions/jobtitle.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

type JobTitlesTableProps = {
  jobTitles: JobTitle[];
  reloadJobTitles: () => void;
};

function JobTitlesTable({ jobTitles, reloadJobTitles }: JobTitlesTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });
  const [editTarget, setEditTarget] = useState<JobTitle | null>(null);

  const onDeleteJobTitle = (title: JobTitle) => {
    const totalJobs = title._count?.jobsTotal ?? 0;
    if (totalJobs > 0) {
      setAlert({
        openState: true,
        title: t("companies.associatedJobsExist"),
        description: t(
          totalJobs === 1
            ? "library.associatedJobsDescriptionOne"
            : "library.associatedJobsDescriptionMany",
          {
            item: t("library.jobTitleItem"),
            count: totalJobs,
          },
        ),
        deleteAction: false,
      });
    } else {
      setAlert({
        openState: true,
        deleteAction: true,
        itemId: title.id,
      });
    }
  };
  const deleteJobTitle = async (titleId: string) => {
    if (titleId) {
      const { success, message } = await deleteJobTitleById(titleId);
      if (success) {
        toastSuccess(t("library.jobTitleDeleted"));
        reloadJobTitles();
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
            <TableHead>{t("jobs.jobTitle")}</TableHead>
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
          {jobTitles.map((title: JobTitle) => {
            return (
              <TableRow key={title.id}>
                <TableCell className="max-w-[16rem] font-medium">
                  <span className="block truncate" title={title.label}>
                    {title.label}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-[12rem] font-medium sm:table-cell">
                  <span className="block truncate" title={title.value}>
                    {title.value}
                  </span>
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {title._count?.jobsTotal ? (
                    <Link
                      href={`/dashboard/myjobs?title=${encodeURIComponent(title.value)}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {title._count.jobsTotal}
                    </Link>
                  ) : (
                    (title._count?.jobsTotal ?? 0)
                  )}
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {title._count?.jobs ? (
                    <Link
                      href={`/dashboard/myjobs?title=${encodeURIComponent(title.value)}&applied=true`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {title._count.jobs}
                    </Link>
                  ) : (
                    (title._count?.jobs ?? 0)
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
                      {title._count?.jobs ? (
                        <DropdownMenuItem className="cursor-pointer" asChild>
                          <Link
                            href={`/dashboard/myjobs?title=${encodeURIComponent(title.value)}&applied=true`}
                          >
                            <Briefcase className="mr-2 h-4 w-4" />
                            {t("companies.viewJobs")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => setEditTarget(title)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        {t("common.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive-text focus:text-destructive-text"
                        onClick={() => onDeleteJobTitle(title)}
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
        title={`${t("common.edit")} ${t("library.jobTitleItem")}`}
        fieldLabel={t("common.name")}
        initialLabel={editTarget?.label ?? ""}
        submit={(label) => updateJobTitle(editTarget!.id, label)}
        onSaved={reloadJobTitles}
      />
      <DeleteAlertDialog
        pageTitle="title"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteJobTitle(alert.itemId!)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default JobTitlesTable;
