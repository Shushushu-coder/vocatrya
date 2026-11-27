import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  isAgentFilePart,
  isAgentPastePart,
  type PageContext,
} from "@/models/agent.model";
import { agentFilePlaceholder } from "./agentFiles";
import { readMessageAgentRole, roleAttributionTag } from "./unifiedChatTypes";
import {
  CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
  resolveCareerDialogueBudgets,
  resolveModelContextWindow,
  type CareerDialogueContextBudgets,
} from "./modelContextWindow";
import {
  buildFileContextMessage,
  buildPageContextMessage,
  buildPasteContextMessage,
} from "./prompt";
import {
  MICRO_COMPACT_KEEP_RECENT_TOOLS,
  MICRO_COMPACT_MIN_TOKENS,
  microCompactToolOutputLine,
  microCompactToolOutputValue,
  shouldMicroCompactToolOutput,
} from "./toolMicroCompact";

export {
  CAREER_DIALOGUE_ASSEMBLED_CAP_TOKENS,
  resolveCareerDialogueBudgets,
  resolveModelContextWindow,
  type CareerDialogueContextBudgets,
};

/**
 * Provider-neutral Career Dialogue context budget.
 *
 * Size unit: a deterministic estimate, not a model tokenizer. The repo's
 * existing estimator is `AGENT_CHAT_CHARS_PER_TOKEN` (4), which matches
 * rough English BPE and under-counts Simplified Chinese. P2 keeps that
 * divisor for non-CJK text and counts each CJK, kana, or hangul character
 * as one unit so the default locale is not under-budgeted. No tokenizer
 * package is added. This module never calls a model.
 *
 * L1 micro-compact folds older bulky tool outputs (keeping recent 1–2 tool
 * calls verbatim) in the prompt view without mutating stored messages.
 *
 * Drop order when over the dynamic or assembled budget (L2 fixed priority):
 *   1. micro-compact non-protected historical tool
 *   2. oldest non-protected historical tool line
 *   3. oldest complete history turn
 *   4. page-context line
 *   5. extreme overflow: micro-compact/drop newest historical tool & remaining turns
 *   6. last resort only: valid summary
 *
 * Never dropped and never sliced: fixed instructions, the current user
 * message, approval state, the current paste head, the current tool
 * result, verified L3 business anchors (unless over `businessAnchorTokens`),
 * and (task sessions only) the system-maintained task handoff line.
 * A current user message over `currentUserTokens` is rejected.
 */

export const CAREER_DIALOGUE_CONTEXT_BUDGETS: CareerDialogueContextBudgets =
  resolveCareerDialogueBudgets().budgets;

export type CareerDialogueContextProfile =
  | "FAST_CHAT"
  | "AGENT_DECISION"
  | "AGENT_RESPONSE";

export type CareerDialogueContextSize = {
  contextProfile: CareerDialogueContextProfile;
  systemChars: number;
  systemTokens: number;
  currentUserChars: number;
  currentUserTokens: number;
  historyChars: number;
  historyTokens: number;
  explicitContextChars: number;
  explicitContextTokens: number;
  toolResultChars: number;
  toolResultTokens: number;
  summaryChars: number;
  summaryTokens: number;
  /** Verified L3 business anchor block as included (0 when absent or dropped). */
  businessAnchorChars: number;
  businessAnchorTokens: number;
  businessAnchorDropped: boolean;
  /** Task handoff line as included (0 when absent or dropped). */
  handoffChars: number;
  handoffTokens: number;
  /** True when a supplied handoff line exceeded `handoffTokens`. */
  handoffDropped: boolean;
  /** M2 cross-session memory block as included (0 when absent or dropped). */
  longTermMemoryChars: number;
  longTermMemoryTokens: number;
  longTermMemoryDropped: boolean;
  /** Count of historical tool results folded by L1 micro-compaction. */
  microCompactedToolCount: number;
  /** Count of older history turns covered & folded by an active summary. */
  compactedTurnCount: number;
  /** True when extreme overflow forced dropping the summary last-resort. */
  summaryDroppedForOverflow: boolean;
  /** True when assembled size hits auto-compact threshold or overflowed summary. */
  needsRecompaction: boolean;
  dynamicChars: number;
  dynamicTokens: number;
  estimatedInputTokens: number;
  recentTurnCount: number;
  droppedTurnCount: number;
};

export type SessionToolFact = {
  name: string;
  output?: unknown;
  /** Decline / failure narration. Used instead of `output` when set. */
  line?: string;
};

