"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { GripVertical, Loader2 } from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";
import { AI_CONFIGURATION_CHANGED_EVENT } from "@/lib/ai/client-events";
import {
  listAssignableAiConnections,
  mintAiConnectionTicket,
} from "@/actions/aiConnection.actions";
import {
  clearBusinessAiAssignment,
  listBusinessAiAssignments,
  resolveBusinessAiConfig,
  setBusinessAiAssignment,
} from "@/actions/aiAssignment.actions";
import {
  assignManagedBusinessAiSource,
  getManagedAiOverview,
  type ManagedAiOverview,
} from "@/actions/managedAi.actions";
import type { ConnectionSummary } from "@/lib/ai/connection-service";
import type { BusinessAssignmentSummary } from "@/lib/ai/assignments";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  checkStreamingExecutionReadiness,
  checkStructuredOutputReadiness,
  type AccountRuntimeCapabilities,
} from "@/lib/ai/runtime/capabilities";
import {
  AI_STREAMING_PURPOSES,
  BYOK_API_KEY_PROVIDERS,
  BYOK_BACKEND_KIND,
} from "@/lib/ai/connections";
import { PROVIDER_REGISTRY, SETTINGS_BYOK_PROVIDERS } from "@/lib/ai/provider-registry";

// GLOBAL_DEFAULT is the resolution fallback, not a business purpose — it
// renders as its own full-width row above the business grid. The business
// rows render in registry order by default; the grid order is a per-device
// display preference the user can change by dragging (it has no effect on
// assignment resolution). INTERVIEW and CAREER_REFLECTION both execute
// through the account runtime's TEXT_ONLY one-shot seam (interview sessions
// locked at creation, reflection drafts resolved at generation); a legacy
// `settings.ai.interview` config still outranks GLOBAL_DEFAULT for users
// who have not saved an INTERVIEW assignment. Every registry purpose now
// has a real production consumer on every surface — MATCH_ANALYSIS
// included, since the fresh-native fast-screening flow resolves it — so
// all rows render editable.
const GLOBAL_DEFAULT_PURPOSE = "GLOBAL_DEFAULT";
const BUSINESS_PURPOSE_ROWS = [
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
  MANAGED_NOT_LAUNCHED: "settings.aiAssignManagedComingSoon",
  NOT_ENTITLED: "settings.aiAssignErrNotEntitled",
  MODEL_NOT_ALLOWED: "settings.aiAssignErrModelNotAllowed",
};

// Purposes whose execution path is structured output. Connections whose
// runtime has not passed managed structured verification are marked (and
// rejected on save) for these purposes only — they remain fully usable for
// TEXT_ONLY purposes like MATCH_ANALYSIS.
const STRUCTURED_PURPOSES = new Set<string>(["RESUME"]);

// Purposes whose execution path is a TEXT_ONLY one-shot on the account
// runtime (interview sessions, reflection drafts). Connections on
// runtimes without local one-shot execution are marked (and rejected on
// save) for these purposes.
const TEXT_ONLY_PURPOSES = new Set<string>(["INTERVIEW", "CAREER_REFLECTION"]);

// Purposes whose execution path streams assistant output to the user
// (Career Dialogue renders tokens as they arrive — a buffered one-shot
// would be fake streaming). Connections on runtimes without verified
// incremental output are marked and rejected on save; unlike the other
// gates this one is fail-closed — when the capability bridge is absent
// the runtime counts as unverifiable rather than silently compatible.
const STREAMING_PURPOSES = new Set<string>(AI_STREAMING_PURPOSES);

// The Managed source is system-provisioned — pickers offer a sentinel
// option instead of the real connection id (which callers never choose
// themselves); the save path routes it to assignManagedBusinessSource.
const MANAGED_CONNECTION_ID = "__managed__";

type Draft = { connectionId: string; model: string };

function assignmentDraft(assignment: BusinessAssignmentSummary): Draft {
  return {
    connectionId: assignment.connection?.backendKind === "MANAGED_GATEWAY"
      ? MANAGED_CONNECTION_ID : assignment.connectionId,
    model: assignment.model,
  };
}

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
  // displayName already carries the product + runtime (e.g. "ChatGPT via
  // Codex", "OpenCode Go") so two accounts on the same runtime stay
  // visually distinct.
  const identity = connection.accountIdentity
    ? ` · ${connection.accountIdentity}`
    : "";
  return `${connection.displayName}${identity} (${connection.status})`;
}

