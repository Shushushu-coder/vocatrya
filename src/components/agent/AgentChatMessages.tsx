"use client";

import { Fragment, useMemo, useState } from "react";
import { FileTextIcon, XIcon } from "lucide-react";
import { getToolName, isStaticToolUIPart, type UIMessage } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import { AgentAnswerActions } from "@/components/agent/AgentAnswerActions";
import { AgentApprovalCard } from "@/components/agent/AgentApprovalCard";
import { AgentMarkdown } from "@/components/agent/AgentMarkdown";
import { AgentMatchContent } from "@/components/agent/AgentMatchContent";
import { AgentResultCard } from "@/components/agent/AgentResultCard";
import { AgentReviewContent } from "@/components/agent/AgentReviewContent";
import { ResumeEvidenceAssistantText } from "@/components/agent/ResumeEvidenceDraftCard";
import {
  deriveResumeEvidenceSession,
  hasResumeEvidenceDraftBlock,
} from "@/lib/agent/skills/resumeEvidence";
import { AgentStatusRow } from "@/components/agent/AgentStatusRow";
import { AgentToolRunningCard } from "@/components/agent/AgentToolRunningCard";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { assistantAnswerCopyText } from "@/lib/agent/answerCopyText";
import { regenerateTailHasWriteReceipt } from "@/lib/agent/writeReceipt";
import { resolvePastedText } from "@/lib/agent/paste";
import { parseJobMatch } from "@/lib/ai/jobMatch/parse";
import { parseResumeReview } from "@/lib/ai/resumeReview/parse";
import { stripThinking } from "@/lib/ai/stripThinking";
import { cn } from "@/lib/utils";
import {
  isAgentFilePart,
  isAgentPastePart,
  isNestedTool,
  type AgentPastePartData,
} from "@/models/agent.model";
import { AgentFilePartCard } from "@/components/agent/fileChip";

import { useI18n } from "@/i18n";

function PasteChip({ data }: { data: AgentPastePartData }) {
  const { t, formatNumber } = useI18n();
  const chars = formatNumber(data.chars);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
      <FileTextIcon className="size-3" />
      {data.truncated
        ? t("agent.pastedPostingTruncated", { chars })
        : t("agent.pastedPosting", { chars })}
    </span>
  );
}

// The seeded transcript ending on a user message means the reply never came
// back — the tab was closed mid-turn, or the server died. Same remedy as an
// explicitly interrupted turn. Gated on status because a turn still waiting on
// its first chunk looks identical, and on a local model that wait is 30–60s.
function endsAwaitingReply(messages: UIMessage[], status: string): boolean {
  if (status === "submitted" || status === "streaming") return false;
  return messages[messages.length - 1]?.role === "user";
}

// Two silent windows on a local model: the wait before the first assistant
// part lands, and the wait after a tool result while the closing prose is
// composed. Both look identical — nothing on screen moves and the only signal
// is the submit button. Suppressed wherever the transcript already narrates
// itself, so there is never a second spinner beside a card that has one.
function showThinking(messages: UIMessage[], status: string): boolean {
  if (status !== "submitted" && status !== "streaming") return false;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return true;

  const tail = last.parts[last.parts.length - 1];
  if (!tail) return true;
  if (tail.type === "text") return tail.text.trim().length === 0;
  if (!isStaticToolUIPart(tail)) return true;
  switch (tail.state) {
    // The running card spins for these two.
    case "input-streaming":
    case "input-available":
    // Waiting on the user, not the model.
    case "approval-requested":
    // The approval card already says "Waiting…".
    case "approval-responded":
      return false;
    default:
      return true;
  }
}