export type CareerDialogueContextInput = {
  profile: CareerDialogueContextProfile;
  messages: UIMessage[];
  pageContext?: PageContext;
  /** Already head-truncated paste block. The budgeter does not fetch data. */
  pasteBlock?: string;
  /**
   * Extracted file text for the current send (AWU-FILES), already wrapped
   * by truncateForModel. Injected like the paste: on the arriving turn only,
   * protected from auto-drop, charged to explicitContextTokens.
   */
  fileBlocks?: { name: string; block: string }[];
  /**
   * Fresh transcript-compression cache, already validated by the caller.
   * Omitted when missing, stale, legacy, or over the summary budget.
   */
  summary?: string | { text: string; throughMessageId: string } | null;
  /** Tool results produced in this turn and not yet on `messages`. */
  sessionFacts?: SessionToolFact[];
  systemText?: string;
  /** Instructions + schemas that cannot be dropped. */
  fixedOverheadText?: string;
  budgets?: Partial<CareerDialogueContextBudgets>;
  /**
   * Trusted fresh + full A+B: the page line may name add_job and must not
   * point the model at match_job or generate_cover_letter.
   */
  freshNativeFull?: boolean;
  /**
   * Multi-agent role from the persisted conversation row — selects the
   * role-scoped page line so a turn never steers toward a tool the role
   * does not register.
   */
  agentRole?: string | null;
  /**
   * ChatConversation.agentTaskId. The handoff line is honored only when this
   * is set, so a non-task conversation can never receive one.
   */
  agentTaskId?: string | null;
  /**
   * Rendered, system-maintained task state (already verified by the caller).
   * Never dropped by the budgeter; see the file header.
   */
  handoffLine?: string;
  /**
   * L3 post-compaction SQLite-verified business anchors (bound job/JD, resume
   * version, today_plan). Protected from `dropLowest` like `handoffLine`.
   */
  businessAnchorLine?: string;
  /**
   * M2 cross-session long-term memory block (untrusted user preference
   * notes). A separate budget section from the L3 business anchor —
   * rendered only when the caller supplies it; protected from `dropLowest`.
   */
  longTermMemoryLine?: string;
  /** Auto-compact trigger threshold (assembled tokens) for `needsRecompaction`. */
  autoCompactTriggerTokens?: number;
  /** Optional L1 micro-compact overrides for tests. */
  microCompact?: {
    keepRecentTools?: number;
    minTokens?: number;
  };
};

export type CareerDialogueContextSuccess = {
  ok: true;
  transcript: string;
  retainedMessages: UIMessage[];
  explicitLines: string[];
  summary?: string;
  size: CareerDialogueContextSize;
  /**
   * Complete history turns after dynamic-budget drops, excluding the
   * current turn. Oldest first. Summary coverage is derived from this.
   */
  historyBoundary: CareerDialogueHistoryBoundary;
};

export type CareerDialogueHistoryBoundary = {
  droppedTurnCount: number;
  droppedTurns: string[][];
  retainedHistoryTurns: string[][];
};

export type CareerDialogueTurnIndexSpan = {
  firstIndex: number;
  lastIndex: number;
  messageIds: string[];
  complete: boolean;
  inHistoryPool: boolean;
};

export type CareerDialogueContextResult =
  | CareerDialogueContextSuccess
  | { ok: false; code: "INPUT_TOO_LARGE" };

type DialogueTurn = {
  user: UIMessage | null;
  assistants: UIMessage[];
  index: number;
};

type DialogueTaggedLine = {
  kind: "dialogue";
  text: string;
};

type ToolTaggedLine = {
  kind: "tool";
  text: string;
  rawText: string;
  toolName: string;
  projectedOutput: unknown;
  microCompacted: boolean;
  partRef: unknown;
};

type TaggedLine = DialogueTaggedLine | ToolTaggedLine;

type RenderedTurn = {
  turn: DialogueTurn;
  lines: TaggedLine[];
  dialogueTokens: number;
};

const INTERNAL_KEYS = new Set([
  "id",
  "resumeId",
  "jobId",
  "coverLetterId",
  "userId",
  "createdAt",
  "updatedAt",
  "reviewedAt",
  "savedAt",
  "source",
]);

const COMPACT_OMIT = new Set(["resumeText", "body", "jobDescription"]);

function budgetsOf(
  override?: Partial<CareerDialogueContextBudgets>,
): CareerDialogueContextBudgets {
  return { ...CAREER_DIALOGUE_CONTEXT_BUDGETS, ...override };
}

function isDenseChar(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x20000 && code <= 0x2ebef)
  );
}

