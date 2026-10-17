"use client";
import { useState } from "react";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
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
import { JobLocation } from "@/models/job.model";
import { Briefcase, MoreVertical, Trash } from "lucide-react";
import Link from "next/link";
import { AlertDialog } from "@/models/alertDialog.model";
import { toastSuccess, toastError } from "@/lib/toast";
import { deleteJobLocationById } from "@/actions/jobLocation.actions";
import { useI18n } from "@/i18n";

type JobLocationsTableProps = {
  jobLocations: JobLocation[];
  reloadJobLocations: () => void;
};

function JobLocationsTable({
  jobLocations,
  reloadJobLocations,
}: JobLocationsTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });
  const onDeleteJobLocation = (location: JobLocation) => {
    const totalJobs = location._count?.jobsTotal ?? 0;
    if (totalJobs > 0) {
      setAlert({
        openState: true,
        title: t("companies.associatedJobsExist"),
        description: t(
          totalJobs === 1
            ? "library.associatedJobsDescriptionOne"
            : "library.associatedJobsDescriptionMany",
          {
            item: t("library.jobLocationItem"),
            count: totalJobs,
          },
        ),
        deleteAction: false,
      });
    } else {
      setAlert({
        openState: true,
        deleteAction: true,
        itemId: location.id,
      });
    }
  };
  const deleteJobLocation = async (locationId: string) => {
    if (locationId) {
      const { success, message } = await deleteJobLocationById(locationId);
      if (success) {
        toastSuccess(t("library.jobLocationDeleted"));
        reloadJobLocations();
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
            <TableHead>{t("common.location")}</TableHead>
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
          {jobLocations.map((location: JobLocation) => {
            return (
              <TableRow key={location.id}>
                <TableCell className="max-w-[16rem] font-medium">
                  <span className="block truncate" title={location.label}>
                    {location.label}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-[12rem] font-medium sm:table-cell">
                  <span className="block truncate" title={location.value}>
                    {location.value}
                  </span>
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {location._count?.jobsTotal ? (
                    <Link
                      href={`/dashboard/myjobs?location=${encodeURIComponent(location.value)}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {location._count.jobsTotal}
                    </Link>
                  ) : (
                    (location._count?.jobsTotal ?? 0)
                  )}
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {location._count?.jobsApplied ? (
                    <Link
                      href={`/dashboard/myjobs?location=${encodeURIComponent(location.value)}&applied=true`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {location._count.jobsApplied}
                    </Link>
                  ) : (
                    (location._count?.jobsApplied ?? 0)
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
                      {location._count?.jobsApplied ? (
                        <DropdownMenuItem className="cursor-pointer" asChild>
                          <Link
                            href={`/dashboard/myjobs?location=${encodeURIComponent(location.value)}&applied=true`}
                          >
                            <Briefcase className="mr-2 h-4 w-4" />
                            {t("companies.viewJobs")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive-text focus:text-destructive-text"
                        onClick={() => onDeleteJobLocation(location)}
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
      <DeleteAlertDialog
        pageTitle="location"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteJobLocation(alert.itemId!)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default JobLocationsTable;
