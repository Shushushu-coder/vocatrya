-- M2.1 memory curation provenance + managed-path frozen snapshot.
-- `source` distinguishes USER_MANUAL (hand-written/edited in settings,
-- locked against AI curation) from AI_EXTRACTED (background curation may
-- upsert/merge/remove). M2 rows predate the flag: the extractor always
-- stamped sourceConversationId while manual writes never did, so the
-- pointer is the backfill discriminator.
ALTER TABLE "UserMemoryEntry" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'USER_MANUAL';
UPDATE "UserMemoryEntry" SET "source" = 'AI_EXTRACTED' WHERE "sourceConversationId" IS NOT NULL;

-- M2.1: the managed-path long-term-memory block frozen for this
-- conversation's session. NULL = never frozen yet (first turn computes
-- and persists it). Refreshed on L2 auto/manual compaction, on the user's
-- manual memory edits, and on the master-switch toggle — never by
-- background extraction, so the assembled prefix stays byte-stable for
-- the provider's prompt cache between those events.
ALTER TABLE "ChatConversation" ADD COLUMN "managedMemoryBlock" TEXT;
