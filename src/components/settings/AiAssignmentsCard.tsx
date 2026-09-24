"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";
import {
  listAiConnections,
  mintAiConnectionTicket,
} from "@/actions/aiConnection.actions";
import {
  clearBusinessAiAssignment,
  listBusinessAiAssignments,
  resolveBusinessAiConfig,
  setBusinessAiAssignment,
} from "@/actions/aiAssignment.actions";
import type { ConnectionSummary } from "@/lib/ai/connection-service";
import type { BusinessAssignmentSummary } from "@/lib/ai/assignments";
import {
  checkStructuredOutputReadiness,
  type AccountRuntimeCapabilities,
} from "@/lib/ai/runtime/capabilities";

// Purposes editable this phase. INTERVIEW is editable now that interview
// execution runs through the locked account runtime (TEXT_ONLY one-shot);
// a legacy `settings.ai.interview` config still outranks GLOBAL_DEFAULT
// for users who have not saved an INTERVIEW assignment.
const EDITABLE_PURPOSES = [
  "GLOBAL_DEFAULT",
  "RESUME",
  "MATCH_ANALYSIS",
  "CAREER_REFLECTION",
  "CAREER_DIALOGUE",
  "INTERVIEW",
] as const;

const PURPOSE_LABEL_KEY: Record<string, string> = {
  GLOBAL_DEFAULT: "settings.aiAssignPurposeGlobalDefault",
  RESUME: "settings.aiAssignPurposeResume",
  MATCH_ANALYSIS: "settings.aiAssignPurposeMatchAnalysis",
  CAREER_REFLECTION: "settings.aiAssignPurposeCareerReflection",
  CAREER_DIALOGUE: "settings.aiAssignPurposeCareerDialogue",
  INTERVIEW: "settings.aiAssignPurposeInterview",
};

const ERROR_KEY: Record<string, string> = {
  INVALID_PURPOSE: "settings.aiAssignErrInvalidPurpose",
  CONNECTION_NOT_FOUND: "settings.aiAssignErrConnectionNotFound",
  CONNECTION_ARCHIVED: "settings.aiAssignErrArchived",
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION:
    "settings.aiAssignErrUnsupportedCombination",
  MODEL_UNAVAILABLE: "settings.aiAssignErrModelRequired",
};

// Purposes whose execution path is structured output. Connections whose
// runtime has not passed managed structured verification are marked (and
// rejected on save) for these purposes only — they remain fully usable for
// TEXT_ONLY purposes like MATCH_ANALYSIS.
const STRUCTURED_PURPOSES = new Set<string>(["RESUME"]);

// Purposes whose execution path is a TEXT_ONLY one-shot on the account
// runtime. Connections on runtimes without local one-shot execution are
// marked (and rejected on save) for these purposes.
const TEXT_ONLY_PURPOSES = new Set<string>(["INTERVIEW"]);

// Purposes whose execution path streams assistant output to the user
// (Career Dialogue renders tokens as they arrive — a buffered one-shot
// would be fake streaming). Connections on runtimes without verified
// incremental output are marked and rejected on save; today no runtime
// has completed streaming verification, so none can be assigned here yet.
const STREAMING_PURPOSES = new Set<string>(["CAREER_DIALOGUE"]);

type Draft = { connectionId: string; model: string };

type ModelEntry = {
  id: string;
  displayName: string;
  source: string;
  availability: string;
};

type InterviewResolution = {
  status: string;
  source?: string;
  code?: string;
  provider?: string;
  model?: string;
  connectionId?: string;
};

function connectionLabel(connection: ConnectionSummary): string {
  // displayName already carries the runtime (e.g. "ChatGPT via Codex",
  // "ChatGPT via OpenCode") so two accounts on the same provider stay
  // visually distinct.
  const identity = connection.accountIdentity
    ? ` · ${connection.accountIdentity}`
    : "";
  return `${connection.displayName}${identity} (${connection.status})`;
}

