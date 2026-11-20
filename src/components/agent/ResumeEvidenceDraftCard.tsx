"use client";

import { useRef, useState } from "react";
import {
  confirmResumeEvidenceSave,
  previewResumeEvidenceSave,
} from "@/actions/resumeEvidenceSave.actions";
import { AgentMarkdown } from "@/components/agent/AgentMarkdown";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import {
  getResumeEvidenceSaveEligibility,
  savingBlockers,
  splitResumeEvidenceDraftText,
  type ResumeEvidenceDraft,
} from "@/lib/agent/skills/resumeEvidence";
import type { ResumeEvidenceSavePreview } from "@/lib/career/resumeEvidenceSave";

// Resume Evidence draft card (contract §6). It is labelled a draft until the
// user saves it: a savable draft offers "save to career materials", which goes
// through one server-built preview and a confirm before a single transaction
// writes USER_CONFIRMED rows (D4/D5/D7). The server re-validates the draft.

type SaveState =
  | { phase: "idle" }
  | { phase: "previewing" }
  | { phase: "preview"; preview: ResumeEvidenceSavePreview }
  | { phase: "saving"; preview: ResumeEvidenceSavePreview }
  | { phase: "saved"; count: number; already: boolean };

function SavePanel({
  draft,
  onSaved,
}: {
  draft: ResumeEvidenceDraft;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const k = (key: string, values?: Record<string, string | number>) =>
    t(`agent.resumeEvidence.save.${key}`, values);
  const eligibility = getResumeEvidenceSaveEligibility(draft);
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard: state updates are async, a fast double click is not.
  const busy = useRef(false);

  if (state.phase === "saved") {
    return (
      <p
        data-testid="resume-evidence-saved"
        role="status"
        className="text-xs text-muted-foreground"
      >
        {state.already ? k("alreadySaved") : k("saved", { count: state.count })}
      </p>
    );
  }
  if (!eligibility.ok) {
    if (eligibility.code === "blocked_writes") {
      return (
        <div
          data-testid="resume-evidence-save-blocked"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          <p>{k("blocked")}</p>
          <ul className="list-disc pl-4">
            {savingBlockers(draft.materialMapping.blockedWrites).map((b, i) => (
              <li key={i}>{b.message}</li>
            ))}
          </ul>
        </div>
      );
    }
    if (eligibility.code !== "unsupported_type") return null;
    return (
      <p
        data-testid="resume-evidence-save-unsupported"
        className="text-xs text-muted-foreground"
      >
        {k("unsupported", { type: draft.materialMapping.type ?? "" })}
      </p>
    );
  }

  const failureText = (
    res: { success: boolean; code?: string; field?: string },
    fallback: string,
  ) =>
    res.code === "invalid_detail" && res.field
      ? k("invalidDetail", { field: res.field })
      : k(fallback);

  const startPreview = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setState({ phase: "previewing" });
    try {
      const res = await previewResumeEvidenceSave(draft);
      if (res.success && res.data) {
        setState({ phase: "preview", preview: res.data });
      } else {
        setState({ phase: "idle" });
        setError(failureText(res, "previewFailed"));
      }
    } catch {
      setState({ phase: "idle" });
      setError(k("failed"));
    } finally {
      busy.current = false;
    }
  };

  const confirm = async (preview: ResumeEvidenceSavePreview) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setState({ phase: "saving", preview });
    try {
      const res = await confirmResumeEvidenceSave(draft, preview.digest);
      if (res.success && res.data) {
        setState({
          phase: "saved",
          count: res.data.evidenceCount,
          already: res.data.alreadySaved,
        });
        onSaved();
      } else {
        // Nothing was written; keep the draft and the preview for a retry.
        setState({ phase: "preview", preview });
        setError(failureText(res, "failed"));
      }
    } catch {
      setState({ phase: "preview", preview });
      setError(k("failed"));
    } finally {
      busy.current = false;
    }
  };

  const errorLine = error && (
    <p
      data-testid="resume-evidence-save-error"
      role="alert"
      className="text-xs text-destructive"
    >
      {error}
    </p>
  );

  if (state.phase === "preview" || state.phase === "saving") {
    const { preview } = state;
    const saving = state.phase === "saving";
    const m = preview.material;
    return (
      <div
        data-testid="resume-evidence-save-preview"
        className="flex flex-col gap-2 rounded-md border bg-background p-2"
      >
        <p className="text-xs font-medium">{k("previewTitle")}</p>
        {m ? (
          <div className="flex flex-col gap-0.5 text-xs">
            <p>{k("willCreate", { type: preview.type, title: m.title })}</p>
            {(m.startDate || m.endDate || m.isCurrent) && (
              <p>
                {k("dates", {
                  start: m.startDate ?? "-",
                  end: m.isCurrent ? k("current") : (m.endDate ?? "-"),
                })}
              </p>
            )}
            {m.detail.map((d) => (
              <p key={d.key}>
                {d.key}：{d.value}
              </p>
            ))}
            {m.notes && <p>{m.notes}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 text-xs">
            <p>
              {k("willAppend", {
                type: preview.type,
                title: preview.targetTitle ?? "",
              })}
            </p>
            {preview.changes.length === 0 ? (
              <p>{k("noFieldChanges")}</p>
            ) : (
              <>
                <p>{k("changesHeading")}</p>
                <ul className="list-disc pl-4">
                  {preview.changes.map((c) => (
                    <li key={`${c.scope}.${c.field}`}>
                      {c.field}：{c.old ?? k("empty")} → {c.new}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <p className="text-xs">
          {k("evidenceHeading", { count: preview.evidence.length })}
        </p>
        <ul className="list-disc pl-4 text-xs">
          {preview.evidence.map((e, i) => (
            <li key={i}>
              {e.content}
              {e.metricText ? `（${e.metricText}）` : ""}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{k("statusNote")}</p>
        {errorLine}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={saving}
            data-testid="resume-evidence-save-confirm"
            onClick={() => confirm(preview)}
          >
            {saving ? k("saving") : k("confirm")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setError(null);
              setState({ phase: "idle" });
            }}
          >
            {k("cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {errorLine}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={state.phase === "previewing"}
          data-testid="resume-evidence-save-button"
          onClick={startPreview}
        >
          {k("button")}
        </Button>
      </div>
    </div>
  );
}

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
  const [saved, setSaved] = useState(false);
  const k = (key: string, values?: Record<string, string | number>) =>
    t(`agent.resumeEvidence.${key}`, values);
  const openConflicts = draft.conflicts.filter((c) => c.resolution === "open");
  return (
    <div
      data-testid="resume-evidence-draft-card"
      data-persisted={saved ? "true" : "false"}
      className="flex w-full max-w-[85%] flex-col gap-3 rounded-md border bg-muted/20 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{k("cardTitle")}</span>
        <span
          data-testid="resume-evidence-draft-label"
          className="rounded-sm border px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {saved ? k("savedLabel") : k("draftLabel")}
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

      {!saved && (
        <p
          data-testid="resume-evidence-not-saved"
          className="text-xs text-muted-foreground"
        >
          {k("notSaved")}
        </p>
      )}
      <SavePanel draft={draft} onSaved={() => setSaved(true)} />
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
