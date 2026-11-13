"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryDialog } from "@/hooks/useQueryDialog";
import {
  Card,
  CardContent,
  CardFooter,
  CardTitle,
} from "../ui/card";
import { Button } from "../ui/button";
import { PlusCircle } from "lucide-react";
import { SearchInput } from "../SearchInput";
import { ResponsiveCardHeader } from "../ResponsiveCardHeader";
import {
  deleteQuestion,
  getQuestionById,
  getQuestionsList,
  getTagsWithQuestionCounts,
} from "@/actions/question.actions";
import { toastActionResult, toastError } from "@/lib/toast";
import { Question } from "@/models/question.model";
import { Tag } from "@/models/job.model";
import { RecordsCount } from "../RecordsCount";
import { APP_CONSTANTS } from "@/lib/constants";
import Loading from "../Loading";
import { QuestionList } from "./QuestionList";
import { QuestionForm } from "./QuestionForm";
import { TagFilterStrip } from "../TagFilterStrip";
import { useI18n } from "@/i18n";

export type TagQuestionCount = {
  id: string;
  label: string;
  value: string;
  questionCount: number;
};

type QuestionsContainerProps = {
  availableTags: Tag[];
  filterKey?: string;
  onFilterChange?: (filter: string | undefined) => void;
  initialTagCounts?: TagQuestionCount[];
  initialTotal?: number;
  onQuestionsChanged?: () => void;
};

function QuestionsContainer({
  availableTags,
  filterKey,
  onFilterChange,
  initialTagCounts,
  initialTotal,
  onQuestionsChanged,
}: QuestionsContainerProps) {
  const { t } = useI18n();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [page, setPage] = useState(1);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [tagCounts, setTagCounts] = useState<TagQuestionCount[]>(
    initialTagCounts ?? [],
  );
  const [tagTotal, setTagTotal] = useState(initialTotal ?? 0);
  const [editQuestion, setEditQuestion] = useState<Question | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  useQueryDialog("add-question", () => {
    setEditQuestion(null);
    setDialogOpen(true);
  });
  const [searchTerm, setSearchTerm] = useState("");
  const countsRequest = useRef(0);
  const currentCountSearch = useRef("");
  currentCountSearch.current = searchTerm;
  const hasSearched = useRef(false);

  const loadQuestions = useCallback(
    async (pageNum: number, filter?: string, search?: string) => {
      setLoading(true);
      const result = await getQuestionsList(
        pageNum,
        APP_CONSTANTS.RECORDS_PER_PAGE,
        filter,
        search,
      );
      if (result?.success && result.data) {
        setQuestions((prev) =>
          pageNum === 1 ? result.data : [...prev, ...result.data],
        );
        setTotalQuestions(result.total);
        setPage(pageNum);
      } else {
        toastError(result?.message || t("questions.failedToLoad"));
      }
      setLoading(false);
    },
    [t],
  );

  // Per-tag chip counts apply every other active filter (search) but never
  // the current tag restriction itself, so the strip stays usable while a
  // tag is selected.
  const refreshTagCounts = useCallback(async (search?: string) => {
    if ((search ?? "") !== currentCountSearch.current) return;
    const request = ++countsRequest.current;
    const result = await getTagsWithQuestionCounts({ search });
    if (result?.success && request === countsRequest.current && (search ?? "") === currentCountSearch.current) {
      setTagCounts(result.data);
      setTagTotal(result.totalQuestions);
    }
  }, []);

  const reloadQuestions = useCallback(async () => {
    await loadQuestions(1, filterKey, searchTerm || undefined);
    await refreshTagCounts(searchTerm || undefined);
    onQuestionsChanged?.();
  }, [loadQuestions, filterKey, searchTerm, refreshTagCounts, onQuestionsChanged]);

  const onDeleteQuestion = async (questionId: string) => {
    const result = await deleteQuestion(questionId);
    toastActionResult(result, {
      success: t("questions.questionDeleted"),
      onSuccess: () => reloadQuestions(),
    });
  };

  const onEditQuestion = async (question: Question) => {
    const { data, success, message } = await getQuestionById(question.id);
    if (!success) {
      toastError(message);
      return;
    }
    setEditQuestion(data);
    setDialogOpen(true);
  };

  const addQuestionForm = () => {
    setEditQuestion(null);
    setDialogOpen(true);
  };

  useEffect(() => {
    loadQuestions(1, filterKey, searchTerm || undefined);
    refreshTagCounts(searchTerm || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadQuestions, filterKey, refreshTagCounts]);

  // Debounced search
  useEffect(() => {
    if (searchTerm !== "") {
      hasSearched.current = true;
    }
    if (searchTerm === "" && !hasSearched.current) return;

    const timer = setTimeout(() => {
      loadQuestions(1, filterKey, searchTerm || undefined);
      refreshTagCounts(searchTerm || undefined);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  return (
    <>
      <Card className="h-full">
        <ResponsiveCardHeader>
          <div className="flex items-baseline gap-2">
            <CardTitle>{t("questions.title")}</CardTitle>
            {!loading && totalQuestions > 0 && (
              <RecordsCount
                count={questions.length}
                total={totalQuestions}
                label={t("questions.recordsLabel")}
              />
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
            <SearchInput
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder={t("questions.searchPlaceholder")}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1"
              onClick={addQuestionForm}
            >
              <PlusCircle className="h-3.5 w-3.5" />
              <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
                {t("questions.newQuestion")}
              </span>
            </Button>
          </div>
        </ResponsiveCardHeader>
        <CardContent>
          <TagFilterStrip
            className="mb-3"
            title={t("questions.skillTags")}
            items={tagCounts.map((tag) => ({
              id: tag.id,
              label: tag.label,
              count: tag.questionCount,
            }))}
            totalCount={tagTotal}
            selectedId={filterKey}
            onSelect={(id) => onFilterChange?.(id)}
          />
          {loading && <Loading />}
          {!loading && (
            <>
              <QuestionList
                questions={questions}
                onEdit={onEditQuestion}
                onDelete={onDeleteQuestion}
              />
            </>
          )}
          {!loading && questions.length < totalQuestions && (
            <div className="flex justify-center p-4">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  loadQuestions(page + 1, filterKey, searchTerm || undefined)
                }
                disabled={loading}
              >
                {t("questions.loadMore")}
              </Button>
            </div>
          )}
        </CardContent>
        <CardFooter></CardFooter>
      </Card>
      <QuestionForm
        availableTags={availableTags}
        editQuestion={editQuestion}
        resetEditQuestion={() => setEditQuestion(null)}
        onQuestionSaved={reloadQuestions}
        dialogOpen={dialogOpen}
        setDialogOpen={setDialogOpen}
      />
    </>
  );
}

export default QuestionsContainer;
