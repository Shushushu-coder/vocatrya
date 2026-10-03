import { act, renderHook } from "@testing-library/react";
import { useAgentBrandState } from "@/components/brand/useAgentBrandState";

describe("AI brand event consumption", () => {
  const idle = { status: "ready", brandCompletion: 0, isOpen: true, conversationId: "one", blocked: false };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("follows submitted and streaming; completes once and stays idle after cancellation of the next turn", () => {
    const { result, rerender } = renderHook(useAgentBrandState, { initialProps: idle });
    expect(result.current).toBe("idle");
    rerender({ ...idle, status: "submitted" });
    expect(result.current).toBe("thinking");
    rerender({ ...idle, status: "streaming" });
    expect(result.current).toBe("thinking");
    // SDK onFinish may publish before the status becomes ready.
    rerender({ ...idle, status: "streaming", brandCompletion: 1 });
    expect(result.current).toBe("thinking");
    rerender({ ...idle, brandCompletion: 1 });
    expect(result.current).toBe("complete");
    act(() => vi.advanceTimersByTime(700));
    expect(result.current).toBe("idle");
    rerender({ ...idle, brandCompletion: 1, status: "streaming" });
    expect(result.current).toBe("thinking");
    rerender({ ...idle, brandCompletion: 1 });
    expect(result.current).toBe("idle");
  });

  it("handles rapid completion and a new turn, failure and clearing errors without replay", () => {
    const { result, rerender } = renderHook(useAgentBrandState, { initialProps: idle });
    rerender({ ...idle, status: "submitted" });
    rerender({ ...idle, brandCompletion: 1 });
    expect(result.current).toBe("complete");
    rerender({ ...idle, status: "submitted", brandCompletion: 1 });
    expect(result.current).toBe("thinking");
    act(() => vi.advanceTimersByTime(700));
    expect(result.current).toBe("thinking");
    rerender({ ...idle, status: "error", brandCompletion: 1, blocked: true });
    expect(result.current).toBe("idle");
    rerender({ ...idle, brandCompletion: 1 });
    expect(result.current).toBe("idle");
  });

  it("does not replay when closing, reopening or switching conversation", () => {
    const { result, rerender } = renderHook(useAgentBrandState, { initialProps: idle });
    rerender({ ...idle, brandCompletion: 1 });
    expect(result.current).toBe("complete");
    rerender({ ...idle, brandCompletion: 1, isOpen: false });
    rerender({ ...idle, brandCompletion: 1 });
    expect(result.current).toBe("idle");
    rerender({ ...idle, conversationId: "two" });
    expect(result.current).toBe("idle");
    rerender({ ...idle, conversationId: "two", brandCompletion: 1 });
    expect(result.current).toBe("complete");
  });
});
