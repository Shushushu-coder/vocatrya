"use client";

import { useEffect, useRef, useState } from "react";
import { getToolName, type ToolUIPart } from "ai";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
} from "@/components/ai-elements/confirmation";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { classifyDescriptionCompleteness } from "@/lib/jobs/descriptionCompleteness";
import { useI18n } from "@/i18n";
import { agentToolLabelKey } from "@/lib/agent/toolLabels";
import {
  isNotionAgentToolName,
  NOTION_TOOL,
} from "@/lib/extensions/notion/constants";
import { notionCopy, type NotionCopyKey } from "@/lib/extensions/notion/copy";
import {
  isFeishuAgentToolName,
  FEISHU_TOOL,
} from "@/lib/extensions/feishu/constants";
import { feishuCopy, type FeishuCopyKey } from "@/lib/extensions/feishu/copy";
import { AgentProposalStatus } from "@/components/agent/AgentProposalStatus";

type Respond = (r: { id: string; approved: boolean; reason?: string }) => void;

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 py-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {/* Text, never an anchor: this value came from an attacker-authorable
          posting by way of the model. */}
      <span className="break-words">{value}</span>
    </div>
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function AddJobBody({
  input,
  pastedText,
}: {
  input: Record<string, unknown>;
  pastedText?: string;
}) {
  const { t } = useI18n();
  const description = pastedText ?? text(input.jobDescription);
  const source = pastedText ? t("agent.pastedVerbatim") : t("agent.modelSupplied");
  const completeness = description
    ? classifyDescriptionCompleteness(description)
    : undefined;
  const tags = Array.isArray(input.tags) ? input.tags.join(", ") : undefined;

  return (
    <div>
      <Row label={t("common.company")} value={text(input.company)} />
      <Row label={t("agent.jobTitle")} value={text(input.jobTitle)} />
      <Row label={t("common.location")} value={text(input.location)} />
      <Row label={t("agent.source")} value={text(input.source)} />
      <Row label={t("common.url")} value={text(input.jobUrl)} />
      <Row label={t("common.salary")} value={text(input.salaryRange)} />
      <Row label={t("common.tags")} value={tags} />
      {description ? (
        <div className="mt-2 rounded-sm border bg-muted/20 p-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {t("agent.descriptionMeta", {
                source,
                chars: description.length,
              })}
            </span>
            {completeness && <Badge variant="outline">{completeness}</Badge>}
          </div>
          {/* Collapsed to ~200 chars: this is verbatim third-party content
              the model did not author, so it is the least interesting thing
              on the card, and a 6KB block would push Confirm below the fold. */}
          <p className="mt-1 line-clamp-3 text-xs">
            {description.slice(0, 200)}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("agent.noDescriptionAsk")}
        </p>
      )}
    </div>
  );
}

function MatchJobBody({ input }: { input: Record<string, unknown> }) {
  const { t } = useI18n();
  const resumeTitle = text(input.resumeTitle);
  return (
    <div className="mt-1">
      <Row
        label={t("matchAnalysis.sourceLabel")}
        value={resumeTitle ?? t("matchAnalysis.sourceCareerProfile")}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        {t("agent.matchApprovalHint")}
      </p>
    </div>
  );
}

