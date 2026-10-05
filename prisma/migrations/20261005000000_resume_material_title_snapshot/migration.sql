-- Captures titles observable at migration time, NOT original frozen historical titles.
ALTER TABLE "ResumeVariantSectionItem" ADD COLUMN "materialTitleSnapshot" TEXT;
UPDATE "ResumeVariantSectionItem"
SET "materialTitleSnapshot" = (
  SELECT "title" FROM "CareerMaterialItem"
  WHERE "CareerMaterialItem"."id" = "ResumeVariantSectionItem"."careerMaterialItemId"
)
WHERE EXISTS (
  SELECT 1 FROM "CareerMaterialItem"
  WHERE "CareerMaterialItem"."id" = "ResumeVariantSectionItem"."careerMaterialItemId"
);
