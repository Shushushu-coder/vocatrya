"use client";
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
import { Company } from "@/models/job.model";
import {
  Briefcase,
  Building2,
  Eye,
  EyeOff,
  MoreVertical,
  Pencil,
  Trash,
} from "lucide-react";
import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { deleteCompanyById, setCompanyWatched } from "@/actions/company.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { AlertDialog } from "@/models/alertDialog.model";
import { BoardCell } from "./BoardCell";
import { CompanyLogo } from "@/components/myjobs/CompanyLogo";
import { useI18n } from "@/i18n";

type CompaniesTableProps = {
  companies: Company[];
  reloadCompanies: () => void;
  editCompany: (id: string) => void;
  scope?: "mine" | "watchlist";
};

function CompaniesTable({
  companies,
  reloadCompanies,
  editCompany,
  scope = "mine",
}: CompaniesTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });

  const onDeleteCompany = (company: Company) => {
    const totalJobs = company._count?.jobsTotal ?? 0;
    if (totalJobs > 0) {
      setAlert({
        openState: true,
        title: t("companies.associatedJobsExist"),
        description: t(
          totalJobs === 1
            ? "companies.associatedJobsDescriptionOne"
            : "companies.associatedJobsDescriptionMany",
          { count: totalJobs },
        ),
        deleteAction: false,
      });
    } else {
      setAlert({
        openState: true,
        deleteAction: true,
        itemId: company.id,
      });
    }
  };

  const detailsHref = (id: string) =>
    `/dashboard/admin/companies/${id}${scope === "watchlist" ? "?scope=watchlist" : ""}`;

  const toggleWatch = async (company: Company) => {
    const next = !company.watched;
    const res = await setCompanyWatched(company.id, next);
    if (res.success) {
      toastSuccess(
        next
          ? t("companies.addedToWatchlist", { name: company.label })
          : t("companies.removedFromWatchlist", { name: company.label }),
      );
      reloadCompanies();
    } else {
      toastError(res.message);
    }
  };

  const deleteCompany = async (companyId: string | undefined) => {
    if (companyId) {
      const { res, success, message } = await deleteCompanyById(companyId);
      if (success) {
        toastSuccess(t("companies.deletedSuccess"));
        reloadCompanies();
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
            <TableHead className="hidden w-[100px] sm:table-cell">
              <span className="sr-only">{t("companies.companyLogo")}</span>
            </TableHead>
            <TableHead>{t("companies.companyName")}</TableHead>
            {scope === "watchlist" ? (
              <>
                <TableHead>{t("library.board")}</TableHead>
                <TableHead>{t("common.jobs")}</TableHead>
                <TableHead>{t("library.watched")}</TableHead>
              </>
            ) : (
              <>
                <TableHead className="hidden sm:table-cell">
                  {t("library.value")}
                </TableHead>
                <TableHead>{t("library.totalJobs")}</TableHead>
                <TableHead>{t("library.jobsApplied")}</TableHead>
                <TableHead>{t("library.rejected")}</TableHead>
                <TableHead>{t("library.contacts")}</TableHead>
              </>
            )}
            <TableHead>{t("common.actions")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {companies.map((company: Company) => {
            return (
              <TableRow key={company.id}>
                <TableCell className="hidden sm:table-cell">
                  <CompanyLogo
                    logoUrl={company.logoUrl}
                    name={company.label}
                    className="h-8 w-8"
                  />
                </TableCell>
                <TableCell className="max-w-[16rem] font-medium">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Link
                      href={detailsHref(company.id)}
                      title={company.label}
                      className="min-w-0 truncate rounded-sm hover:underline underline-offset-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {company.label}
                    </Link>
                    {company.watched && (
                      <span
                        title={t("companies.onWatchlist")}
                        className="shrink-0 text-success"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </span>
                    )}
                    {scope !== "watchlist" && company.atsToken && (
                      <BoardCell company={company} />
                    )}
                  </span>
                </TableCell>
                {scope === "watchlist" ? (
                  <>
                    <TableCell>
                      <BoardCell company={company} />
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {company._count?.jobsTotal ?? 0}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {company.watchedAt
                        ? formatDistanceToNow(new Date(company.watchedAt), {
                            addSuffix: true,
                          })
                        : "—"}
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell className="hidden max-w-[12rem] font-medium sm:table-cell">
                      <span className="block truncate" title={company.value}>
                        {company.value}
                      </span>
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {company._count?.jobsTotal ? (
                        <Link
                          href={`/dashboard/myjobs?company=${encodeURIComponent(company.value)}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {company._count.jobsTotal}
                        </Link>
                      ) : (
                        (company._count?.jobsTotal ?? 0)
                      )}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {company._count?.jobsApplied ? (
                        <Link
                          href={`/dashboard/myjobs?company=${encodeURIComponent(company.value)}&applied=true`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {company._count.jobsApplied}
                        </Link>
                      ) : (
                        (company._count?.jobsApplied ?? 0)
                      )}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {/* Not computed under the A+B read family — a neutral
                          dash, never a fake zero. */}
                      {company._count?.jobsRejected ?? "—"}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      {company._count?.contacts ?? 0}
                    </TableCell>
                  </>
                )}
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
                      <DropdownMenuItem className="cursor-pointer" asChild>
                        <Link href={detailsHref(company.id)}>
                          <Building2 className="mr-2 h-4 w-4" />
                          {t("companies.viewDetails")}
                        </Link>
                      </DropdownMenuItem>
                      {company._count?.jobsApplied ? (
                        <DropdownMenuItem className="cursor-pointer" asChild>
                          <Link
                            href={`/dashboard/myjobs?company=${encodeURIComponent(company.value)}&applied=true`}
                          >
                            <Briefcase className="mr-2 h-4 w-4" />
                            {t("companies.viewJobs")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => editCompany(company.id)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        {t("companies.editCompany")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => toggleWatch(company)}
                      >
                        {company.watched ? (
                          <EyeOff className="mr-2 h-4 w-4" />
                        ) : (
                          <Eye className="mr-2 h-4 w-4" />
                        )}
                        {company.watched
                          ? t("companies.unwatch")
                          : t("companies.watch")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive-text focus:text-destructive-text"
                        onClick={() => onDeleteCompany(company)}
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
        pageTitle="company"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteCompany(alert.itemId)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default CompaniesTable;
