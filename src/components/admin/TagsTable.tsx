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
import { Tag } from "@/models/job.model";
import { MoreVertical, Trash } from "lucide-react";
import { useState } from "react";
import { deleteTagById } from "@/actions/tag.actions";
import { toastSuccess, toastError } from "@/lib/toast";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { AlertDialog } from "@/models/alertDialog.model";
import { useI18n } from "@/i18n";

type TagsTableProps = {
  tags: Tag[];
  reloadTags: () => void;
};

function TagsTable({ tags, reloadTags }: TagsTableProps) {
  const { t } = useI18n();
  const [alert, setAlert] = useState<AlertDialog>({
    openState: false,
    deleteAction: false,
  });

  const onDeleteTag = (tag: Tag) => {
    const jobCount = tag._count?.jobs ?? 0;
    const questionCount = tag._count?.questions ?? 0;
    const skillCount = tag._count?.skills ?? 0;

    if (jobCount > 0 || questionCount > 0 || skillCount > 0) {
      const links = [
        jobCount > 0
          ? t(jobCount === 1 ? "library.jobCountOne" : "library.jobCountMany", {
              count: jobCount,
            })
          : "",
        questionCount > 0
          ? t(
              questionCount === 1
                ? "library.questionCountOne"
                : "library.questionCountMany",
              { count: questionCount },
            )
          : "",
        skillCount > 0
          ? t(
              skillCount === 1
                ? "library.skillCountOne"
                : "library.skillCountMany",
              { count: skillCount },
            )
          : "",
      ]
        .filter(Boolean)
        .join(t("library.listSeparator"));

      setAlert({
        openState: true,
        title: t("library.itemInUseTitle", {
          item: t("library.skillItem"),
        }),
        description: t("library.itemInUseDescription", {
          item: t("library.skillItem"),
          links,
        }),
        deleteAction: false,
      });
    } else {
      setAlert({
        openState: true,
        deleteAction: true,
        itemId: tag.id,
      });
    }
  };

  const deleteTag = async (tagId: string | undefined) => {
    if (!tagId) return;
    const { success, message } = await deleteTagById(tagId);
    if (success) {
      toastSuccess(t("library.skillDeleted"));
      reloadTags();
    } else {
      toastError(message);
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("library.skillLabel")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("library.value")}
            </TableHead>
            <TableHead>{t("library.totalJobs")}</TableHead>
            <TableHead>{t("library.questionsCount")}</TableHead>
            <TableHead>{t("common.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tags.map((tag: Tag) => (
            <TableRow key={tag.id}>
              <TableCell className="font-medium">{tag.label}</TableCell>
              <TableCell className="font-medium hidden sm:table-cell">
                {tag.value}
              </TableCell>
              <TableCell className="font-medium">
                {tag._count?.jobs ?? 0}
              </TableCell>
              <TableCell className="font-medium">
                {tag._count?.questions ?? 0}
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
                    <DropdownMenuItem
                      className="text-red-600 cursor-pointer"
                      onClick={() => onDeleteTag(tag)}
                    >
                      <Trash className="mr-2 h-4 w-4" />
                      {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <DeleteAlertDialog
        pageTitle="skill"
        open={alert.openState}
        onOpenChange={() => setAlert({ openState: false, deleteAction: false })}
        onDelete={() => deleteTag(alert.itemId)}
        alertTitle={alert.title}
        alertDescription={alert.description}
        deleteAction={alert.deleteAction}
      />
    </>
  );
}

export default TagsTable;