/**
 * Business AI assignment surface: each purpose binds a complete
 * connectionId + model pair. GLOBAL_DEFAULT is the fallback used when a
 * business purpose has no explicit assignment. Assignments never pick a
 * provider/backendKind directly — the connection owns that pairing.
 */
function AiAssignmentsCard() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [assignments, setAssignments] = useState<
    Record<string, BusinessAssignmentSummary>
  >({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [catalogs, setCatalogs] = useState<Record<string, ModelEntry[]>>({});
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [interview, setInterview] = useState<InterviewResolution | null>(null);
  // backendKind → structured-output readiness. Empty map = bridge absent
  // (plain web/dev) — marking is skipped; execution still fails closed.
  const [runtimeCaps, setRuntimeCaps] = useState<
    Record<string, AccountRuntimeCapabilities>
  >({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [connResult, assignResult, interviewResult] = await Promise.all([
        listAiConnections(),
        listBusinessAiAssignments(),
        resolveBusinessAiConfig({ purpose: "INTERVIEW" }),
      ]);
      const runtime = window.vocatryaRuntime;
      if (runtime) {
        try {
          const runtimes = await runtime.list();
          const next: Record<string, AccountRuntimeCapabilities> = {};
          for (const entry of runtimes) {
            if (entry.capabilities) next[entry.backendKind] = entry.capabilities;
          }
          setRuntimeCaps(next);
        } catch {
          // Capability lookup is advisory — never block the card on it.
        }
      }
      if (connResult.success && connResult.data) {
        setConnections(connResult.data);
      }
      const nextAssignments: Record<string, BusinessAssignmentSummary> = {};
      const nextDrafts: Record<string, Draft> = {};
      if (assignResult.success && assignResult.data) {
        for (const assignment of assignResult.data) {
          nextAssignments[assignment.purpose] = assignment;
          nextDrafts[assignment.purpose] = {
            connectionId: assignment.connectionId,
            model: assignment.model,
          };
        }
      }
      setAssignments(nextAssignments);
      setDrafts(nextDrafts);
      if (interviewResult.success && interviewResult.data) {
        setInterview(interviewResult.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setDraft = (purpose: string, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const current = prev[purpose] ?? { connectionId: "", model: "" };
      return { ...prev, [purpose]: { ...current, ...patch } };
    });
  };

  const loadCatalog = useCallback(
    async (connection: ConnectionSummary) => {
      const ai = window.vocatryaAi;
      if (!ai) {
        toastError(t("settings.aiConnErrBackendUnavailable"));
        return;
      }
      const ticketResult = await mintAiConnectionTicket({
        operation: "listModels",
        backendKind: connection.backendKind,
        connectionId: connection.id,
      });
      if (!ticketResult.success || !ticketResult.data) {
        toastError(ticketResult.message || t("settings.aiConnErrGeneric"));
        return;
      }
      setCatalogBusy(connection.id);
      try {
        const result = await ai.listModels({
          connectionId: connection.id,
          ticket: ticketResult.data.ticket,
        });
        if (result.ok && result.models) {
          setCatalogs((prev) => ({ ...prev, [connection.id]: result.models! }));
        } else {
          toastError(t("settings.aiConnErrModelUnavailable"));
        }
      } finally {
        setCatalogBusy(null);
      }
    },
    [t],
  );

  // null = unknown (no desktop bridge); true/false = verified verdict.
  const structuredReady = (connection: ConnectionSummary): boolean | null => {
    const caps = runtimeCaps[connection.backendKind];
    if (!caps) return null;
    return checkStructuredOutputReadiness({ capabilities: caps }).startsWith(
      "ELIGIBLE",
    );
  };

  // TEXT_ONLY interview execution needs the runtime's local one-shot
  // invocation. null = unknown (no desktop bridge) — marking is skipped.
  const textOnlyReady = (connection: ConnectionSummary): boolean | null => {
    const caps = runtimeCaps[connection.backendKind];
    if (!caps) return null;
    return caps.implemented === true && caps.execution?.localOneShot === true;
  };

  // Streaming consumers need verified incremental output — the same
  // unknown-bridge convention as above: null skips marking entirely.
  const streamingReady = (connection: ConnectionSummary): boolean | null => {
    const caps = runtimeCaps[connection.backendKind];
    if (!caps) return null;
    return caps.implemented === true && caps.execution?.streaming === true;
  };

  const save = async (purpose: string) => {
    const draft = drafts[purpose];
    if (!draft?.connectionId || !draft.model.trim()) {
      toastError(t("settings.aiAssignErrModelRequired"));
      return;
    }
    // Structured purposes reject connections on runtimes whose structured
    // output is not verified — saving a known-unrunnable assignment would
    // surface later as a confusing execution failure.
    if (STRUCTURED_PURPOSES.has(purpose)) {
      const connection = connections.find((c) => c.id === draft.connectionId);
      if (connection && structuredReady(connection) === false) {
        toastError(t("settings.aiAssignStructuredNotVerified"));
        return;
      }
    }
    if (TEXT_ONLY_PURPOSES.has(purpose)) {
      const connection = connections.find((c) => c.id === draft.connectionId);
      if (connection && textOnlyReady(connection) === false) {
        toastError(t("settings.aiAssignTextOnlyNotReady"));
        return;
      }
    }
    if (STREAMING_PURPOSES.has(purpose)) {
      const connection = connections.find((c) => c.id === draft.connectionId);
      if (connection && streamingReady(connection) === false) {
        toastError(t("settings.aiAssignStreamingNotReady"));
        return;
      }
    }
    setBusy(`save:${purpose}`);
    try {
      const result = await setBusinessAiAssignment({
        purpose,
        connectionId: draft.connectionId,
        model: draft.model.trim(),
      });
      if (result.success) {
        toastSuccess(t("settings.aiAssignSaved"));
        await load();
      } else {
        toastError(t(ERROR_KEY[result.code ?? ""] ?? "settings.aiConnErrGeneric"));
      }
    } finally {
      setBusy(null);
    }
  };

  const clear = async (purpose: string) => {
    setBusy(`clear:${purpose}`);
    try {
      const result = await clearBusinessAiAssignment({ purpose });
      if (result.success) {
        toastSuccess(t("settings.aiAssignCleared"));
        await load();
      } else {
        toastError(t(ERROR_KEY[result.code ?? ""] ?? "settings.aiConnErrGeneric"));
      }
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 rounded-lg border p-4">
        <div>
          <h3 className="text-lg font-medium">{t("settings.aiAssignTitle")}</h3>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("settings.loadingSettings")}
        </div>
      </div>
    );
  }

  const draftFor = (purpose: string): Draft =>
    drafts[purpose] ?? { connectionId: "", model: "" };

  const renderPurposeRow = (purpose: string) => {
    const draft = draftFor(purpose);
    const saved = assignments[purpose];
    const selectedConnection = connections.find(
      (c) => c.id === draft.connectionId,
    );
    const catalog = draft.connectionId
      ? catalogs[draft.connectionId]
      : undefined;
    const dirty =
      !!draft.connectionId &&
      !!draft.model.trim() &&
      (saved?.connectionId !== draft.connectionId ||
        saved?.model !== draft.model.trim());
    const isStructuredPurpose = STRUCTURED_PURPOSES.has(purpose);
    const isTextOnlyPurpose = TEXT_ONLY_PURPOSES.has(purpose);
    const isStreamingPurpose = STREAMING_PURPOSES.has(purpose);

    return (
      <section key={purpose} className="rounded-md border p-3 space-y-3">
        <h4 className="font-medium">{t(PURPOSE_LABEL_KEY[purpose])}</h4>
        {isStructuredPurpose && (
          <p className="text-xs text-muted-foreground">
            {t("settings.aiAssignStructuredHint")}
          </p>
        )}
        {isStreamingPurpose && (
          <p className="text-xs text-muted-foreground">
            {t("settings.aiAssignStreamingHint")}
          </p>
        )}
        {/* INTERVIEW coexistence note: what a new session would resolve to
            today, and the locked-session guarantee for existing ones. */}
        {purpose === "INTERVIEW" && (
          <p className="text-xs text-muted-foreground">
            {interview?.status === "LEGACY_INTERVIEW_CONFIG"
              ? t("settings.aiAssignInterviewLegacy", {
                  provider: interview.provider ?? "",
                  model: interview.model ?? "",
                })
              : interview?.status === "RESOLVED" &&
                  interview.source === "GLOBAL_DEFAULT"
                ? t("settings.aiAssignInterviewGlobalDefault")
                : interview?.status === "RESOLVED"
                  ? t("settings.aiAssignInterviewConfigured")
                  : interview?.status === "INVALID_ASSIGNMENT"
                  ? t("settings.aiAssignInterviewInvalid", {
                      code: interview.code ?? "",
                    })
                  : t("settings.aiAssignInterviewDeferred")}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[240px]">
            <Label className="text-xs text-muted-foreground">
              {t("settings.aiAssignConnection")}
            </Label>
            <Select
              value={draft.connectionId || undefined}
              onValueChange={(value) =>
                setDraft(purpose, { connectionId: value, model: "" })
              }
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue
                  placeholder={t("settings.aiAssignSelectConnection")}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {connections.map((connection) => {
                    const eligible = isStructuredPurpose
                      ? structuredReady(connection)
                      : isTextOnlyPurpose
                        ? textOnlyReady(connection)
                        : isStreamingPurpose
                          ? streamingReady(connection)
                          : null;
                    const ineligibleKey = isStructuredPurpose
                      ? "settings.aiAssignStructuredNotVerified"
                      : isTextOnlyPurpose
                        ? "settings.aiAssignTextOnlyNotReady"
                        : "settings.aiAssignStreamingNotReady";
                    return (
                      <SelectItem
                        key={connection.id}
                        value={connection.id}
                        disabled={eligible === false}
                      >
                        {connectionLabel(connection)}
                        {eligible === false ? ` — ${t(ineligibleKey)}` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[200px]">
            <Label className="text-xs text-muted-foreground">
              {t("settings.aiAssignModel")}
            </Label>
            <Input
              className="mt-1"
              value={draft.model}
              placeholder={t("settings.aiAssignSelectModel")}
              disabled={!draft.connectionId}
              onChange={(event) =>
                setDraft(purpose, { model: event.target.value })
              }
            />
          </div>

          {draft.connectionId && (
            <Button
              variant="outline"
              size="sm"
              disabled={catalogBusy === draft.connectionId}
              onClick={() =>
                selectedConnection && void loadCatalog(selectedConnection)
              }
            >
              {catalogBusy === draft.connectionId && (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              )}
              {t("settings.aiAssignLoadModels")}
            </Button>
          )}
        </div>

        {/* Runtime model catalog (account-visible) — choosing an entry
            fills the model field; a custom model id may also be typed
            directly. Availability is re-validated at execution time. */}
        {catalog && catalog.length > 0 && (
          <Select
            value={undefined}
            onValueChange={(value) => setDraft(purpose, { model: value })}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("settings.aiAssignCatalogHint")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {catalog.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.displayName} ({entry.id})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy !== null || !dirty}
            onClick={() => void save(purpose)}
          >
            {busy === `save:${purpose}` && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            )}
            {t("common.save")}
          </Button>
          {saved && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void clear(purpose)}
            >
              {t("settings.aiAssignClear")}
            </Button>
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-lg font-medium">{t("settings.aiAssignTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("settings.aiAssignDescription")}
        </p>
      </div>

      {connections.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("settings.aiAssignNoConnections")}
        </p>
      )}

      {EDITABLE_PURPOSES.map(renderPurposeRow)}
    </div>
  );
}

export default AiAssignmentsCard;