/** See the file header. Empty text is 0. */
export function estimateContextTokens(text: string): number {
  if (!text) return 0;
  let dense = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isDenseChar(code)) dense += 1;
    else other += 1;
  }
  return dense + Math.ceil(other / APP_CONSTANTS.AGENT_CHAT_CHARS_PER_TOKEN);
}

function tokensOf(lines: string[]): number {
  return estimateContextTokens(lines.join("\n"));
}

function charsOf(text: string): number {
  return text.length;
}

export function projectToolOutput(
  output: unknown,
  profile: CareerDialogueContextProfile,
  toolName?: string,
): unknown {
  const projected = stripInternal(output);
  // Routing needs the owned job ids returned by reads to call get_job.
  // Keep them only at the documented result paths, never in final prose.
  if (
    profile === "AGENT_DECISION" &&
    output && typeof output === "object" &&
    projected && typeof projected === "object"
  ) {
    const raw = output as Record<string, unknown>;
    const target = projected as Record<string, unknown>;
    if (
      toolName === "list_jobs" &&
      Array.isArray(raw.jobs) && Array.isArray(target.jobs)
    ) {
      raw.jobs.forEach((job, index) => {
        if (job && typeof job === "object" && typeof job.id === "string") {
          (target.jobs as Record<string, unknown>[])[index].id = job.id;
        }
      });
    }
    if (
      toolName === "get_job" &&
      raw.job && typeof raw.job === "object" &&
      "id" in raw.job && typeof raw.job.id === "string" &&
      target.job && typeof target.job === "object"
    ) {
      (target.job as Record<string, unknown>).id = raw.job.id;
    }
  }
  if (profile !== "AGENT_DECISION") return projected;
  return compactDecisionOutput(projected);
}

function stripInternal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripInternal(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (INTERNAL_KEYS.has(key)) continue;
    out[key] = stripInternal(source[key]);
  }
  return out;
}

function compactDecisionOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => compactDecisionOutput(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let contentChars = 0;
  for (const key of Object.keys(source).sort()) {
    const child = source[key];
    if (COMPACT_OMIT.has(key) && typeof child === "string") {
      contentChars += child.length;
      continue;
    }
    out[key] = compactDecisionOutput(child);
  }
  if (contentChars > 0) out.contentChars = contentChars;
  return out;
}

function userText(message: UIMessage | null | undefined): string {
  if (!message) return "";
  return (message.parts ?? [])
    .map((part) => {
      if (part.type === "text") return part.text;
      if (isAgentPastePart(part)) return "(pasted job posting)";
      // The extracted text does not replay every turn — the file line is
      // injected on the arriving turn only, and this placeholder keeps the
      // file-only send a complete turn in history.
      if (isAgentFilePart(part)) return agentFilePlaceholder(part.data.name);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolLine(
  part: { type: string; [k: string]: unknown },
  profile: CareerDialogueContextProfile,
): TaggedLine {
  const name = getToolName(part as never);
  const state = part.state as string;
  if (state === "approval-requested") {
    return {
      kind: "dialogue",
      text: `Assistant proposed tool ${name} with arguments ${JSON.stringify(part.input ?? {})} — awaiting the user's confirmation.`,
    };
  }
  if (state === "approval-responded") {
    const approval = part.approval as
      | { approved?: boolean; reason?: string }
      | undefined;
    return {
      kind: "dialogue",
      text: approval?.approved
        ? `The user approved the ${name} proposal with arguments ${JSON.stringify(part.input ?? {})}.`
        : `The user declined the ${name} proposal${approval?.reason ? `: ${approval.reason}` : "."}`,
    };
  }
  if (state === "output-denied") {
    return { kind: "dialogue", text: `The user declined to run ${name}.` };
  }
  if (state === "output-error") {
    return { kind: "dialogue", text: `Tool ${name} failed.` };
  }
  if (state === "output-available") {
    const projectedOutput = projectToolOutput(part.output ?? null, profile, name);
    const text = `Tool ${name} returned: ${JSON.stringify(projectedOutput)}`;
    return {
      kind: "tool",
      text,
      rawText: text,
      toolName: name,
      projectedOutput,
      microCompacted: false,
      partRef: part,
    };
  }
  return {
    kind: "dialogue",
    text: `Assistant called tool ${name} with arguments ${JSON.stringify(part.input ?? {})}.`,
  };
}

function renderTurn(
  turn: DialogueTurn,
  profile: CareerDialogueContextProfile,
): RenderedTurn {
  const lines: TaggedLine[] = [];
  const text = userText(turn.user);
  if (text) lines.push({ kind: "dialogue", text: `User: ${text}` });
  for (const message of turn.assistants) {
    const tag = roleAttributionTag(readMessageAgentRole(message));
    const prefix = tag ? `Assistant ${tag}` : "Assistant";
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        if (part.text) lines.push({ kind: "dialogue", text: `${prefix}: ${part.text}` });
        continue;
      }
      if (!isToolUIPart(part)) continue;
      lines.push(toolLine(part, profile));
    }
  }
  const dialogueTokens = tokensOf(
    lines.filter((line) => line.kind === "dialogue").map((line) => line.text),
  );
  return { turn, lines, dialogueTokens };
}

function groupTurns(messages: UIMessage[]): DialogueTurn[] {
  const turns: DialogueTurn[] = [];
  let current: DialogueTurn | null = null;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      current = { user: message, assistants: [], index };
      turns.push(current);
      return;
    }
    if (message.role !== "assistant") return;
    if (!current) {
      current = { user: null, assistants: [message], index };
      turns.push(current);
      return;
    }
    current.assistants.push(message);
  });
  return turns;
}

