-- P2 interview debrief: explicit completion mark and question-source link.
-- Additive only. Existing rows stay NULL (draft / no recorded source).
ALTER TABLE "ApplicationInterviewDetail" ADD COLUMN "reflectionCompletedAt" DATETIME;

ALTER TABLE "ApplicationInterviewReflectionItem" ADD COLUMN "sourceQuestionId" TEXT REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApplicationInterviewReflectionItem" ADD COLUMN "sourceKind" TEXT;

CREATE INDEX "ApplicationInterviewReflectionItem_sourceQuestionId_idx" ON "ApplicationInterviewReflectionItem"("sourceQuestionId");
