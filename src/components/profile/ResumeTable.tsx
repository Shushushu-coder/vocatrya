"use client";
import {
  Copy,
  FileDown,
  FilePenLine,
  MoreVertical,
  Paperclip,
  Pencil,
  Star,
  Trash,
} from "lucide-react";
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
import { ProfileDocument } from "@/models/profile.model";
import Link from "next/link";
import { Button } from "../ui/button";
import { useMemo, useState } from "react";
import { toastSuccess, toastError } from "@/lib/toast";
import { deleteResumeById, setDefaultResume } from "@/actions/profile.actions";
import { deleteCoverLetterById } from "@/actions/coverLetter.actions";
import { DeleteAlertDialog } from "../DeleteAlertDialog";
import { Badge } from "../ui/badge";
import { StatusBadge } from "../StatusBadge";
import { DOCUMENT_TYPE_BADGE_COLORS } from "@/lib/badge-colors";
import {
  hasMinResumeSections,
  warnInsufficientResumeSections,
} from "@/utils/resumeSections.utils";
import { useI18n } from "@/i18n";

type DocumentTableProps = {
  documents: ProfileDocument[];
  editResume: (doc: ProfileDocument) => void;
  editCoverLetter: (doc: ProfileDocument) => void;
  exportCoverLetter: (doc: ProfileDocument) => void;
  copyResume: (doc: ProfileDocument) => void;
  reloadDocuments: () => void;
  defaultResumeId?: string | null;
};