function isComplete(turn: DialogueTurn): boolean {
  return Boolean(turn.user && turn.assistants.length > 0 && userText(turn.user));
}

function turnMessageIds(turn: DialogueTurn): string[] {
  const ids: string[] = [];
  if (turn.user) ids.push(turn.user.id);
  for (const message of turn.assistants) ids.push(message.id);
  return ids;
}

export function careerDialogueTurnIndexSpans(
  messages: UIMessage[],
): CareerDialogueTurnIndexSpan[] {
  const turns = groupTurns(messages);
  return turns.map((turn, turnIndex) => {
    const messageIds = turnMessageIds(turn);
    const firstId = messageIds[0];
    const lastId = messageIds[messageIds.length - 1];
    return {
      firstIndex: firstId ? messages.findIndex((message) => message.id === firstId) : -1,
      lastIndex: lastId ? messages.findIndex((message) => message.id === lastId) : -1,
      messageIds,
      complete: isComplete(turn),
      inHistoryPool: turnIndex < turns.length - 1 && isComplete(turn),
    };
  });
}

export function latestCompleteTurnMessageCount(messages: UIMessage[]): number {
  const spans = careerDialogueTurnIndexSpans(messages);
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span?.complete && span.messageIds.length > 0) return span.messageIds.length;
  }
  return 0;
}

function sessionLines(
  facts: SessionToolFact[],
  profile: CareerDialogueContextProfile,
): string[] {
  return facts.map((fact) => {
    if (fact.line) return fact.line;
    return `Tool ${fact.name} returned: ${JSON.stringify(projectToolOutput(fact.output ?? null, profile, fact.name))}`;
  });
}

export function currentUserExceedsContextBudget(
  messages: UIMessage[],
  budgets?: Partial<CareerDialogueContextBudgets>,
): boolean {
  const turns = groupTurns(messages);
  const current = turns.length ? turns[turns.length - 1] : null;
  const text = userText(current?.user);
  return estimateContextTokens(text) > budgetsOf(budgets).currentUserTokens;
}

function projectMessageOutputs(
  message: UIMessage,
  microCompactedParts?: ReadonlySet<unknown>,
): UIMessage {
  return {
    ...message,
    parts: (message.parts ?? []).map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;
      const projected = projectToolOutput(part.output ?? null, "AGENT_RESPONSE");
      if (microCompactedParts?.has(part)) {
        return {
          ...part,
          output: microCompactToolOutputValue(getToolName(part as never), projected),
        };
      }
      return {
        ...part,
        output: projected,
      };
    }),
  };
}

/**
 * Messages the legacy provider path may convert. Same retention rules as
 * `buildCareerDialogueContext`. Tool outputs are cloned and projected; the
 * caller's array is not mutated. An oversized current user message yields
 * an empty selection — the route rejects that case before execution.
 */
export function selectCareerDialogueMessages(
  messages: UIMessage[],
  budgets?: Partial<CareerDialogueContextBudgets>,
): UIMessage[] {
  const result = buildCareerDialogueContext({
    profile: "AGENT_RESPONSE",
    messages,
    budgets,
  });
  if (!result.ok) return [];
  return result.retainedMessages;
}

function dialogueText(rendered: RenderedTurn, droppedTools: Set<TaggedLine>): string[] {
  return rendered.lines
    .filter((line) => line.kind === "dialogue" || !droppedTools.has(line))
    .map((line) => line.text);
}

