ALTER TABLE "ResumeVariantSection" ADD COLUMN "hiddenAt" DATETIME;
ALTER TABLE "ResumeVariantSection" ADD COLUMN "originRefId" TEXT;
ALTER TABLE "ResumeVariantSectionItem" ADD COLUMN "hiddenAt" DATETIME;
ALTER TABLE "ResumeVariantSectionItem" ADD COLUMN "originRefId" TEXT;
ALTER TABLE "ResumeExpression" ADD COLUMN "hiddenAt" DATETIME;
ALTER TABLE "ResumeExpression" ADD COLUMN "originRefId" TEXT;
