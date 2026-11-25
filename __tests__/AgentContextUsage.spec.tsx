import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

import { I18nProvider, type Locale } from "@/i18n";
import type { AgentContextUsage as AgentContextUsageData } from "@/lib/agent/contextUsage";

type FeedbackState =
  | { kind: "success" }
  | { kind: "skipped" }
  | { kind: "busy" }
  | { kind: "error" }
  | null;

const chatState = {
  contextUsage: null as AgentContextUsageData | null,
  busy: false,
  compacting: false,
  compactionFeedback: null as FeedbackState,
  compactContext: vi.fn(async (_focusNote?: string) => {}),
  clearCompactionFeedback: vi.fn(),
  conversationId: "conv-1" as string | null,
  nativeSession: false,
  identity: {
    checked: true,
    ok: true,
    kind: "account",
    locked: true,
    model: "gpt-4o",
    displayName: "GPT-4o",
    persistedLegacy: false,
  } as { kind: string } | null,
};

vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => chatState,
}));

import { AgentContextUsage } from "@/components/agent/AgentContextUsage";

function sampleUsage(
  overrides: Partial<AgentContextUsageData> = {},
): AgentContextUsageData {
  return {
    conversationId: "conv-1",
    requestId: "req-1",
    profile: "FAST_CHAT",
    estimatedInputTokens: 24_000,
    recentTurnCount: 8,
    droppedTurnCount: 2,
    modelContextWindowTokens: 128_000,
    modelContextWindowSource: "catalog",
    autoCompactTriggerTokens: 62_400,
    microCompactedToolCount: 3,
    compactedTurnCount: 6,
    hasSummary: true,
    circuitBreakerOpen: false,
    failureCount: 0,
    tokens: {
      system: 3_000,
      currentUser: 400,
      history: 12_000,
      explicitContext: 600,
      toolResult: 5_000,
      summary: 2_200,
      dynamic: 21_000,
      businessAnchor: 800,
    },
    budgets: {
      assembledInputTokens: 80_000,
      dynamicTokens: 72_000,
      maxRecentTurns: 24,
      currentUserTokens: 12_000,
      historyTokens: 42_000,
      historicalToolTokens: 14_000,
      explicitContextTokens: 8_000,
      summaryTokens: 4_000,
      businessAnchorTokens: 800,
    },
    ...overrides,
  };
}

function renderUsage(locale: Locale = "en") {
  return render(
    <I18nProvider initialLocale={locale} loadPersistedLocale={async () => null}>
      <AgentContextUsage />
    </I18nProvider>,
  );
}

describe("AgentContextUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatState.contextUsage = null;
    chatState.busy = false;
    chatState.compacting = false;
    chatState.compactionFeedback = null;
    chatState.compactContext = vi.fn(async () => {});
    chatState.clearCompactionFeedback = vi.fn();
    chatState.conversationId = "conv-1";
    chatState.nativeSession = false;
    chatState.identity = { kind: "account" };
  });

  it("renders nothing when contextUsage is null", () => {
    const { container } = renderUsage("en");
    expect(container).toBeEmptyDOMElement();
  });

  it("displays dynamic window progressbar, breakdown, L1/L2/L3 stats, and circuit warning", async () => {
    chatState.contextUsage = sampleUsage({ circuitBreakerOpen: true, failureCount: 3 });
    renderUsage("en");

    const trigger = screen.getByRole("button", { name: "Context usage (estimate)" });
    expect(trigger).toHaveTextContent("≈24k/80k");

    await userEvent.click(trigger);

    const bar = screen.getByRole("progressbar", { name: "Context usage (estimate)" });
    expect(bar).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByText("30% used", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Model window 128k · cost cap 80k/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-compact threshold: ≈62\.4k/)).toBeInTheDocument();
    expect(screen.getByText("Business anchors")).toBeInTheDocument();
    expect(screen.getByText(/L1 micro-compaction folded 3 earlier large tool/)).toBeInTheDocument();
    expect(screen.getByText(/Structured summary covers 6 earlier turn/)).toBeInTheDocument();
    expect(screen.getByText(/2 earlier turn\(s\) were left out/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-compaction paused after repeated failures/)).toBeInTheDocument();
  });

  it("submits manual compaction with optional focus note in zh-CN and clears input", async () => {
    chatState.contextUsage = sampleUsage();
    renderUsage("zh-CN");

    await userEvent.click(screen.getByRole("button", { name: "上下文用量（估算）" }));

    const input = screen.getByRole("textbox", { name: "保留重点（可选）" });
    await userEvent.type(input, "保留薪资与城市硬约束");

    const btn = screen.getByRole("button", { name: "压缩上下文" });
    await userEvent.click(btn);

    expect(chatState.compactContext).toHaveBeenCalledTimes(1);
    expect(chatState.compactContext).toHaveBeenCalledWith("保留薪资与城市硬约束");
    expect(input).toHaveValue("");
  });

  it("submits undefined when focus note is blank and disables actions while compacting or busy", async () => {
    chatState.contextUsage = sampleUsage();
    chatState.busy = true;
    const view = renderUsage("en");

    await userEvent.click(screen.getByRole("button", { name: "Context usage (estimate)" }));
    expect(screen.getByRole("textbox", { name: "Retention focus (optional)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Compact context" })).toBeDisabled();

    chatState.busy = false;
    chatState.compacting = true;
    view.rerender(
      <I18nProvider initialLocale="en" loadPersistedLocale={async () => null}>
        <AgentContextUsage />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Compacting context…" })).toBeDisabled();

    chatState.compacting = false;
    view.rerender(
      <I18nProvider initialLocale="en" loadPersistedLocale={async () => null}>
        <AgentContextUsage />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Compact context" }));
    expect(chatState.compactContext).toHaveBeenCalledWith(undefined);
  });

  it.each<[Exclude<FeedbackState, null>, string]>([
    [{ kind: "success" }, "Context compacted and business anchors re-verified."],
    [{ kind: "skipped" }, "No further compaction is needed right now."],
    [{ kind: "busy" }, "Another turn or compaction is already in progress. Try again shortly."],
    [{ kind: "error" }, "Compaction could not complete and degraded safely without losing history."],
  ])("renders status feedback for %o", async (feedback, expectedText) => {
    chatState.contextUsage = sampleUsage();
    chatState.compactionFeedback = feedback;
    renderUsage("en");

    await userEvent.click(screen.getByRole("button", { name: "Context usage (estimate)" }));
    expect(screen.getByRole("status")).toHaveTextContent(expectedText);
  });

  it("hides manual compaction controls for native Codex sessions and legacy conversations", async () => {
    chatState.contextUsage = sampleUsage();
    chatState.nativeSession = true;
    const view = renderUsage("en");

    await userEvent.click(screen.getByRole("button", { name: "Context usage (estimate)" }));
    expect(screen.queryByRole("button", { name: "Compact context" })).not.toBeInTheDocument();
    expect(screen.getByText(/Managed automatically · read-only/)).toBeInTheDocument();

    chatState.nativeSession = false;
    chatState.identity = { kind: "legacy" };
    view.rerender(
      <I18nProvider initialLocale="en" loadPersistedLocale={async () => null}>
        <AgentContextUsage />
      </I18nProvider>,
    );
    expect(screen.queryByRole("button", { name: "Compact context" })).not.toBeInTheDocument();
    expect(screen.getByText(/Managed automatically · read-only/)).toBeInTheDocument();
  });
});