// Sortable wrapper for one business-purpose card. The handle is rendered
// inside the card header — listeners live on the handle only, so the
// connection picker, model input and buttons never initiate a drag.
function SortablePurposeCard({
  purpose,
  children,
}: {
  purpose: string;
  children: (dragHandle: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: purpose });
  const dragHandle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={t("settings.aiAssignDragToReorder")}
      title={t("settings.aiAssignDragToReorder")}
      data-testid={`ai-assign-drag-${purpose}`}
      className="inline-flex shrink-0 touch-none cursor-grab items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
    >
      <GripVertical className="h-4 w-4" />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
      }}
      className={`h-full min-w-0 ${isDragging ? "relative z-10 opacity-70" : ""}`}
    >
      {children(dragHandle)}
    </div>
  );
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
  const [loadFailed, setLoadFailed] = useState(false);
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
  // (plain web/dev) — marking is skipped for advisory gates; streaming
  // purposes treat absence as unverifiable instead.
  const [runtimeCaps, setRuntimeCaps] = useState<
    Record<string, AccountRuntimeCapabilities>
  >({});
  // backendKind → probed installed version. Streaming verification is
  // bound to an exact runtime version, so the readiness check needs the
  // live probe, not just the static descriptor.
  const [runtimeVersions, setRuntimeVersions] = useState<
    Record<string, string | null>
  >({});
  // The Managed source's live state: its provisioned connection plus the
  // catalog models the Hosted authority currently offers. null = Hosted
  // unreachable — the Managed option still renders with its error code.
  const [managed, setManaged] = useState<ManagedAiOverview | null>(null);
  // Business-grid display order — a per-device cosmetic preference kept in
  // localStorage; GLOBAL_DEFAULT is not part of it.
  const [rowOrder, setRowOrder] = useState<string[]>([
    ...BUSINESS_PURPOSE_ROWS,
  ]);
  // A small activation distance keeps clicks on the handle from becoming
  // accidental drags; the keyboard sensor lets a focused handle reorder
  // with Space + arrows.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    // Read the stored order after mount (the store is client-only). Unknown
    // entries are dropped and newly added purposes appended so a stale
    // stored order can never hide a row.
    try {
      const raw = window.localStorage.getItem(
        APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY,
      );
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const known = new Set<string>(BUSINESS_PURPOSE_ROWS);
      const stored = [
        ...new Set(
          parsed.filter(
            (purpose): purpose is string =>
              typeof purpose === "string" && known.has(purpose),
          ),
        ),
      ];
      if (stored.length === 0) return;
      setRowOrder([
        ...stored,
        ...BUSINESS_PURPOSE_ROWS.filter(
          (purpose) => !stored.includes(purpose),
        ),
      ]);
    } catch {
      // A corrupt or unavailable store falls back to the registry order.
    }
  }, []);

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRowOrder((previous) => {
      const from = previous.indexOf(String(active.id));
      const to = previous.indexOf(String(over.id));
      if (from < 0 || to < 0) return previous;
      const next = arrayMove(previous, from, to);
      try {
        window.localStorage.setItem(
          APP_CONSTANTS.AI_ASSIGNMENT_ORDER_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // The reorder still applies for this session.
      }
      return next;
    });
  };

  const load = useCallback(async (savedPurpose?: string) => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const [connResult, assignResult, interviewResult, managedResult] = await Promise.all([
        listAssignableAiConnections(),
        listBusinessAiAssignments(),
        resolveBusinessAiConfig({ purpose: "INTERVIEW" }).catch(() => ({ success: false, data: undefined })),
        getManagedAiOverview().catch(() => ({ success: false, data: undefined })),
      ]);
      if (managedResult.success && managedResult.data) {
        setManaged(managedResult.data);
      }
      const runtime = window.vocatryaRuntime;
      if (runtime) {
        try {
          const runtimes = await runtime.list();
          const next: Record<string, AccountRuntimeCapabilities> = {};
          const versions: Record<string, string | null> = {};
          for (const entry of runtimes) {
            if (entry.capabilities) next[entry.backendKind] = entry.capabilities;
            versions[entry.backendKind] = null;
          }
          // Version probes run `runtime --version` — cheap and bounded —
          // and the streaming gate is meaningless without them.
          await Promise.all(
            Object.keys(versions).map(async (backendKind) => {
              try {
                const probe = await runtime.getVersion(backendKind);
                versions[backendKind] = probe?.version ?? null;
              } catch {
                versions[backendKind] = null;
              }
            }),
          );
          setRuntimeCaps(next);
          setRuntimeVersions(versions);
        } catch {
          // Capability lookup is advisory — never block the card on it.
        }
      }
      if (connResult.success && connResult.data) {
        setConnections(connResult.data.filter((connection) =>
          connection.backendKind !== BYOK_BACKEND_KIND ||
          SETTINGS_BYOK_PROVIDERS.some((provider) => provider.toUpperCase() === connection.provider),
        ));
      }
      if (!assignResult.success || !assignResult.data) {
        throw new Error(assignResult.message || t("settings.aiConnErrGeneric"));
      }
      const nextAssignments: Record<string, BusinessAssignmentSummary> = {};
      const nextDrafts: Record<string, Draft> = {};
      for (const assignment of assignResult.data) {
        nextAssignments[assignment.purpose] = assignment;
        nextDrafts[assignment.purpose] = assignmentDraft(assignment);
      }
      setAssignments(nextAssignments);
      setDrafts((previous) => savedPurpose
        ? { ...previous, [savedPurpose]: nextDrafts[savedPurpose] ?? { connectionId: "", model: "" } }
        : nextDrafts);
      if (interviewResult.success && interviewResult.data) {
        setInterview(interviewResult.data);
      }
    } catch {
      setLoadFailed(true);
      toastError(t("settings.aiAssignLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
      // BYOK connections discover models through the provider's own
      // /api/ai/* listing route — the same route the legacy settings used;
      // there is no runtime ticket to mint.
      if (connection.backendKind === BYOK_BACKEND_KIND) {
        const apiKeyProvider =
          BYOK_API_KEY_PROVIDERS[
            connection.provider as keyof typeof BYOK_API_KEY_PROVIDERS
          ];
        const registryEntry = apiKeyProvider
          ? PROVIDER_REGISTRY[apiKeyProvider]
          : undefined;
        if (!registryEntry?.modelsEndpoint) {
          toastError(t("settings.aiConnErrModelUnavailable"));
          return;
        }
        setCatalogBusy(connection.id);
        try {
          const response = await fetch(`/api/ai/${registryEntry.modelsEndpoint}`);
          const data = await response.json();
          const modelIds = response.ok
            ? registryEntry.parseModelsResponse?.(data) ?? []
            : [];
          if (modelIds.length > 0) {
            setCatalogs((prev) => ({
              ...prev,
              [connection.id]: modelIds.map((id) => ({
                id,
                displayName: id,
                source: "byok",
                availability: "available",
              })),
            }));
          } else {
            toastError(t("settings.aiConnErrModelUnavailable"));
          }
        } catch {
          toastError(t("settings.aiConnErrModelUnavailable"));
        } finally {
          setCatalogBusy(null);
        }
        return;
      }
      const ai = window.vocatryaAi;
      if (!ai) {
        toastError(t("settings.aiConnErrBackendUnavailable"));
        return;
      }
      setCatalogBusy(connection.id);
      try {
        const ticketResult = await mintAiConnectionTicket({
          operation: "listModels",
          backendKind: connection.backendKind,
          connectionId: connection.id,
        });
        if (!ticketResult.success || !ticketResult.data) {
          toastError(ticketResult.message || t("settings.aiConnErrGeneric"));
          return;
        }
        const result = await ai.listModels({
          connectionId: connection.id,
          ticket: ticketResult.data.ticket,
        });
        if (result.ok && result.models) {
          setCatalogs((prev) => ({ ...prev, [connection.id]: result.models! }));
        } else {
          toastError(t("settings.aiConnErrModelUnavailable"));
        }
      } catch {
        toastError(t("settings.aiConnErrModelUnavailable"));
      } finally {
        setCatalogBusy(null);
      }
    },
    [t],
  );

  const isByokConnection = (connection: ConnectionSummary): boolean =>
    connection.backendKind === BYOK_BACKEND_KIND;

  // null = unknown (no desktop bridge); true/false = verified verdict.
  // BYOK structured output runs PROMPT_AND_VALIDATE in-process — there is
  // no runtime verification surface, so it is never marked unverified.
  const structuredReady = (connection: ConnectionSummary): boolean | null => {
    if (isByokConnection(connection)) return true;
    const caps = runtimeCaps[connection.backendKind];
    if (!caps) return null;
    return checkStructuredOutputReadiness({ capabilities: caps }).startsWith(
      "ELIGIBLE",
    );
  };

  // TEXT_ONLY interview execution needs the runtime's local one-shot
  // invocation. BYOK executes the one-shot in-process — always ready.
  // null = unknown (no desktop bridge) — marking is skipped.
  const textOnlyReady = (connection: ConnectionSummary): boolean | null => {
    if (isByokConnection(connection)) return true;
    const caps = runtimeCaps[connection.backendKind];
    if (!caps) return null;
    return caps.implemented === true && caps.execution?.localOneShot === true;
  };

  // Streaming consumers need verified incremental output AND a verified
  // structured-decision step (Career Dialogue runs both), both bound to
  // the probed runtime version. null = capability bridge absent — callers
  // treat that as unverifiable (fail-closed), not as compatible.
  // Returns the stable block code, "UNVERIFIABLE" when the bridge is
  // missing, or null when ready.
  const streamingBlockReason = (
    connection: ConnectionSummary,
  ): string | null => {
    // BYOK streams natively through the AI SDK — real incremental output,
    // no runtime verification surface exists to consult.
    if (isByokConnection(connection)) return null;
    const caps = runtimeCaps[connection.backendKind];
    if (!caps) return "UNVERIFIABLE";
    const runtimeVersion = runtimeVersions[connection.backendKind];
    const verdict = checkStreamingExecutionReadiness({
      capabilities: caps,
      // Capability question only — a re-auth-pending connection on a
      // verified runtime stays assignable; the label already shows the
      // status and the turn gate re-checks it at run time.
      connectionStatus: "CONNECTED",
      permissionScope: "TEXT_ONLY",
      runtimeVersion,
    });
    if (!verdict.ready) return verdict.code;
    const structured = caps.structuredOutput;
    if (
      !structured ||
      structured.strategy === "UNSUPPORTED" ||
      structured.verification !== "PASS" ||
      !structured.verifiedRuntimeVersion ||
      runtimeVersion !== structured.verifiedRuntimeVersion
    ) {
      return "STRUCTURED_OUTPUT_NOT_VERIFIED";
    }
    return null;
  };

  const refreshInterviewPreview = (purpose: string) => {
    if (purpose !== "INTERVIEW" && purpose !== "GLOBAL_DEFAULT") return;
    void resolveBusinessAiConfig({ purpose: "INTERVIEW" }).then((result) => {
      if (result.success && result.data) setInterview(result.data);
    }).catch(() => undefined);
  };

  const applySaved = (assignment: BusinessAssignmentSummary) => {
    setAssignments((previous) => ({ ...previous, [assignment.purpose]: assignment }));
    setDrafts((previous) => ({ ...previous, [assignment.purpose]: assignmentDraft(assignment) }));
    refreshInterviewPreview(assignment.purpose);
    window.dispatchEvent(new Event(AI_CONFIGURATION_CHANGED_EVENT));
    toastSuccess(t("settings.aiAssignSaved"));
  };

  const save = async (purpose: string) => {
    const draft = drafts[purpose];
    if (!draft?.connectionId || !draft.model.trim()) {
      toastError(t("settings.aiAssignErrModelRequired"));
      return;
    }
    if (draft.connectionId === MANAGED_CONNECTION_ID) {
      // The Managed source saves through its own entry point — the model
      // is a Hosted catalog modelKey validated against the live catalog.
      setBusy(`save:${purpose}`);
      try {
        const result = await assignManagedBusinessAiSource({
          purpose,
          modelKey: draft.model.trim(),
        });
        if (result.success) {
          if (result.data) applySaved(result.data);
          else await load(purpose);
        } else {
          toastError(
            t(ERROR_KEY[result.code ?? ""] ?? "settings.aiConnErrGeneric"),
          );
        }
      } catch {
        toastError(t("settings.aiAssignSaveUnconfirmed"));
      } finally {
        setBusy(null);
      }
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
      const block = connection ? streamingBlockReason(connection) : null;
      if (connection && block !== null) {
        toastError(
          t(
            block === "UNVERIFIABLE"
              ? "settings.aiAssignStreamingUnverifiable"
              : block === "STRUCTURED_OUTPUT_NOT_VERIFIED"
                ? "settings.aiAssignStructuredNotVerified"
                : "settings.aiAssignStreamingNotReady",
          ),
        );
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
        if (result.data) applySaved(result.data);
        else await load(purpose);
      } else {
        toastError(t(ERROR_KEY[result.code ?? ""] ?? "settings.aiConnErrGeneric"));
      }
    } catch {
      toastError(t("settings.aiAssignSaveUnconfirmed"));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (purpose: string) => {
    setBusy(`clear:${purpose}`);
    try {
      const result = await clearBusinessAiAssignment({ purpose });
      if (result.success) {
        refreshInterviewPreview(purpose);
        toastSuccess(t("settings.aiAssignCleared"));
        window.dispatchEvent(new Event(AI_CONFIGURATION_CHANGED_EVENT));
        setAssignments((previous) => {
          const next = { ...previous };
          delete next[purpose];
          return next;
        });
        setDrafts((previous) => ({ ...previous, [purpose]: { connectionId: "", model: "" } }));
      } else {
        toastError(t(ERROR_KEY[result.code ?? ""] ?? "settings.aiConnErrGeneric"));
      }
    } catch {
      toastError(t("settings.aiAssignSaveUnconfirmed"));
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

  // Managed catalog entries ride the same catalog dropdown as runtime
  // model lists — populated from the live Hosted overview on load.
  const managedCatalog: ModelEntry[] = (managed?.models ?? []).map((m) => ({
    id: m.modelKey,
    displayName: m.displayName,
    source: "managed",
    availability: "available",
  }));
  const managedAvailable = managed?.connection?.status === "CONNECTED";

  const renderPurposeRow = (purpose: string, dragHandle?: ReactNode) => {
    const draft = draftFor(purpose);
    const saved = assignments[purpose];
    const selectedConnection = connections.find(
      (c) => c.id === draft.connectionId,
    );
    const catalog =
      draft.connectionId === MANAGED_CONNECTION_ID
        ? managedCatalog
        : draft.connectionId
          ? catalogs[draft.connectionId]
          : undefined;
    const savedConnectionId = saved ? assignmentDraft(saved).connectionId : undefined;
    const dirty =
      !!draft.connectionId &&
      !!draft.model.trim() &&
      (savedConnectionId !== draft.connectionId ||
        saved?.model !== draft.model.trim());
    const isStructuredPurpose = STRUCTURED_PURPOSES.has(purpose);
    const isTextOnlyPurpose = TEXT_ONLY_PURPOSES.has(purpose);
    const isStreamingPurpose = STREAMING_PURPOSES.has(purpose);

    return (
      <section
        key={purpose}
        className="h-full rounded-md border p-3 space-y-3"
        data-testid={`ai-assign-row-${purpose}`}
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="font-medium">{t(PURPOSE_LABEL_KEY[purpose])}</h4>
          {dragHandle}
        </div>
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
          <div className="min-w-0 flex-1 basis-60">
            <Label className="text-xs text-muted-foreground">
              {t("settings.aiAssignConnection")}
            </Label>
            <Select
              value={draft.connectionId || undefined}
              disabled={busy === `save:${purpose}` || busy === `clear:${purpose}`}
              onValueChange={(value) =>
                value !== draft.connectionId && setDraft(purpose, { connectionId: value, model: "" })
              }
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue
                  placeholder={t("settings.aiAssignSelectConnection")}
                />
              </SelectTrigger>
              <SelectContent>
                {saved && draft.connectionId === savedConnectionId &&
                  !connections.some((connection) => connection.id === draft.connectionId) &&
                  !(draft.connectionId === MANAGED_CONNECTION_ID && managedAvailable) && (
                    <SelectItem value={draft.connectionId} disabled>
                      {saved.connection
                        ? `${saved.connection.displayName} (${saved.connection.status})`
                        : t("settings.aiAssignErrConnectionNotFound")}
                    </SelectItem>
                  )}
                {managedAvailable && (
                  <SelectGroup>
                    <SelectLabel>{t("settings.aiAssignManagedGroup")}</SelectLabel>
                    <SelectItem value={MANAGED_CONNECTION_ID}>
                      {t("settings.aiAssignManagedOption")}
                    </SelectItem>
                  </SelectGroup>
                )}
                <SelectGroup>
                  <SelectLabel>{t("settings.aiAssignLocalGroup")}</SelectLabel>
                  {connections.map((connection) => {
                    const eligible = isStructuredPurpose
                      ? structuredReady(connection)
                      : isTextOnlyPurpose
                        ? textOnlyReady(connection)
                        : null;
                    const streamBlock = isStreamingPurpose
                      ? streamingBlockReason(connection)
                      : null;
                    const ineligibleKey = isStructuredPurpose
                      ? "settings.aiAssignStructuredNotVerified"
                      : isTextOnlyPurpose
                        ? "settings.aiAssignTextOnlyNotReady"
                        : streamBlock === "UNVERIFIABLE"
                          ? "settings.aiAssignStreamingUnverifiable"
                          : streamBlock === "STRUCTURED_OUTPUT_NOT_VERIFIED"
                            ? "settings.aiAssignStructuredNotVerified"
                            : "settings.aiAssignStreamingNotReady";
                    // Streaming purposes fail closed: an unverifiable
                    // runtime (bridge absent) is just as unassignable as
                    // a verified-incompatible one.
                    const blocked = isStreamingPurpose
                      ? streamBlock !== null
                      : eligible === false;
                    return (
                      <SelectItem
                        key={connection.id}
                        value={connection.id}
                        disabled={blocked}
                      >
                        {connectionLabel(connection)}
                        {blocked ? ` — ${t(ineligibleKey)}` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0 flex-1 basis-48">
            <Label className="text-xs text-muted-foreground">
              {t("settings.aiAssignModel")}
            </Label>
            <Input
              className="mt-1"
              value={draft.model}
              placeholder={t("settings.aiAssignSelectModel")}
              disabled={!draft.connectionId || busy === `save:${purpose}` || busy === `clear:${purpose}`}
              onChange={(event) =>
                setDraft(purpose, { model: event.target.value })
              }
            />
          </div>

          {draft.connectionId && draft.connectionId !== MANAGED_CONNECTION_ID && (
            <Button
              variant="outline"
              size="sm"
              disabled={!selectedConnection || catalogBusy === draft.connectionId}
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

      {loadFailed && (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm">
          <p>{t("settings.aiAssignLoadFailed")}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>{t("common.retry")}</Button>
        </div>
      )}
      {!loadFailed && connections.length === 0 && !managedAvailable && (
        <p className="text-sm text-muted-foreground">
          {t("settings.aiAssignNoConnections")}
        </p>
      )}
      {managed && managed.errorCode && managedAvailable === false && (
        <p className="text-sm text-muted-foreground">
          {t("settings.aiAssignManagedUnavailable", {
            code: managed.errorCode,
          })}
        </p>
      )}

      {(!loadFailed || Object.keys(assignments).length > 0) && (
        <div className="space-y-5">
          {renderPurposeRow(GLOBAL_DEFAULT_PURPOSE)}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <h4 className="text-sm font-medium">
                {t("settings.aiAssignBusinessPurposes")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t("settings.aiAssignOrderHint")}
              </p>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={rowOrder}
                strategy={rectSortingStrategy}
              >
                <div className="grid min-w-0 gap-3 @3xl/main:grid-cols-2">
                  {rowOrder.map((purpose) => (
                    <SortablePurposeCard key={purpose} purpose={purpose}>
                      {(dragHandle) => renderPurposeRow(purpose, dragHandle)}
                    </SortablePurposeCard>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>
      )}
    </div>
  );
}

export default AiAssignmentsCard;
