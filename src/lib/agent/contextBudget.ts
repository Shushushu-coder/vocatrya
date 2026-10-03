import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { APP_CONSTANTS } from "@/lib/constants";
import { isAgentPastePart, type PageContext } from "@/models/agent.model";
import { buildPageContextMessage, buildPasteContextMessage } from "./prompt";

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
 * Drop order when over the dynamic or assembled budget:
 *   summary → oldest historical tool line → oldest complete turn →
 *   page-context line.
 * Never dropped and never sliced: fixed instructions, the current user
 * message, approval state, the current paste head, and the current tool
 * result. A current user message over `currentUserTokens` is rejected.
 */

export const CAREER_DIALOGUE_CONTEXT_BUDGETS = {
  dynamicTokens: 6_000,
  explicitContextTokens: 2_000,
  historyTokens: 3_000,
  maxRecentTurns: 6,
  summaryTokens: 1_000,
  /** Older tool bodies. The current session tool result is not charged here. */
  historicalToolTokens: 2_000,
  currentUserTokens: 6_000,
  /** Fixed instructions + everything still retained. */
  assembledInputTokens: 16_000,
} as const;

export type CareerDialogueContextBudgets = {
  [K in keyof typeof CAREER_DIALOGUE_CONTEXT_BUDGETS]: number;
};

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
   * Fresh transcript-compression cache, already validated by the caller.
   * Omitted when missing, stale, legacy, or over the summary budget.
   */
  summary?: string | null;
  /** Tool results produced in this turn and not yet on `messages`. */
  sessionFacts?: SessionToolFact[];
  systemText?: string;
  /** Instructions + schemas that cannot be dropped. */
  fixedOverheadText?: string;
  budgets?: Partial<CareerDialogueContextBudgets>;
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

