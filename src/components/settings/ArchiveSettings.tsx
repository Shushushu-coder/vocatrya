"use client";

import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, Info, Search } from "lucide-react";
import type { UIMessage } from "ai";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { toastActionResult, toastError } from "@/lib/toast";
import {
  listArchivedJobs,
  restoreArchivedJob,
  type ArchivedJobItem,
} from "@/actions/archive.actions";
import {
  getChatConversation,
  listArchivedChatConversations,
  restoreChatConversation,
} from "@/actions/agentChat.actions";
import Link from "next/link";

type ArchivedConversationItem = {
  id: string;
  title: string | null;
  titleFallback: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function transcriptBlocks(message: UIMessage): string[] {
  const blocks: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push(part.text);
    } else if (
      typeof part.type === "string" &&
      part.type.startsWith("tool-")
    ) {
      blocks.push(`[${part.type.replace(/^tool-/, "")}]`);
    }
  }
  return blocks;
}

export default function ArchiveSettings() {
  const { t, formatDateTime } = useI18n();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [surface, setSurface] = useState<"ab" | "legacy" | "blocked">("ab");
  const [jobs, setJobs] = useState<ArchivedJobItem[]>([]);
  const [conversations, setConversations] = useState<
    ArchivedConversationItem[]
  >([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{
    title: string;
    messages: UIMessage[];
  } | null>(null);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const [jobResult, conversationResult] = await Promise.all([
        listArchivedJobs({ search: query || undefined }),
        listArchivedChatConversations({ search: query || undefined }),
      ]);
      if (jobResult.success && jobResult.data) {
        setSurface(jobResult.data.kind);
        setJobs(jobResult.data.kind === "ab" ? jobResult.data.jobs : []);
      } else if (!jobResult.success) {
        toastError(jobResult.message);
      }
      if (conversationResult.success && conversationResult.data) {
        setConversations(conversationResult.data);
      } else if (!conversationResult.success) {
        toastError(conversationResult.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(search);
  }, [load, search]);

  const onRestoreJob = async (id: string) => {
    setRestoringId(id);
    try {
      const result = await restoreArchivedJob(id);
      toastActionResult(result, {
        success: t("settings.archiveRestored"),
        onSuccess: () => void load(search),
      });
    } finally {
      setRestoringId(null);
    }
  };

  const onRestoreConversation = async (id: string) => {
    setRestoringId(id);
    try {
      const result = await restoreChatConversation(id);
      toastActionResult(result, {
        success: t("settings.archiveRestored"),
        onSuccess: () => void load(search),
      });
    } finally {
      setRestoringId(null);
    }
  };

  const onViewConversation = async (id: string) => {
    const result = await getChatConversation(id);
    if (!result.success || !result.data) {
      toastError(result.message);
      return;
    }
    setViewer({
      title:
        result.data.title ??
        result.data.titleFallback ??
        t("agent.untitledConversation"),
      messages: result.data.messages,
    });
  };

  return (
    <div className="space-y-6" data-testid="archive-settings">
      <p className="text-sm text-muted-foreground">
        {t("settings.archiveDescription")}
      </p>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder={t("settings.archiveSearchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          data-testid="archive-search-input"
        />
      </div>

      <Card className="p-4">
        <h3 className="mb-3 font-medium">{t("settings.archiveJobsHeading")}</h3>
        {surface === "legacy" ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-muted-foreground/25 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{t("settings.archiveLegacyNotice")}</p>
          </div>
        ) : surface === "blocked" ? (
          <p className="text-sm text-muted-foreground">
            {t("errors.careerJobsUnavailable")}
          </p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.archiveEmpty")}
          </p>
        ) : (
          <ul className="divide-y">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex items-center gap-3 py-2.5"
                data-testid="archived-job-row"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {job.title}
                    <span className="font-normal text-muted-foreground">
                      {job.company ? ` · ${job.company}` : ""}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.archiveArchivedAt", {
                      date: formatDateTime(new Date(job.archivedAt)),
                    })}
                  </p>
                </div>
                <Badge variant="secondary">{t("settings.archivedBadge")}</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                  data-testid="archived-job-view"
                >
                  <Link href={`/dashboard/myjobs/${job.id}`}>
                    {t("common.view")}
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restoringId !== null}
                  onClick={() => void onRestoreJob(job.id)}
                  data-testid="archived-job-restore"
                >
                  <ArchiveRestore className="h-3.5 w-3.5 sm:mr-1.5" />
                  {t("settings.archiveRestore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 font-medium">
          {t("settings.archiveConversationsHeading")}
        </h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : conversations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("settings.archiveEmpty")}
          </p>
        ) : (
          <ul className="divide-y">
            {conversations.map((conversation) => (
              <li
                key={conversation.id}
                className="flex items-center gap-3 py-2.5"
                data-testid="archived-conversation-row"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {conversation.title ??
                      conversation.titleFallback ??
                      t("agent.untitledConversation")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {conversation.archivedAt
                      ? t("settings.archiveArchivedAt", {
                          date: formatDateTime(
                            new Date(conversation.archivedAt),
                          ),
                        })
                      : ""}
                  </p>
                </div>
                <Badge variant="secondary">{t("settings.archivedBadge")}</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onViewConversation(conversation.id)}
                  data-testid="archived-conversation-view"
                >
                  {t("common.view")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restoringId !== null}
                  onClick={() => void onRestoreConversation(conversation.id)}
                  data-testid="archived-conversation-restore"
                >
                  <ArchiveRestore className="h-3.5 w-3.5 sm:mr-1.5" />
                  {t("settings.archiveRestore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={viewer !== null} onOpenChange={(open) => !open && setViewer(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {viewer?.title}
              <Badge variant="secondary">{t("settings.archivedBadge")}</Badge>
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t("settings.archiveReadOnlyNotice")}
          </p>
          <div className="space-y-3" data-testid="archived-transcript">
            {viewer?.messages.map((message) => {
              const blocks = transcriptBlocks(message);
              if (blocks.length === 0) return null;
              return (
                <div key={message.id} className="rounded-md border p-3">
                  <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                    {message.role === "user"
                      ? t("agent.roleUser")
                      : t("agent.roleAssistant")}
                  </p>
                  {blocks.map((block, index) => (
                    <p
                      key={index}
                      className="whitespace-pre-wrap break-words text-sm"
                    >
                      {block}
                    </p>
                  ))}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