// EXT-NOTION: the card shows the exact destination and the verbatim content
// that will be sent — what the user sees here is what the remote call sends,
// since the approval-bound toolCall replays this same input.
function NotionWriteBody({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  const { locale } = useI18n();
  const nt = notionCopy(locale);
  const target = text(input.target);
  const title = text(input.title);
  const content = text(input.content);
  const pages =
    toolName === NOTION_TOOL.deletePages && Array.isArray(input.targets)
      ? [...new Set(input.targets.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
      : [];
  const properties =
    input.properties && typeof input.properties === "object"
      ? JSON.stringify(input.properties, null, 2)
      : undefined;
  return (
    <div className="mt-1">
      <Row
        label={
          toolName === NOTION_TOOL.createPage
            ? nt["approval.destination"]
            : nt["approval.target"]
        }
        value={target ?? title}
      />
      {title && <Row label={nt["approval.title"]} value={title} />}
      {content && (
        <div className="mt-2 rounded-sm border bg-muted/20 p-2">
          <p className="text-xs text-muted-foreground">
            {nt["approval.content"]}
          </p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
            {content}
          </pre>
        </div>
      )}
      {pages.length > 0 && (
        <div className="mt-2 rounded-sm border bg-muted/20 p-2">
          <p className="text-xs text-muted-foreground">{nt["approval.pages"]}</p>
          <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-4 text-xs">
            {pages.map((page) => (
              <li key={page} className="break-all">{page}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{nt["approval.deleteNote"]}</p>
        </div>
      )}
      {properties && (
        <div className="mt-2 rounded-sm border bg-muted/20 p-2">
          <p className="text-xs text-muted-foreground">
            {nt["approval.properties"]}
          </p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
            {properties}
          </pre>
        </div>
      )}
    </div>
  );
}

// EXT-FEISHU: same display contract as the Notion write body — the exact
// target and the verbatim content/edits that will be sent, nothing else.
function FeishuWriteBody({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  const { locale } = useI18n();
  const ft = feishuCopy(locale);
  const target = text(input.target);
  const title = text(input.title);
  const content = text(input.content);
  const folder = text(input.folderToken);
  const edits =
    toolName === FEISHU_TOOL.updateContent && Array.isArray(input.edits)
      ? (input.edits as Array<{ blockId?: unknown; newText?: unknown }>).filter(
          (edit) => edit && typeof edit === "object",
        )
      : [];
  return (
    <div className="mt-1">
      <Row
        label={
          toolName === FEISHU_TOOL.createDoc
            ? ft["approval.destination"]
            : ft["approval.target"]
        }
        value={toolName === FEISHU_TOOL.createDoc ? folder ?? target : target}
      />
      {title && <Row label={ft["approval.title"]} value={title} />}
      {content && (
        <div className="mt-2 rounded-sm border bg-muted/20 p-2">
          <p className="text-xs text-muted-foreground">
            {ft["approval.content"]}
          </p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
            {content}
          </pre>
        </div>
      )}
      {edits.length > 0 && (
        <div className="mt-2 rounded-sm border bg-muted/20 p-2">
          <p className="text-xs text-muted-foreground">{ft["approval.edits"]}</p>
          <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-xs">
            {edits.map((edit, index) => (
              <li key={index} className="break-words">
                <span className="break-all text-muted-foreground">
                  {text(edit.blockId) ?? "—"}
                </span>
                <span className="mx-1">→</span>
                <span>{text(edit.newText) ?? ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function AgentApprovalCard({
  part,
  pastedText,
  onRespond,
}: {
  part: ToolUIPart;
  pastedText?: string;
  onRespond: Respond;
}) {
  const { t, locale } = useI18n();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

  // A blocking decision: focus moves here when it appears.
  useEffect(() => {
    if (part.state === "approval-requested") cardRef.current?.focus();
  }, [part.state]);

  // AWU-APPROVAL (D5): the card owns the whole approval lifecycle —
  // requested, responded, executed, denied and failed — so an approval-gated
  // tool reads as one card that settles, not a request that vanishes. Output
  // states only count when the part actually carries an approval record; a
  // plain tool output is the result card's job.
  const owns =
    part.state === "approval-requested" ||
    part.state === "approval-responded" ||
    (Boolean(part.approval) &&
      (part.state === "output-available" ||
        part.state === "output-denied" ||
        part.state === "output-error"));
  if (!owns) return null;

  const approvalId = part.approval?.id;
  const approved = part.approval?.approved;
  const toolName = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const settled =
    part.state === "output-available" ||
    part.state === "output-denied" ||
    part.state === "output-error";

  const statusLabel = (() => {
    switch (part.state) {
      case "approval-requested":
        return t("agent.needsApproval");
      case "approval-responded":
        return approved === false
          ? t("agent.approvalDenied")
          : t("agent.approvalRunning");
      case "output-available":
        return t("agent.approvalExecuted");
      case "output-denied":
        return t("agent.approvalDenied");
      case "output-error":
        return t("agent.approvalFailed");
      default:
        return "";
    }
  })();
  const statusDestructive =
    part.state === "output-denied" ||
    part.state === "output-error" ||
    (part.state === "approval-responded" && approved === false);

  const body = (() => {
    switch (toolName) {
      case "add_job":
        return <AddJobBody input={input} pastedText={pastedText} />;
      case "match_job":
        return <MatchJobBody input={input} />;
      default:
        if (isNotionAgentToolName(toolName)) {
          return <NotionWriteBody toolName={toolName} input={input} />;
        }
        if (isFeishuAgentToolName(toolName)) {
          return <FeishuWriteBody toolName={toolName} input={input} />;
        }
        return null;
    }
  })();

  const declineReason =
    (part.state === "output-denied" ||
      (part.state === "approval-responded" && approved === false)) &&
    part.approval?.reason
      ? part.approval.reason
      : undefined;
  const errorText =
    part.state === "output-error" && typeof (part as { errorText?: unknown }).errorText === "string"
      ? ((part as { errorText?: string }).errorText as string)
      : undefined;

  return (
    <Confirmation
      ref={cardRef}
      tabIndex={-1}
      approval={part.approval}
      state={part.state}
      className="rounded-sm p-3 outline-hidden"
    >
      <div className="flex items-center gap-2">
        <Badge variant={statusDestructive ? "destructive" : "secondary"}>
          {statusLabel}
        </Badge>
        <span className="text-sm font-semibold">
          {agentToolLabelKey(toolName)
            ? t(agentToolLabelKey(toolName)!)
            : isNotionAgentToolName(toolName)
              ? notionCopy(locale)[`tool.${toolName}` as NotionCopyKey]
              : isFeishuAgentToolName(toolName)
                ? feishuCopy(locale)[`tool.${toolName}` as FeishuCopyKey]
                : t("agent.tools.generic")}
        </span>
      </div>

      {settled ? (
        // Settled states collapse to a status line; the parameters stay one
        // tap away instead of duplicating the full request body under the
        // result card.
        <details className="text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">
            {t("agent.approvalShowParams")}
          </summary>
          <div className="mt-1">{body}</div>
        </details>
      ) : (
        body
      )}

      {declineReason ? (
        <p className="text-xs text-muted-foreground">
          {t("agent.approvalDeniedReason", { reason: declineReason })}
        </p>
      ) : null}
      {errorText ? (
        <p className="text-xs text-destructive">{errorText}</p>
      ) : null}

      {part.state === "approval-responded" && approved !== false && (
        <p className="text-xs text-muted-foreground">{t("agent.waiting")}</p>
      )}

      {/* Detached extension writes: the transcript part is only the display;
          the durable proposal is the authority. Hydrate its real state so
          queued ≠ succeeded stays honest across refresh/restart. */}
      {(isNotionAgentToolName(toolName) || isFeishuAgentToolName(toolName)) &&
        approvalId && <AgentProposalStatus approvalId={approvalId} />}

      <ConfirmationRequest>
        {declining && (
          <div className="space-y-2">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("agent.declineReasonPlaceholder")}
              rows={2}
            />
            <div className="flex gap-2">
              <ConfirmationAction
                onClick={() =>
                  approvalId &&
                  onRespond({ id: approvalId, approved: false, reason })
                }
              >
                {t("agent.send")}
              </ConfirmationAction>
              <ConfirmationAction
                variant="ghost"
                onClick={() =>
                  approvalId && onRespond({ id: approvalId, approved: false })
                }
              >
                {t("agent.skip")}
              </ConfirmationAction>
            </div>
          </div>
        )}
      </ConfirmationRequest>

      {!declining && (
        <ConfirmationActions>
          <ConfirmationAction
            onClick={() =>
              approvalId && onRespond({ id: approvalId, approved: true })
            }
          >
            {t("agent.confirm")}
          </ConfirmationAction>
          {/* Client-side and always available — it must not depend on a
              server round-trip succeeding. */}
          <ConfirmationAction variant="outline" onClick={() => setDeclining(true)}>
            {t("agent.cancel")}
          </ConfirmationAction>
        </ConfirmationActions>
      )}
    </Confirmation>
  );
}