type TaggedLine = {
  kind: "dialogue" | "tool";
  text: string;
};

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
): unknown {
  const projected = stripInternal(output);
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
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isApprovalState(state: string | undefined): boolean {
  return (
    state === "approval-requested" ||
    state === "approval-responded" ||
    state === "output-denied"
  );
}

function toolLine(
  part: { type: string; [k: string]: unknown },
  profile: CareerDialogueContextProfile,
): { kind: "dialogue" | "tool"; text: string } {
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
    return {
      kind: "tool",
      text: `Tool ${name} returned: ${JSON.stringify(projectToolOutput(part.output ?? null, profile))}`,
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
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        if (part.text) lines.push({ kind: "dialogue", text: `Assistant: ${part.text}` });
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

function turnHasApproval(turn: DialogueTurn): boolean {
  return turn.assistants.some((message) =>
    (message.parts ?? []).some(
      (part) => isToolUIPart(part) && isApprovalState(part.state),
    ),
  );
}

function sessionLines(
  facts: SessionToolFact[],
  profile: CareerDialogueContextProfile,
): string[] {
  return facts.map((fact) => {
    if (fact.line) return fact.line;
    return `Tool ${fact.name} returned: ${JSON.stringify(projectToolOutput(fact.output ?? null, profile))}`;
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

function projectMessageOutputs(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: (message.parts ?? []).map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;
      return {
        ...part,
        output: projectToolOutput(part.output ?? null, "AGENT_RESPONSE"),
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
  return result.retainedMessages.map(projectMessageOutputs);
}

function dialogueText(rendered: RenderedTurn, droppedTools: Set<TaggedLine>): string[] {
  return rendered.lines
    .filter((line) => line.kind === "dialogue" || !droppedTools.has(line))
    .map((line) => line.text);
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

  const renderedHistory = historyPool.map((turn) => renderTurn(turn, profile));
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
  const includeCurrent = Boolean(currentRendered && (lastIsUser || current?.user || current));

  const session = sessionLines(input.sessionFacts ?? [], profile);
  const toolCarriers = [
    ...history,
    ...(includeCurrent && currentRendered ? [currentRendered] : []),
  ];
  const historicalToolLines: TaggedLine[] = [];
  for (const rendered of toolCarriers) {
    for (const line of rendered.lines) {
      if (line.kind === "tool") historicalToolLines.push(line);
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

  let summary =
    input.summary && input.summary.trim() ? input.summary.trim() : undefined;
  if (summary && estimateContextTokens(summary) > budgets.summaryTokens) {
    summary = undefined;
  }

  let pageLine = lastIsUser ? buildPageContextMessage(input.pageContext) : undefined;
  let pasteLine: string | undefined;
  if (lastIsUser && input.pasteBlock && !userLineText.includes(input.pasteBlock)) {
    pasteLine = buildPasteContextMessage(input.pasteBlock);
  }
  if (
    estimateContextTokens(pageLine ?? "") + estimateContextTokens(pasteLine ?? "") >
      budgets.explicitContextTokens &&
    pageLine
  ) {
    pageLine = undefined;
  }

  let summaryLine = summary ? `Earlier conversation summary:\n${summary}` : undefined;

  const historyDialogue = () =>
    history.flatMap((rendered) =>
      rendered.lines.filter((line) => line.kind === "dialogue").map((line) => line.text),
    );
  const keptHistoricalTools = () =>
    historicalToolLines.filter((line) => !droppedTools.has(line)).map((line) => line.text);
  const currentLines = () =>
    includeCurrent && currentRendered
      ? currentRendered.lines
          .filter((line) => line.kind === "dialogue" || !droppedTools.has(line))
          .map((line) => line.text)
      : [];

  const dynamicParts = (): string[] => [
    ...(summaryLine ? [summaryLine] : []),
    ...history.flatMap((rendered) => dialogueText(rendered, droppedTools)),
    ...currentLines().filter((line) => !history.some((rendered) => rendered.turn === current)),
    ...(pageLine ? [pageLine] : []),
    ...(pasteLine ? [pasteLine] : []),
    ...session,
  ];

  // currentLines is already included via history when current is in history.
  // Current is NOT in `history` (history is the pool before current). The
  // filter above is defensive. Assemble once below instead of this helper
  // double-counting. Use a single assembler.
  const assemble = (): string[] => {
    const lines: string[] = [];
    if (summaryLine) lines.push(summaryLine);
    for (const rendered of history) lines.push(...dialogueText(rendered, droppedTools));
    if (includeCurrent && currentRendered && !history.includes(currentRendered)) {
      lines.push(...dialogueText(currentRendered, droppedTools));
    }
    if (pageLine) lines.push(pageLine);
    if (pasteLine) lines.push(pasteLine);
    lines.push(...session);
    return lines;
  };

  const fixedTokens = estimateContextTokens(input.fixedOverheadText ?? "");
  const over = () => {
    const dynamic = tokensOf(assemble());
    return dynamic > budgets.dynamicTokens || fixedTokens + dynamic > budgets.assembledInputTokens;
  };

  const dropLowest = (): boolean => {
    if (summaryLine) {
      summaryLine = undefined;
      summary = undefined;
      return true;
    }
    const newestHistorical = historicalToolLines[historicalToolLines.length - 1];
    const oldestTool = historicalToolLines.find((line) => {
      if (droppedTools.has(line)) return false;
      // The newest historical tool result is what a follow-up answers from
      // when this turn has not produced a fresher session result.
      if (session.length === 0 && line === newestHistorical) return false;
      return true;
    });
    if (oldestTool) {
      droppedTools.add(oldestTool);
      return true;
    }
    if (history.length) {
      const removable = history.findIndex((rendered) => {
        if (session.length === 0 && newestHistorical) {
          return !rendered.lines.includes(newestHistorical);
        }
        return true;
      });
      if (removable < 0) return false;
      const removed = history[removable];
      history = history.filter((_, index) => index !== removable);
      if (removed) {
        for (const line of removed.lines) {
          if (line.kind === "tool") droppedTools.add(line);
        }
      }
      return true;
    }
    if (pageLine) {
      pageLine = undefined;
      return true;
    }
    return false;
  };

  while (over() && dropLowest()) {
    // One lowest-priority unit per step. No unordered collection.
  }

  const transcriptLines = assemble();
  if (transcriptLines.join("\n").length > 200_000) {
    return { ok: false, code: "INPUT_TOO_LARGE" };
  }

  const historyText = historyDialogue();
  const explicitKept = [pageLine, pasteLine].filter((line): line is string => Boolean(line));
  const toolText = [...keptHistoricalTools(), ...session];
  const systemText = input.systemText ?? "";
  const dynamicText = transcriptLines.join("\n");
  const completeCurrent =
    includeCurrent && currentRendered && currentRendered.turn.assistants.length > 0;

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
  const historyBoundary: CareerDialogueHistoryBoundary = {
    droppedTurnCount: historyPool.length - history.length,
    droppedTurns: historyPool
      .filter((turn) => !retainedTurnSet.has(turn))
      .map(turnMessageIds),
    retainedHistoryTurns: history.map((rendered) => turnMessageIds(rendered.turn)),
  };

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
    dynamicChars: dynamicText.length,
    dynamicTokens: tokensOf(transcriptLines),
    estimatedInputTokens: fixedTokens + tokensOf(transcriptLines),
    recentTurnCount: history.length + (currentReservesSlot && completeCurrent ? 1 : 0),
    droppedTurnCount: historyPool.length - history.length,
  };

  return {
    ok: true,
    transcript: dynamicText,
    retainedMessages: retainedMessages.map(projectMessageOutputs),
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
  };
}
