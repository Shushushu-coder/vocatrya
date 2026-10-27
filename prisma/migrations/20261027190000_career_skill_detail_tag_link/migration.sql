-- Additive schema change via an atomic table rebuild. Existing rows keep
-- tagId = NULL; no backfill, no
-- name-based association. SetNull is the database safety net only —
-- deleteTagById's reference guard is the normal protection.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE "new_CareerSkillDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialItemId" TEXT NOT NULL,
    "skillName" TEXT,
    "proficiency" TEXT,
    "tagId" TEXT,
    "structuredData" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CareerSkillDetail_materialItemId_fkey" FOREIGN KEY ("materialItemId") REFERENCES "CareerMaterialItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CareerSkillDetail_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CareerSkillDetail" ("createdAt", "id", "materialItemId", "proficiency", "skillName", "structuredData", "updatedAt") SELECT "createdAt", "id", "materialItemId", "proficiency", "skillName", "structuredData", "updatedAt" FROM "CareerSkillDetail";
DROP TABLE "CareerSkillDetail";
ALTER TABLE "new_CareerSkillDetail" RENAME TO "CareerSkillDetail";
CREATE UNIQUE INDEX "CareerSkillDetail_materialItemId_key" ON "CareerSkillDetail"("materialItemId");
CREATE INDEX "CareerSkillDetail_tagId_idx" ON "CareerSkillDetail"("tagId");
COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
