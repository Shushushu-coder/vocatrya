"use client";
import QuestionsContainer, {
  type TagQuestionCount,
} from "@/components/questions/QuestionsContainer";
import { Tag } from "@/models/job.model";
import { useState } from "react";

type QuestionsPageClientProps = {
  allTags: Tag[];
  tagsWithCounts: TagQuestionCount[];
  totalQuestions: number;
};

function QuestionsPageClient({
  allTags,
  tagsWithCounts,
  totalQuestions,
}: QuestionsPageClientProps) {
  const [filterKey, setFilterKey] = useState<string | undefined>(undefined);

  return (
    <div className="col-span-3 h-full">
      <QuestionsContainer
        availableTags={allTags}
        filterKey={filterKey}
        onFilterChange={setFilterKey}
        initialTagCounts={tagsWithCounts}
        initialTotal={totalQuestions}
      />
    </div>
  );
}

export default QuestionsPageClient;