function tryMicroCompactToolLine(line: ToolTaggedLine, minTokens?: number): boolean {
  if (line.microCompacted) return false;
  if (
    minTokens !== undefined &&
    !shouldMicroCompactToolOutput(
      line.toolName,
      line.projectedOutput,
      line.text,
      estimateContextTokens,
      minTokens,
    )
  ) {
    return false;
  }
  const folded = microCompactToolOutputLine(line.toolName, line.projectedOutput);
  if (estimateContextTokens(folded) >= estimateContextTokens(line.text)) {
    return false;
  }
  line.text = folded;
  line.microCompacted = true;
  return true;
}

export function buildCareerDialogueContext(
  input: CareerDialogueContextInput,
): CareerDialogueContextResult {
  const budgets = budgetsOf(input.budgets);
  const profile = input.profile;
  const messages = input.messages ?? [];
  const turns = groupTurns(messages);
  const last = messages[messages.length - 1];
  const lastIsUser = last?.role === "user";
  const current = turns.length ? turns[turns.length - 1] : null;
  const historyPool = (current ? turns.slice(0, -1) : turns).filter(isComplete);
  const userLineText = userText(current?.user);

  if (estimateContextTokens(userLineText) > budgets.currentUserTokens) {
    return { ok: false, code: "INPUT_TOO_LARGE" };
  }

  const summaryObj =
    input.summary && typeof input.summary !== "string" ? input.summary : null;
  const summaryText =
    typeof input.summary === "string" ? input.summary : summaryObj?.text;
  let summary = summaryText?.trim() || undefined;
  if (summary && estimateContextTokens(summary) > budgets.summaryTokens) {
    summary = undefined;
  }

  // Compaction boundary folding: turns already covered by a valid summary are
  // represented by that summary instead of being duplicated verbatim.
  let activeHistoryPool = historyPool;
  let compactedTurnCount = 0;
  if (summary && summaryObj) {
    const throughIndex = messages.findIndex(
      (message) => message.id === summaryObj.throughMessageId,
    );
    if (throughIndex < 0) {
      summary = undefined;
    } else {
      const coveredIds = new Set(
        messages.slice(0, throughIndex + 1).map((message) => message.id),
      );
      const uncovered: DialogueTurn[] = [];
      let covered = 0;
      for (const turn of historyPool) {
        const ids = turnMessageIds(turn);
        if (ids.length > 0 && ids.every((id) => coveredIds.has(id))) {
          covered += 1;
        } else {
          uncovered.push(turn);
        }
      }
      activeHistoryPool = uncovered;
      compactedTurnCount = covered;
    }
  }

  const renderedHistory = activeHistoryPool.map((turn) => renderTurn(turn, profile));
  const currentReservesSlot = Boolean(
    !lastIsUser && current && isComplete(current),
  );
  const historyCap = Math.max(
    0,
    budgets.maxRecentTurns - (currentReservesSlot ? 1 : 0),
  );
  const keptNewestFirst: RenderedTurn[] = [];
  let historyTokens = 0;
  for (let i = renderedHistory.length - 1; i >= 0; i--) {
    const rendered = renderedHistory[i];
    if (!rendered) continue;
    if (keptNewestFirst.length >= historyCap) break;
    const next = historyTokens + rendered.dialogueTokens;
    if (next > budgets.historyTokens) break;
    historyTokens = next;
    keptNewestFirst.push(rendered);
  }
  let history = keptNewestFirst.reverse();

  const currentRendered = current ? renderTurn(current, profile) : null;
  const includeCurrent = Boolean(
    currentRendered && (lastIsUser || current?.user || current),
  );

  const session = sessionLines(input.sessionFacts ?? [], profile);
  const toolCarriers = [
    ...history,
    ...(includeCurrent && currentRendered ? [currentRendered] : []),
  ];
  const historicalToolLines: ToolTaggedLine[] = [];
  for (const rendered of toolCarriers) {
    for (const line of rendered.lines) {
      if (line.kind === "tool") historicalToolLines.push(line);
    }
  }

  // L1 zero-cost micro-compaction: fold bulky tool outputs older than the
  // most recent 1–2 tool calls before measuring historicalToolTokens.
  let microCompactedToolCount = 0;
  const keepRecentTools = Math.max(
    0,
    input.microCompact?.keepRecentTools ??
      (session.length > 0 ? 1 : MICRO_COMPACT_KEEP_RECENT_TOOLS),
  );
  const minMicroTokens = input.microCompact?.minTokens ?? MICRO_COMPACT_MIN_TOKENS;
  const compactCutoff = Math.max(0, historicalToolLines.length - keepRecentTools);
  for (let i = 0; i < compactCutoff; i++) {
    const line = historicalToolLines[i];
    if (line && tryMicroCompactToolLine(line, minMicroTokens)) {
      microCompactedToolCount += 1;
    }
  }

  // Keep newest historical tool lines. The newest line is protected when
  // this turn has no session result yet (a follow-up must still see it).
  // Older lines stop at the historical tool budget — no leapfrogging.
  const droppedTools = new Set<TaggedLine>();
  let keptToolTokens = 0;
  let keptToolCount = 0;
  for (let i = historicalToolLines.length - 1; i >= 0; i--) {
    const line = historicalToolLines[i];
    if (!line) continue;
    const cost = estimateContextTokens(line.text);
    const protectNewest = keptToolCount === 0 && session.length === 0;
    if (!protectNewest && keptToolTokens + cost > budgets.historicalToolTokens) {
      for (let j = i; j >= 0; j--) {
        const older = historicalToolLines[j];
        if (older) droppedTools.add(older);
      }
      break;
    }
    keptToolTokens += cost;
    keptToolCount += 1;
  }

  let pageLine = lastIsUser
    ? buildPageContextMessage(input.pageContext, {
        freshNativeFull: input.freshNativeFull,
        agentRole: input.agentRole,
      })
    : undefined;
  let pasteLine: string | undefined;
  if (lastIsUser && input.pasteBlock && !userLineText.includes(input.pasteBlock)) {
    pasteLine = buildPasteContextMessage(input.pasteBlock);
  }
  const fileLines = lastIsUser
    ? (input.fileBlocks ?? []).map((file) =>
        buildFileContextMessage(file.name, file.block),
      )
    : [];
  if (
    estimateContextTokens(pageLine ?? "") +
      estimateContextTokens(pasteLine ?? "") +
      tokensOf(fileLines) >
      budgets.explicitContextTokens &&
    pageLine
  ) {
    pageLine = undefined;
  }

  let summaryLine = summary ? `Earlier conversation summary:\n${summary}` : undefined;

  // L3 business anchor block: verified against SQLite post-compaction and
  // never touched by dropLowest.
  const businessAnchorCandidate = input.businessAnchorLine?.trim() || undefined;
  const businessAnchorDropped = Boolean(
    businessAnchorCandidate &&
      estimateContextTokens(businessAnchorCandidate) > budgets.businessAnchorTokens,
  );
  const businessAnchorLine = businessAnchorDropped
    ? undefined
    : businessAnchorCandidate;

  // Task handoff: task sessions only. Fixed once here and never reassigned,
  // so dropLowest cannot touch it.
  const handoffCandidate =
    input.agentTaskId && input.handoffLine?.trim() ? input.handoffLine.trim() : undefined;
  const handoffDropped = Boolean(
    handoffCandidate && estimateContextTokens(handoffCandidate) > budgets.handoffTokens,
  );
  const handoffLine = handoffDropped ? undefined : handoffCandidate;

  // M2 memory block: caller-rendered, separately budgeted, protected like
  // the anchor/handoff. It never displaces history — its own 700-token cap
  // is enforced at render time upstream.
  const longTermMemoryCandidate = input.longTermMemoryLine?.trim() || undefined;
  const longTermMemoryDropped = Boolean(
    longTermMemoryCandidate &&
      estimateContextTokens(longTermMemoryCandidate) > budgets.longTermMemoryTokens,
  );
  const longTermMemoryLine = longTermMemoryDropped
    ? undefined
    : longTermMemoryCandidate;

  const historyDialogue = () =>
    history.flatMap((rendered) =>
      rendered.lines.filter((line) => line.kind === "dialogue").map((line) => line.text),
    );
  const keptHistoricalTools = () =>
    historicalToolLines.filter((line) => !droppedTools.has(line)).map((line) => line.text);

  const assemble = (): string[] => {
    const lines: string[] = [];
    if (summaryLine) lines.push(summaryLine);
    if (businessAnchorLine) lines.push(businessAnchorLine);
    if (handoffLine) lines.push(handoffLine);
    if (longTermMemoryLine) lines.push(longTermMemoryLine);
    for (const rendered of history) lines.push(...dialogueText(rendered, droppedTools));
    if (includeCurrent && currentRendered && !history.includes(currentRendered)) {
      lines.push(...dialogueText(currentRendered, droppedTools));
    }
    if (pageLine) lines.push(pageLine);
    if (pasteLine) lines.push(pasteLine);
    lines.push(...fileLines);
    lines.push(...session);
    return lines;
  };

  const fixedTokens = estimateContextTokens(input.fixedOverheadText ?? "");
  const over = () => {
    const dynamic = tokensOf(assemble());
    return (
      dynamic > budgets.dynamicTokens ||
      fixedTokens + dynamic > budgets.assembledInputTokens
    );
  };

  let summaryDroppedForOverflow = false;
  const newestHistorical = historicalToolLines[historicalToolLines.length - 1];
  const isProtectedTool = (line: ToolTaggedLine) =>
    session.length === 0 && line === newestHistorical;

  // Fixed L2 overflow drop order: never drop valid summary first.
  const dropLowest = (): boolean => {
    // 1. Micro-compact any remaining non-protected historical tool.
    for (const line of historicalToolLines) {
      if (droppedTools.has(line) || isProtectedTool(line)) continue;
      if (tryMicroCompactToolLine(line)) {
        microCompactedToolCount += 1;
        return true;
      }
    }

    // 2. Drop oldest non-protected historical tool line.
    const oldestTool = historicalToolLines.find(
      (line) => !droppedTools.has(line) && !isProtectedTool(line),
    );
    if (oldestTool) {
      droppedTools.add(oldestTool);
      return true;
    }

    // 3. Drop oldest complete history turn (not holding the protected tool).
    if (history.length) {
      const removable = history.findIndex((rendered) => {
        if (session.length === 0 && newestHistorical) {
          return !rendered.lines.includes(newestHistorical);
        }
        return true;
      });
      if (removable >= 0) {
        const removed = history[removable];
        history = history.filter((_, index) => index !== removable);
        if (removed) {
          for (const line of removed.lines) {
            if (line.kind === "tool") droppedTools.add(line);
          }
        }
        return true;
      }
    }

    // 4. Drop page-context line.
    if (pageLine) {
      pageLine = undefined;
      return true;
    }

    // 5. Extreme overflow: micro-compact, then drop the protected newest tool.
    if (newestHistorical && !droppedTools.has(newestHistorical)) {
      if (tryMicroCompactToolLine(newestHistorical)) {
        microCompactedToolCount += 1;
        return true;
      }
      droppedTools.add(newestHistorical);
      return true;
    }

    // 6. Extreme overflow: drop any remaining history turn.
    if (history.length) {
      const removed = history[0];
      history = history.slice(1);
      if (removed) {
        for (const line of removed.lines) {
          if (line.kind === "tool") droppedTools.add(line);
        }
      }
      return true;
    }

    // 7. Last resort only: drop valid summary.
    if (summaryLine) {
      summaryLine = undefined;
      summary = undefined;
      summaryDroppedForOverflow = true;
      compactedTurnCount = 0;
      return true;
    }

    return false;
  };

  while (over() && dropLowest()) {
    // One lowest-priority unit per step. No unordered collection.
  }

  // Check the final retained turns, including drops caused by this profile's
  // tool results and fixed overhead. A partial catch-up cache cannot fill a gap.
  let summaryDroppedForGap = false;
  if (summary && summaryObj) {
    const keptTurns = new Set(history.map((rendered) => rendered.turn));
    if (activeHistoryPool.some((turn) => !keptTurns.has(turn))) {
      summaryLine = undefined;
      summary = undefined;
      summaryDroppedForGap = true;
      compactedTurnCount = 0;
    }
  }

  const transcriptLines = assemble();
  const maxTranscriptChars = Math.max(
    200_000,
    budgets.assembledInputTokens * APP_CONSTANTS.AGENT_CHAT_CHARS_PER_TOKEN + 32_000,
  );
  if (transcriptLines.join("\n").length > maxTranscriptChars) {
    return { ok: false, code: "INPUT_TOO_LARGE" };
  }

  const historyText = historyDialogue();
  const explicitKept = [pageLine, pasteLine, ...fileLines].filter(
    (line): line is string => Boolean(line),
  );
  const toolText = [...keptHistoricalTools(), ...session];
  const systemText = input.systemText ?? "";
  const dynamicText = transcriptLines.join("\n");
  const completeCurrent =
    includeCurrent && currentRendered && currentRendered.turn.assistants.length > 0;

  const microCompactedParts = new Set<unknown>();
  for (const line of historicalToolLines) {
    if (line.microCompacted && !droppedTools.has(line) && line.partRef) {
      microCompactedParts.add(line.partRef);
    }
  }

  const retainedMessages: UIMessage[] = [];
  const pushTurn = (turn: DialogueTurn) => {
    if (turn.user) retainedMessages.push(turn.user);
    retainedMessages.push(...turn.assistants);
  };
  for (const rendered of history) pushTurn(rendered.turn);
  if (includeCurrent && current && !history.some((rendered) => rendered.turn === current)) {
    pushTurn(current);
  }

  const retainedTurnSet = new Set(history.map((rendered) => rendered.turn));
  const boundaryPool = summary && summaryObj ? activeHistoryPool : historyPool;
  const droppedTurnsList = boundaryPool.filter((turn) => !retainedTurnSet.has(turn));
  const historyBoundary: CareerDialogueHistoryBoundary = {
    droppedTurnCount: droppedTurnsList.length,
    droppedTurns: droppedTurnsList.map(turnMessageIds),
    retainedHistoryTurns: history.map((rendered) => turnMessageIds(rendered.turn)),
  };

  const dynamicTokens = tokensOf(transcriptLines);
  const estimatedInputTokens = fixedTokens + dynamicTokens;
  const needsRecompaction = Boolean(
    summaryDroppedForOverflow ||
      summaryDroppedForGap ||
      (input.autoCompactTriggerTokens !== undefined &&
        estimatedInputTokens >= input.autoCompactTriggerTokens),
  );

  const size: CareerDialogueContextSize = {
    contextProfile: profile,
    systemChars: charsOf(systemText),
    systemTokens: estimateContextTokens(systemText),
    currentUserChars: charsOf(userLineText),
    currentUserTokens: estimateContextTokens(userLineText),
    historyChars: charsOf(historyText.join("\n")),
    historyTokens: tokensOf(historyText),
    explicitContextChars: charsOf(explicitKept.join("\n")),
    explicitContextTokens: tokensOf(explicitKept),
    toolResultChars: charsOf(toolText.join("\n")),
    toolResultTokens: tokensOf(toolText),
    summaryChars: summary?.length ?? 0,
    summaryTokens: summary ? estimateContextTokens(summary) : 0,
    businessAnchorChars: businessAnchorLine?.length ?? 0,
    businessAnchorTokens: businessAnchorLine
      ? estimateContextTokens(businessAnchorLine)
      : 0,
    businessAnchorDropped,
    handoffChars: handoffLine?.length ?? 0,
    handoffTokens: handoffLine ? estimateContextTokens(handoffLine) : 0,
    handoffDropped,
    longTermMemoryChars: longTermMemoryLine?.length ?? 0,
    longTermMemoryTokens: longTermMemoryLine
      ? estimateContextTokens(longTermMemoryLine)
      : 0,
    longTermMemoryDropped,
    microCompactedToolCount,
    compactedTurnCount,
    summaryDroppedForOverflow,
    needsRecompaction,
    dynamicChars: dynamicText.length,
    dynamicTokens,
    estimatedInputTokens,
    recentTurnCount: history.length + (currentReservesSlot && completeCurrent ? 1 : 0),
    droppedTurnCount: historyBoundary.droppedTurnCount,
  };

  return {
    ok: true,
    transcript: dynamicText,
    retainedMessages: retainedMessages.map((message) =>
      projectMessageOutputs(message, microCompactedParts),
    ),
    explicitLines: explicitKept,
    ...(summary ? { summary } : {}),
    size,
    historyBoundary,
  };
}

