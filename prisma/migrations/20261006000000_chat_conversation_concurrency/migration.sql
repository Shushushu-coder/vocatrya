ALTER TABLE "ChatConversation" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatConversation" ADD COLUMN "activeRequestId" TEXT;
ALTER TABLE "ChatConversation" ADD COLUMN "activeRequestExpiresAt" DATETIME;
