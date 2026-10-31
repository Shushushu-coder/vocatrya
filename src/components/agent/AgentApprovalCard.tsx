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

export function AgentApprovalCard({
  part,
  pastedText,
  onRespond,
}: {
  part: ToolUIPart;
  pastedText?: string;
  onRespond: Respond;
}) {
  const { t } = useI18n();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);

  // A blocking decision: focus moves here when it appears.
  useEffect(() => {
    if (part.state === "approval-requested") cardRef.current?.focus();
  }, [part.state]);

  if (part.state !== "approval-requested" && part.state !== "approval-responded")
    return null;

  const approvalId = part.approval?.id;
  const toolName = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;

  const body = (() => {
    switch (toolName) {
      case "add_job":
        return <AddJobBody input={input} pastedText={pastedText} />;
      case "match_job":
        return <MatchJobBody input={input} />;
      default:
        return null;
    }
  })();

  return (
    <Confirmation
      ref={cardRef}
      tabIndex={-1}
      approval={part.approval}
      state={part.state}
      className="rounded-sm p-3 outline-hidden"
    >
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{t("agent.needsApproval")}</Badge>
        <span className="text-sm font-semibold">
          {t(agentToolLabelKey(toolName) ?? "agent.tools.generic")}
        </span>
      </div>

      {body}

      {part.state === "approval-responded" && (
        <p className="text-xs text-muted-foreground">{t("agent.waiting")}</p>
      )}

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
