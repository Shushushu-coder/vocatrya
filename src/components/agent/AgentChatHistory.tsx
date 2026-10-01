"use client";

import { useEffect, useState } from "react";
import { listChatConversations } from "@/actions/agentChat.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/i18n";
import { groupHistory, type HistoryBucket } from "@/lib/agent/historyGroups";
import type { ChatConversationSummary } from "@/lib/agent/chatTypes";

const BUCKETS: HistoryBucket[] = ["today", "yesterday", "earlier"];

export function AgentChatHistory({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const {
    conversationId,
    selectConversation,
    removeConversation,
    historyVersion,
  } = useAgentChat();
  const [rows, setRows] = useState<ChatConversationSummary[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listChatConversations().then((result) => {
      if (cancelled || !result.success || !result.data) return;
      setRows(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [historyVersion]);

  const groups = groupHistory(rows, new Date());
  const labels: Record<HistoryBucket, string> = {
    today: t("agent.historyToday"),
    yesterday: t("agent.historyYesterday"),
    earlier: t("agent.historyEarlier"),
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <p className="text-sm font-medium">{t("agent.history")}</p>
        <Button
          className="ml-auto h-6 px-2 text-xs"
          size="sm"
          variant="ghost"
          onClick={onClose}
        >
          {t("common.close")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("agent.historyEmpty")}</p>
        ) : (
          BUCKETS.map((bucket) =>
            groups[bucket].length === 0 ? null : (
              <section key={bucket} className="mb-4">
                <p className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">
                  {labels[bucket]}
                </p>
                <ul>
                  {groups[bucket].map((row) => {
                    const title =
                      row.title ||
                      row.titleFallback ||
                      t("agent.untitledConversation");
                    const when = new Date(row.updatedAt);
                    return (
                      <li key={row.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          className={`min-w-0 flex-1 rounded-sm px-2 py-1.5 text-left hover:bg-muted ${
                            row.id === conversationId ? "bg-muted" : ""
                          }`}
                          onClick={() => {
                            void selectConversation(row.id).then((ok) => {
                              if (ok) onClose();
                            });
                          }}
                        >
                          <span className="block truncate text-sm">{title}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {when.toLocaleString(locale, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </button>
                        <Button
                          aria-label={t("agent.historyDelete")}
                          className="h-7 shrink-0 px-2 text-xs"
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingDelete(row.id)}
                        >
                          {t("agent.historyDelete")}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
          )
        )}
      </div>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("agent.historyDeleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("agent.historyDeleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pendingDelete) return;
                const id = pendingDelete;
                setPendingDelete(null);
                void removeConversation(id);
              }}
            >
              {t("agent.historyDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
