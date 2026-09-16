import QuestionsPageClient from "./QuestionsPageClient";
import { getTagsWithQuestionCounts } from "@/actions/question.actions";
import { getAllTags } from "@/actions/tag.actions";
import React from "react";
import { getServerI18n } from "@/i18n/server";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return { title: t("nav.questions") };
}

async function Questions() {
  const [allTags, tagsWithCounts] = await Promise.all([
    getAllTags(),
    getTagsWithQuestionCounts(),
  ]);

  return (
    <QuestionsPageClient
      allTags={allTags || []}
      tagsWithCounts={tagsWithCounts?.data || []}
      totalQuestions={tagsWithCounts?.totalQuestions || 0}
    />
  );
}

export default Questions;