/** Safe diagnostics. Counts and units only. */
export function careerDialogueContextLogFields(
  size: CareerDialogueContextSize,
): Record<string, string | number> {
  return {
    contextProfile: size.contextProfile,
    estimatedInputTokens: size.estimatedInputTokens,
    recentTurnCount: size.recentTurnCount,
    droppedTurnCount: size.droppedTurnCount,
    explicitContextUnits: size.explicitContextTokens,
    toolResultUnits: size.toolResultTokens,
    summaryUnits: size.summaryTokens,
    systemTokens: size.systemTokens,
    currentUserTokens: size.currentUserTokens,
    historyTokens: size.historyTokens,
    dynamicTokens: size.dynamicTokens,
    ...(size.microCompactedToolCount > 0
      ? { microCompactedTools: size.microCompactedToolCount }
      : {}),
    ...(size.compactedTurnCount > 0
      ? { compactedTurns: size.compactedTurnCount }
      : {}),
    ...(size.businessAnchorTokens > 0 || size.businessAnchorDropped
      ? {
          businessAnchorUnits: size.businessAnchorTokens,
          businessAnchorDropped: size.businessAnchorDropped ? 1 : 0,
        }
      : {}),
    // Only task sessions that carry a handoff add these fields, so non-task
    // log lines keep their exact pre-handoff shape.
    ...(size.handoffTokens > 0 || size.handoffDropped
      ? { handoffUnits: size.handoffTokens, handoffDropped: size.handoffDropped ? 1 : 0 }
      : {}),
    ...(size.longTermMemoryTokens > 0 || size.longTermMemoryDropped
      ? {
          longTermMemoryUnits: size.longTermMemoryTokens,
          longTermMemoryDropped: size.longTermMemoryDropped ? 1 : 0,
        }
      : {}),
  };
}
