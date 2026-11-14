// The transient stream part that carries one turn's assembled context size
// from the route to the panel. Values are the budgeter's character-density
// estimate — an application-level assembly budget, never model-tokenizer
// output and never the model's own context window.
export const AGENT_CONTEXT_USAGE_PART_TYPE = "data-context-usage";

export type AgentContextUsage = {
  conversationId: string;
  requestId: string;
  profile: string;
  /** The assembled prompt estimate the turn actually ran with. */
  estimatedInputTokens: number;
  recentTurnCount: number;
  /** History turns dropped from this send to fit the budgets. */
  droppedTurnCount: number;
  tokens: {
    system: number;
    currentUser: number;
    history: number;
    explicitContext: number;
    toolResult: number;
    summary: number;
    dynamic: number;
  };
  budgets: {
    assembledInputTokens: number;
    dynamicTokens: number;
    explicitContextTokens: number;
    historyTokens: number;
    historicalToolTokens: number;
    currentUserTokens: number;
    summaryTokens: number;
  };
};

/** Compact toolbar notation: 12_400 → "12.4k", 950 → "950". */
export function formatUsageK(units: number): string {
  if (units >= 1000) {
    return `${(units / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${units}`;
}
