"use client";
import { useState } from "react";
import { Question } from "@/models/question.model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuestionTagBadge } from "@/components/questions/QuestionTagBadge";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import { hasDescription } from "@/lib/tasks/description";
import { useI18n } from "@/i18n";

type QuestionCardProps = {
  question: Question;
  onEdit: (question: Question) => void;
  onDelete: (questionId: string) => void;
};

export function QuestionCard({
  question,
  onEdit,
  onDelete,
}: QuestionCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const hasAnswer = hasDescription(question.answer);

  return (
    <>
      <div
        className="border rounded-lg p-4 hover:bg-accent/50 transition-colors"
        data-testid="question-card"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium flex-1">{question.question}</h3>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(question);
              }}
              data-testid="question-edit-btn"
            >
              <Pencil className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">{t("common.edit")}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-destructive hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setShowDeleteDialog(true);
              }}
              data-testid="question-delete-btn"
            >
              <Trash2 className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">{t("common.delete")}</span>
            </Button>
          </div>
        </div>

        {hasAnswer && (
          <Collapsible open={expanded} onOpenChange={setExpanded} className="mt-2">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-1 px-0" data-testid="question-answer-toggle">
                <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                <span>{t("questions.answer")}</span>
                <span className="text-xs text-muted-foreground">{expanded ? t("questions.showLess") : t("questions.showMore")}</span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 text-sm text-muted-foreground prose prose-sm max-w-none dark:prose-invert">
              <TipTapContentViewer content={question.answer!} />
            </CollapsibleContent>
          </Collapsible>
        )}

        {question.tags && question.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {question.tags.map((tag) => (
              <QuestionTagBadge key={tag.id}>{tag.label}</QuestionTagBadge>
            ))}
          </div>
        )}

        {question.createdVia && (
          <div className="mt-2">
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {t("questions.viaSource", { source: question.createdVia })}
            </Badge>
          </div>
        )}

      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("questions.deleteQuestion")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("questions.deleteQuestionConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onDelete(question.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
