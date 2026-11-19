"use client";

import { AgentMarkdown } from "@/components/agent/AgentMarkdown";
import { useI18n } from "@/i18n";
import {
  splitResumeEvidenceDraftText,
  type ResumeEvidenceDraft,
} from "@/lib/agent/skills/resumeEvidence";

// Read-only Resume Evidence draft card (contract §6). It is always labelled a
// draft and never offers save / confirm: the first version persists nothing.

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

export function ResumeEvidenceDraftCard({
  draft,
}: {
  draft: ResumeEvidenceDraft;
}) {
  const { t } = useI18n();
  const k = (key: string, values?: Record<string, string | number>) =>
    t(`agent.resumeEvidence.${key}`, values);
  const openConflicts = draft.conflicts.filter((c) => c.resolution === "open");
  return (
    <div
      data-testid="resume-evidence-draft-card"
      data-persisted="false"
      className="flex w-full max-w-[85%] flex-col gap-3 rounded-md border bg-muted/20 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{k("cardTitle")}</span>
        <span
          data-testid="resume-evidence-draft-label"
          className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {k("draftLabel")}
        </span>
        <span className="text-xs text-muted-foreground">
          {k(`stage.${draft.session.stage}`)}
        </span>
      </div>

      {draft.confirmedFacts.length > 0 && (
        <Section title={k("confirmed")}>
          <ul className="list-disc pl-4">
            {draft.confirmedFacts.map((f) => (
              <li key={f.id}>{f.text}</li>
            ))}
          </ul>
        </Section>
      )}
      {openConflicts.length > 0 && (
        <Section title={k("conflicts")}>
          <ul className="list-disc pl-4">
            {openConflicts.map((c) => (
              <li key={c.id}>
                {c.topic}：{c.left.text} / {c.right.text}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {draft.pending.length > 0 && (
        <Section title={k("pending")}>
          <ul className="list-disc pl-4">
            {draft.pending.map((p) => (
              <li key={p.id}>{p.text}</li>
            ))}
          </ul>
        </Section>
      )}
      {draft.skipped.length > 0 && (
        <Section title={k("skipped")}>
          <ul className="list-disc pl-4">
            {draft.skipped.map((s) => (
              <li key={s.id}>{s.note || s.slot}</li>
            ))}
          </ul>
        </Section>
      )}
      {draft.suggestedExpressions.length > 0 && (
        <Section title={k("suggested")}>
          <ul className="list-disc pl-4">
            {draft.suggestedExpressions.map((e) => (
              <li key={e.id}>{e.text}</li>
            ))}
          </ul>
        </Section>
      )}

      <p
        data-testid="resume-evidence-not-saved"
        className="text-xs text-muted-foreground"
      >
        {k("notSaved")}
      </p>
    </div>
  );
}

export function ResumeEvidenceInvalidDraft({ errors }: { errors: string[] }) {
  const { t } = useI18n();
  return (
    <div
      data-testid="resume-evidence-draft-invalid"
      role="status"
      className="flex w-full max-w-[85%] flex-col gap-1 rounded-md border border-destructive/40 bg-muted/20 p-3 text-sm"
    >
      <p className="font-medium">{t("agent.resumeEvidence.invalidTitle")}</p>
      <p className="text-xs text-muted-foreground">
        {t("agent.resumeEvidence.invalidBody")}
      </p>
      {errors.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>{t("agent.resumeEvidence.invalidDetails")}</summary>
          <ul className="list-disc pl-4">
            {errors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Assistant text that carries one or more draft blocks. */
export function ResumeEvidenceAssistantText({ text }: { text: string }) {
  return (
    <>
      {splitResumeEvidenceDraftText(text).map((seg, i) => {
        if (seg.kind === "draft")
          return <ResumeEvidenceDraftCard key={i} draft={seg.draft} />;
        if (seg.kind === "invalid")
          return <ResumeEvidenceInvalidDraft key={i} errors={seg.errors} />;
        return seg.text.trim() ? (
          <AgentMarkdown key={i} text={seg.text} />
        ) : null;
      })}
    </>
  );
}
