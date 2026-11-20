import { act, fireEvent, render, screen } from "@testing-library/react";
import { ErrorNoticeHost } from "@/components/common/ErrorNoticeHost";
import {
  RECOVERED_DISMISS_MS,
  dismissErrorNotice,
  reportErrorNotice,
  resetErrorNoticesForTests,
  resolveErrorNotice,
} from "@/lib/errorNotices";

const report = (kind: string, extra: Record<string, unknown> = {}) =>
  act(() => reportErrorNotice({ kind, title: `Title ${kind}`, ...extra }));

describe("ErrorNoticeHost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => resetErrorNoticesForTests());
  });
  afterEach(() => {
    act(() => resetErrorNoticesForTests());
    vi.useRealTimers();
  });

  it("merges same-kind errors into one entry updated in place", () => {
    render(<ErrorNoticeHost />);
    report("a:X", { message: "first" });
    report("a:X", { message: "second" });
    expect(screen.getAllByTestId("error-notice")).toHaveLength(1);
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("Occurred 2 times")).toBeInTheDocument();
  });

  it("shows at most 3 and folds the rest behind a +N expander", () => {
    render(<ErrorNoticeHost />);
    ["k1", "k2", "k3", "k4", "k5"].forEach((k) => report(k));
    expect(screen.getAllByTestId("error-notice")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getAllByTestId("error-notice")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getAllByTestId("error-notice")).toHaveLength(3);
  });

  it("shows Recovered then auto-dismisses; a recurrence cancels dismissal", () => {
    render(<ErrorNoticeHost />);
    report("r:1");
    act(() => resolveErrorNotice("r:1"));
    const card = screen.getByTestId("error-notice");
    expect(card).toHaveAttribute("data-status", "recovered");
    expect(card).toHaveTextContent("Recovered");

    act(() => vi.advanceTimersByTime(RECOVERED_DISMISS_MS - 1));
    expect(screen.getAllByTestId("error-notice")).toHaveLength(1);
    report("r:1"); // fails again before the timer fires
    act(() => vi.advanceTimersByTime(RECOVERED_DISMISS_MS * 2));
    expect(screen.getByTestId("error-notice")).toHaveAttribute(
      "data-status",
      "active",
    );

    act(() => resolveErrorNotice("r:1"));
    act(() => vi.advanceTimersByTime(RECOVERED_DISMISS_MS));
    expect(screen.queryByTestId("error-notice")).toBeNull();
  });

  it("closing hides the notice without retrying; retry only on click", () => {
    const onRetry = vi.fn();
    render(<ErrorNoticeHost />);
    report("c:1", { onRetry, details: "detail text" });
    expect(screen.queryByText("detail text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("detail text")).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByTestId("error-notice")).toBeNull();
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Closing is not recovery: the same condition reappears when re-reported.
    report("c:1");
    expect(screen.getAllByTestId("error-notice")).toHaveLength(1);
    act(() => dismissErrorNotice("c:1"));
  });
});