export function AgentChatMessages() {
  const {
    messages,
    toolStreams,
    status,
    regenerate,
    nativeSession,
    addToolApprovalResponse,
    approvalPending,
    conversationId,
    contextUsage,
  } = useAgentChat();
  const [dismissed, setDismissed] = useState(false);

  const pastedText = resolvePastedText(messages);
  const showContinue =
    !nativeSession && !dismissed && endsAwaitingReply(messages, status);
  const thinking = showThinking(messages, status);
  // Derived once per render: while a run is active, draft-shaped blocks that
  // dropped the envelope still surface as invalid drafts instead of raw code.
  const evidenceSession = useMemo(
    () => deriveResumeEvidenceSession(messages),
    [messages],
  );

  const dismiss = () => setDismissed(true);

  const { t } = useI18n();

  // Regenerate is admitted only for the last message, and only when it is a
  // plain assistant answer: the route rejects anything mid-turn, any pending
  // approval and a tail that carries a saved write receipt. Mirroring the
  // admission checks here keeps the button off the answers the server would
  // refuse — history answers in the middle simply get no control.
  const lastMessageId = messages.at(-1)?.id;
  const tailHasWriteReceipt = regenerateTailHasWriteReceipt(messages);

  return (
    <Conversation className="flex-1">
      <ConversationContent className="gap-4">
        {/* D2 inline hint: sits where the omitted history would be, so the
            user sees that earlier turns were left out of the last send. */}
        {contextUsage?.droppedTurnCount ? (
          <p className="text-xs text-muted-foreground">
            {t("agent.contextUsageDroppedInline", {
              count: contextUsage.droppedTurnCount,
            })}
          </p>
        ) : null}
        {messages.map((message, messageIndex) => {
          // Copy answers only ever covers the message's own visible prose —
          // hidden reasoning, raw tool args and card output stay out of it.
          // Empty answers and pure-tool turns get no action row at all.
          const copyText =
            message.role === "assistant"
              ? assistantAnswerCopyText(message.parts)
              : "";
          return (
            <div
              key={message.id}
              className={cn(
                "flex flex-col gap-2 text-sm",
                message.role === "user" && "items-end",
              )}
            >
              {message.parts.map((part, i) => {
                if (part.type === "text") {
                  // User text stays plain: it is their own words, and a user
                  // who types a markdown table did not ask for it to render.
                  if (message.role === "user") {
                    return (
                      <p
                        key={i}
                        className="min-w-0 max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md bg-muted px-3 py-2"
                      >
                        {part.text}
                      </p>
                    );
                  }
                  // Resume Evidence drafts render as a read-only card; every
                  // other assistant text is untouched. Inside an active run a
                  // draft-shaped block without the envelope still surfaces
                  // as an invalid attempt instead of an opaque code block.
                  const evidenceScoped =
                    evidenceSession.active &&
                    messageIndex > evidenceSession.packIndex;
                  if (
                    hasResumeEvidenceDraftBlock(part.text, {
                      sessionScoped: evidenceScoped,
                    })
                  )
                    return (
                      <ResumeEvidenceAssistantText
                        key={i}
                        text={part.text}
                        sessionScoped={evidenceScoped}
                      />
                    );
                  return <AgentMarkdown key={i} text={part.text} />;
                }
                if (isAgentPastePart(part))
                  return <PasteChip key={i} data={part.data} />;
                // Persisted file attachments (AWU-FILES): name + extracted
                // size, read-only — the part is the record of what was sent.
                if (isAgentFilePart(part))
                  return <AgentFilePartCard key={i} data={part.data} />;
                // Static, not dynamic: every tool this surface exposes is
                // declared in buildAgentTools, so a dynamic part is not ours.
                if (!isStaticToolUIPart(part)) return null;
                switch (part.state) {
                  case "input-streaming":
                  case "input-available": {
                    const tool = getToolName(part);
                    const streamed = isNestedTool(tool)
                      ? toolStreams[part.toolCallId]
                      : undefined;
                    if (!streamed)
                      return <AgentToolRunningCard key={i} part={part} />;
                    if (tool === "match_job") {
                      const parsed = parseJobMatch(streamed);
                      return (
                        <AgentMatchContent
                          key={i}
                          body={parsed.body}
                          scores={parsed.scores}
                        />
                      );
                    }
                    // A letter has no scores line, so stripping reasoning is
                    // the whole of its parse.
                    if (tool === "generate_cover_letter") {
                      return (
                        <AgentMarkdown key={i} text={stripThinking(streamed)} />
                      );
                    }
                    const parsed = parseResumeReview(streamed);
                    return (
                      <AgentReviewContent
                        key={i}
                        body={parsed.body}
                        scores={parsed.scores}
                      />
                    );
                  }
                  // Default, not a case list: AgentResultCard already returns
                  // null for anything it does not recognize, and rendering
                  // nothing beats rendering an unknown future state raw.
                  default: {
                    // AWU-APPROVAL: an approval-gated tool's output states
                    // stay on the approval card so the card shows the whole
                    // lifecycle (executed / denied / failed). The result
                    // card still renders the outcome or retry beside it;
                    // a denied write has no outcome, so it is the one state
                    // that renders the status line alone.
                    const approvalLifecycle =
                      part.state === "approval-requested" ||
                      part.state === "approval-responded" ||
                      (Boolean(part.approval) &&
                        (part.state === "output-available" ||
                          part.state === "output-denied" ||
                          part.state === "output-error"));
                    if (!approvalLifecycle) {
                      return <AgentResultCard key={i} part={part} />;
                    }
                    return (
                      <Fragment key={i}>
                        <AgentApprovalCard
                          part={part}
                          pastedText={pastedText}
                          onRespond={addToolApprovalResponse}
                        />
                        {part.state === "output-available" ||
                        part.state === "output-error" ? (
                          <AgentResultCard part={part} />
                        ) : null}
                      </Fragment>
                    );
                  }
                }
              })}
              {copyText && (
                <AgentAnswerActions
                  text={copyText}
                  onRegenerate={
                    !nativeSession && message.role === "assistant" &&
                    message.id === lastMessageId &&
                    status === "ready" &&
                    !approvalPending &&
                    Boolean(conversationId) &&
                    !tailHasWriteReceipt
                      ? () => regenerate(message.id)
                      : undefined
                  }
                />
              )}
            </div>
          );
        })}

        {showContinue && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span className="flex-1">{t("agent.stopped")}</span>
            {/* Offered, never automatic — regenerate reruns the turn. It does
                not resume the interrupted token stream. */}
            <Button
              onClick={() => void regenerate()}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("agent.regenerate")}
            </Button>
            <Button
              aria-label={t("agent.dismissInterrupted")}
              className="size-6 shrink-0"
              onClick={dismiss}
              size="icon"
              type="button"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        )}

        {thinking && (
          <AgentStatusRow
            label={
              status === "submitted"
                ? t("agent.connecting")
                : t("agent.thinkingTurn")
            }
          />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