function DocumentTable({
  documents,
  editResume,
  editCoverLetter,
  exportCoverLetter,
  copyResume,
  reloadDocuments,
  defaultResumeId,
}: DocumentTableProps) {
  const { t, formatDate } = useI18n();
  const [alertOpen, setAlertOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<ProfileDocument>();
  const [setDefaultConfirmOpen, setSetDefaultConfirmOpen] = useState(false);
  const [documentToSetDefault, setDocumentToSetDefault] =
    useState<ProfileDocument>();
  const onDeleteDocument = useMemo(
    () => (doc: ProfileDocument) => {
      if (!doc.id) return;
      setAlertOpen(true);
      setDocumentToDelete(doc);
    },
    [],
  );

  // Title of the current default, if it happens to be on a loaded page — used
  // only to enrich the confirm copy. Presence of a default is decided by
  // defaultResumeId, which is reliable regardless of pagination.
  const currentDefault = useMemo(
    () => documents.find((d) => d.type === "resume" && d.isDefault),
    [documents],
  );

  const performSetDefault = async (doc: ProfileDocument) => {
    if (!doc.id) return;
    const { success, message } = await setDefaultResume(doc.id);
    if (success) {
      toastSuccess(t("profile.defaultNow", { title: doc.title }));
      reloadDocuments();
    } else {
      toastError(message);
    }
  };

  const onSetDefault = (doc: ProfileDocument) => {
    if (!doc.id) return;
    if (!hasMinResumeSections(doc.sectionCount)) {
      warnInsufficientResumeSections("setting this resume as default");
      return;
    }
    // Confirm whenever a different resume already holds the default. Decided by
    // defaultResumeId (not the loaded-docs lookup) so it fires even when the
    // current default lives on a not-yet-loaded page.
    if (defaultResumeId && defaultResumeId !== doc.id) {
      setDocumentToSetDefault(doc);
      setSetDefaultConfirmOpen(true);
    } else {
      performSetDefault(doc);
    }
  };

  const onCopyResume = (doc: ProfileDocument) => {
    if (!doc.id) return;
    if (!hasMinResumeSections(doc.sectionCount)) {
      warnInsufficientResumeSections("creating a copy");
      return;
    }
    copyResume(doc);
  };

  const deleteDocument = async (doc: ProfileDocument) => {
    if (!doc.id) return;
    if (doc.jobCount > 0) {
      const label =
        doc.type === "resume"
          ? t("profile.resumeLabel")
          : t("profile.coverLetterLabel");
      return toastError(t("profile.jobsUsingMustBeZero", { label }));
    }

    const { success, message } =
      doc.type === "resume"
        ? await deleteResumeById(doc.id)
        : await deleteCoverLetterById(doc.id);

    if (success) {
      toastSuccess(
        doc.type === "resume"
          ? t("profile.resumeDeleted")
          : t("profile.coverLetterDeleted"),
      );
      reloadDocuments();
    } else {
      toastError(message);
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("common.title")}</TableHead>
            <TableHead className="whitespace-nowrap">{t("common.type")}</TableHead>
            <TableHead className="whitespace-nowrap">
              {t("common.created")}
            </TableHead>
            <TableHead className="hidden md:table-cell whitespace-nowrap">
              {t("common.updated")}
            </TableHead>
            <TableHead>{t("profile.jobsCount")}</TableHead>
            <TableHead>{t("common.actions")}</TableHead>
            <TableHead>
              <span className="sr-only">{t("common.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((doc) => {
            const isResume = doc.type === "resume";
            return (
              <TableRow key={`${doc.type}-${doc.id}`}>
                <TableCell className="font-medium">
                  {isResume ? (
                    <Link
                      href={`/dashboard/profile/resume/${doc.id}`}
                      className="flex items-center"
                    >
                      {doc.title}
                      {doc.FileId ? (
                        <Paperclip className="h-3.5 w-3.5 ml-1" />
                      ) : null}
                      {doc.isDefault ? (
                        <Badge className="ml-2 border-transparent bg-green-600 text-white hover:bg-green-600/90">
                          {t("profile.defaultResume")}
                        </Badge>
                      ) : null}
                    </Link>
                  ) : (
                    <button
                      className="text-left hover:underline"
                      onClick={() => editCoverLetter(doc)}
                    >
                      {doc.title}
                    </button>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <StatusBadge
                    label={
                      isResume
                        ? t("profile.resume")
                        : t("profile.coverLetter")
                    }
                    color={DOCUMENT_TYPE_BADGE_COLORS[doc.type]}
                  />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {doc.createdAt && formatDate(doc.createdAt)}
                </TableCell>
                <TableCell className="hidden md:table-cell whitespace-nowrap">
                  {doc.updatedAt && formatDate(doc.updatedAt)}
                </TableCell>
                <TableCell>{doc.jobCount}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-haspopup="true"
                        size="icon"
                        variant="ghost"
                        data-testid="document-actions-menu-btn"
                      >
                        <MoreVertical className="h-4 w-4" />
                        <span className="sr-only">{t("common.toggleMenu")}</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>{t("common.actions")}</DropdownMenuLabel>
                      {isResume ? (
                        <>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => editResume(doc)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            {t("profile.editResumeTitle")}
                          </DropdownMenuItem>
                          <Link href={`/dashboard/profile/resume/${doc.id}`}>
                            <DropdownMenuItem className="cursor-pointer">
                              <FilePenLine className="mr-2 h-4 w-4" />
                              {t("profile.viewEditResume")}
                            </DropdownMenuItem>
                          </Link>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => onCopyResume(doc)}
                            data-testid="copy-resume-menu-item"
                          >
                            <Copy className="mr-2 h-4 w-4" />
                            {t("profile.createACopy")}
                          </DropdownMenuItem>
                          {!doc.isDefault && (
                            <DropdownMenuItem
                              className="cursor-pointer"
                              onClick={() => onSetDefault(doc)}
                            >
                              <Star className="mr-2 h-4 w-4" />
                              {t("profile.setAsDefaultLower")}
                            </DropdownMenuItem>
                          )}
                        </>
                      ) : (
                        <>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => editCoverLetter(doc)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            {t("profile.editCoverLetter")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => exportCoverLetter(doc)}
                            data-testid="export-cover-letter-menu-item"
                          >
                            <FileDown className="mr-2 h-4 w-4" />
                            {t("profile.exportToPdf")}
                          </DropdownMenuItem>
                        </>
                      )}
                      <DropdownMenuItem
                        className="text-red-600 cursor-pointer"
                        onClick={() => onDeleteDocument(doc)}
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
        pageTitle={
          documentToDelete?.type === "cover-letter"
            ? t("profile.coverLetterLabel")
            : t("profile.resumeLabel")
        }
        open={alertOpen}
        onOpenChange={setAlertOpen}
        onDelete={() => deleteDocument(documentToDelete!)}
        alertDescription={
          documentToDelete?.isDefault
            ? t("profile.deleteDefaultResumeDescription")
            : undefined
        }
      />
      <DeleteAlertDialog
        pageTitle={t("profile.resumeLabel")}
        open={setDefaultConfirmOpen}
        onOpenChange={setSetDefaultConfirmOpen}
        onDelete={() => performSetDefault(documentToSetDefault!)}
        alertTitle={t("profile.changeDefaultResume")}
        alertDescription={
          currentDefault
            ? t("profile.replaceDefaultNamed", {
                newTitle: documentToSetDefault?.title ?? "",
                currentTitle: currentDefault.title,
              })
            : t("profile.replaceDefaultUnnamed", {
                newTitle: documentToSetDefault?.title ?? "",
              })
        }
        actionLabel={t("profile.setAsDefaultLower")}
        actionVariant="default"
      />
    </>
  );
}

export default DocumentTable;
