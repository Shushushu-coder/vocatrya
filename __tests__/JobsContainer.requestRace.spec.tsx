import JobsContainer from "@/components/myjobs/JobsContainer";
import { Suspense } from "react";
import { useJobsList } from "@/components/myjobs/jobs-container/useJobsList";
import { screen, render, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getJobsList } from "@/actions/job.actions";
import { toastError } from "@/lib/toast";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

vi.mock("next-auth", () => {
  const mockAuth = vi.fn();
  const mockSignIn = vi.fn();
  const mockSignOut = vi.fn();
  const mockHandlers = { GET: vi.fn(), POST: vi.fn() };

  return {
    __esModule: true,
    default: vi.fn(() => ({
      auth: mockAuth,
      handlers: mockHandlers,
      signIn: mockSignIn,
      signOut: mockSignOut,
    })),
    auth: mockAuth,
    signIn: mockSignIn,
    signOut: mockSignOut,
    handlers: mockHandlers,
  };
});

vi.mock("next-auth/providers/credentials", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    id: "credentials",
    name: "Credentials",
    type: "credentials",
  })),
}));

vi.mock("@/actions/job.actions", () => ({
  getJobsList: vi.fn(),
  getJobDetails: vi.fn(),
  deleteJobById: vi.fn(),
  updateJobStatus: vi.fn(),
  addJob: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
  useSearchParams: vi.fn(),
  redirect: vi.fn(),
}));

// jobWrites is mutable so a spec can drive the agent-chat refresh path
// (reloadJobs -> loadJobs(1)) while an older request is still in flight.
const agentChatState = vi.hoisted(() => ({ jobWrites: 0 }));
vi.mock("@/components/agent/AgentChatProvider", () => ({
  useAgentChat: () => ({ jobWrites: agentChatState.jobWrites }),
}));

// toastError stays observable: a stale failure must never surface one.
vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  toastError: vi.fn(),
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let intersectionCallback: IntersectionObserverCallback;
global.IntersectionObserver = class IntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

document.createRange = () => {
  const range = new Range();

  range.getBoundingClientRect = vi.fn().mockReturnValue({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
  });

  range.getClientRects = () => {
    return {
      item: () => null,
      length: 0,
      [Symbol.iterator]: vi.fn(),
    };
  };

  return range;
};

type JobsListResult = {
  success: boolean;
  data?: unknown[];
  total?: number;
  message?: string;
};

function deferred<T = JobsListResult>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const makeJob = (id: string) => ({
  id,
  userId: "user-1",
  JobTitle: {
    id: `title-${id}`,
    label: `Title ${id}`,
    value: `title ${id}`,
    createdBy: "user-1",
  },
  Company: {
    id: `company-${id}`,
    label: `Company ${id}`,
    value: `company ${id}`,
    createdBy: "user-1",
    logoUrl: "",
  },
  Location: {
    id: `location-${id}`,
    label: "Remote",
    value: "remote",
    createdBy: "user-1",
  },
  Status: { id: "status-1", label: "Applied", value: "applied" },
  JobSource: { id: "source-1", label: "Indeed", value: "indeed" },
  jobType: "FT",
  appliedDate: new Date("2024-06-19"),
  dueDate: new Date("2024-06-22"),
});

const makePage = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => makeJob(`${prefix}-${i + 1}`));

const ok = (data: unknown[], total: number): JobsListResult => ({
  success: true,
  data,
  total,
});
const fail = (message: string): JobsListResult => ({
  success: false,
  message,
});

const rowNumbers = () => screen.getAllByTestId("job-row-number");

describe("JobsContainer request race protection", () => {
  // R4-INT-05: each spec below carries an explicit 15_000ms per-test budget.
  // These cases chain multi-stage React/Promise interactions and pass both
  // standalone and in focused runs, but full-suite concurrency has shown
  // heavy resource contention. The budget only widens each case's overall
  // execution allowance; it changes no assertion or verification condition.
  // Every getJobsList call parks on a controllable deferred so each spec
  // decides exactly when — and in which order — the responses land.
  const pending: Array<{
    promise: Promise<JobsListResult>;
    resolve: (value: JobsListResult) => void;
    reject: (reason?: unknown) => void;
  }> = [];

  // The useSearchParams mock re-reads this object on every render, so a
  // rerender() after setUrl is the same round trip the browser performs
  // after router.push/replace.
  let currentParams = new URLSearchParams();
  const setUrl = (url: string) => {
    const qIndex = url.indexOf("?");
    currentParams = new URLSearchParams(
      qIndex >= 0 ? url.slice(qIndex + 1) : "",
    );
  };
  const mockRouter = {
    push: vi.fn((url: string) => setUrl(url)),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn((url: string) => setUrl(url)),
    prefetch: vi.fn(),
  };

  const user = userEvent.setup({ delay: null });
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  const jsx = () => (
    <JobsContainer
      statuses={[{ id: "status-1", label: "Applied", value: "applied" }]}
      companies={[]}
      titles={[]}
      locations={[]}
      sources={[]}
      tags={[]}
    />
  );

  const renderComponent = () => render(jsx());

  const navigate = async (
    rerender: (ui: React.ReactElement) => void,
    url: string,
  ) => {
    setUrl(url);
    await act(async () => rerender(jsx()));
  };

  const triggerSentinel = async () => {
    await act(async () =>
      intersectionCallback(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
  };

  const settle = async (
    index: number,
    result: JobsListResult | Error,
  ) => {
    await act(async () => {
      if (result instanceof Error) pending[index].reject(result);
      else pending[index].resolve(result);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pending.length = 0;
    agentChatState.jobWrites = 0;
    currentParams = new URLSearchParams();
    (useRouter as any).mockReturnValue(mockRouter);
    (usePathname as any).mockReturnValue("/dashboard/myjobs");
    (useSearchParams as any).mockImplementation(() => currentParams);
    vi.mocked(getJobsList).mockImplementation(() => {
      const d = deferred();
      pending.push(d);
      return d.promise as Promise<any>;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a late response from a superseded filter query", async () => {
    const { rerender } = renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("loader")).toBeInTheDocument();

    // Request A is still in flight when the filter switch starts request B.
    await navigate(rerender, "/dashboard/myjobs?filter=interview");
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    expect(getJobsList).toHaveBeenLastCalledWith(
      1, 25, "interview", undefined, undefined, undefined, undefined, undefined, undefined, "custom");

    // B lands first and renders the new list.
    await settle(1, ok([makeJob("b-1")], 1));
    await waitFor(() => expect(rowNumbers()).toHaveLength(1));
    expect(screen.getByText("Title b-1")).toBeInTheDocument();

    // A lands late and must not overwrite B's list or its totals.
    await settle(0, ok(makePage("a", 3), 3));
    expect(rowNumbers()).toHaveLength(1);
    expect(screen.getByText("Title b-1")).toBeInTheDocument();
    expect(screen.queryByText("Title a-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    expect(getJobsList).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("ignores a stale page failure and retries the actual failed page of the new query", async () => {
    const { rerender } = renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));
    await settle(0, ok(makePage("seed", 25), 26));
    await waitFor(() => expect(rowNumbers()).toHaveLength(25));

    // Old query's page-2 request goes in flight, then the filter switches.
    await triggerSentinel();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    expect(getJobsList).toHaveBeenLastCalledWith(
      2, 25, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "custom");
    await navigate(rerender, "/dashboard/myjobs?filter=interview");
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(3));

    // The new query's first page fails: the error belongs to generation 2.
    await settle(2, fail("new query failed"));
    await waitFor(() =>
      expect(screen.getByTestId("jobs-load-error")).toBeInTheDocument(),
    );
    expect(screen.getByText("new query failed")).toBeInTheDocument();
    // R3 retention: the previously loaded rows stay visible under the error.
    expect(rowNumbers()).toHaveLength(25);

    // The superseded page-2 request fails late: it must not overwrite the
    // error, the list, or failedPageRef — and must never toast.
    await settle(1, fail("stale page failure"));
    expect(screen.getByText("new query failed")).toBeInTheDocument();
    expect(screen.queryByText("stale page failure")).not.toBeInTheDocument();
    expect(rowNumbers()).toHaveLength(25);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenLastCalledWith("new query failed");

    // Retry must target the page that actually failed: page 1 of the new
    // query, not the stale request's page 2.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(4));
    expect(getJobsList).toHaveBeenLastCalledWith(
      1, 25, "interview", undefined, undefined, undefined, undefined, undefined, undefined, "custom");
    await settle(3, ok([makeJob("retried")], 1));
    await waitFor(() =>
      expect(
        screen.queryByTestId("jobs-load-error"),
      ).not.toBeInTheDocument(),
    );
    expect(rowNumbers()).toHaveLength(1);
    expect(screen.getByText("Title retried")).toBeInTheDocument();
  }, 15_000);

  it("keeps the newer error when a stale success resolves after it", async () => {
    const { rerender } = renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));

    await navigate(rerender, "/dashboard/myjobs?filter=interview");
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));

    // The current generation fails; the previous generation then succeeds
    // late — its success must not clear the newer error.
    await settle(1, fail("current failure"));
    await waitFor(() =>
      expect(screen.getByTestId("jobs-load-error")).toBeInTheDocument(),
    );
    await settle(0, ok([makeJob("stale")], 1));
    expect(screen.getByTestId("jobs-load-error")).toBeInTheDocument();
    expect(screen.getByText("current failure")).toBeInTheDocument();
    expect(screen.queryByText("Title stale")).not.toBeInTheDocument();
  }, 15_000);

  it("applies only the latest query across a search debounce and a filter change", async () => {
    const { rerender } = renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));

    const searchInput = screen.getByPlaceholderText("Search jobs...");
    await act(async () => {
      await user.type(searchInput, "Ama");
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    // The debounced replace already rewrote the params via the router mock;
    // rerender is the navigation commit.
    await act(async () => rerender(jsx()));
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    expect(getJobsList).toHaveBeenLastCalledWith(
      1, 25, undefined, "Ama", undefined, undefined, undefined, undefined, undefined, "custom");

    // A URL filter change lands while the debounced search request flies.
    await navigate(rerender, "/dashboard/myjobs?search=Ama&filter=interview");
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(3));
    expect(getJobsList).toHaveBeenLastCalledWith(
      1, 25, "interview", "Ama", undefined, undefined, undefined, undefined, undefined, "custom");

    await settle(2, ok([makeJob("latest")], 1));
    await waitFor(() => expect(rowNumbers()).toHaveLength(1));
    expect(screen.getByText("Title latest")).toBeInTheDocument();

    // Both superseded responses land late: neither appends nor replaces.
    await settle(1, ok([makeJob("search-only")], 1));
    await settle(0, ok(makePage("initial", 2), 2));
    expect(rowNumbers()).toHaveLength(1);
    expect(screen.getByText("Title latest")).toBeInTheDocument();
    expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    expect(getJobsList).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("drops a stale page response that lands during a job-write refresh", async () => {
    const { rerender } = renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));
    await settle(0, ok(makePage("seed", 25), 26));
    await waitFor(() => expect(rowNumbers()).toHaveLength(25));

    // Page 2 is in flight when the agent writes a job and forces a reload.
    await triggerSentinel();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    await act(async () => {
      agentChatState.jobWrites = 1;
      rerender(jsx());
    });
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(3));
    expect(getJobsList).toHaveBeenLastCalledWith(
      1, 25, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "custom");

    // The stale page-2 response lands while the refresh is still loading:
    // it must not append onto (or replace) the list being rebuilt.
    await settle(1, ok([makeJob("stale-page2")], 26));
    expect(rowNumbers()).toHaveLength(25);
    expect(screen.queryByText("Title stale-page2")).not.toBeInTheDocument();

    await settle(2, ok([makeJob("fresh-1"), makeJob("fresh-2")], 2));
    await waitFor(() => expect(rowNumbers()).toHaveLength(2));
    expect(screen.getByText("Title fresh-1")).toBeInTheDocument();
    expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    expect(getJobsList).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("retries the failed page and appends its rows to the retained list", async () => {
    renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));
    await settle(0, ok(makePage("seed", 25), 26));
    await waitFor(() => expect(rowNumbers()).toHaveLength(25));

    await triggerSentinel();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    await settle(1, fail("page 2 failed"));

    await waitFor(() =>
      expect(screen.getByTestId("jobs-load-error")).toBeInTheDocument(),
    );
    // R3 retention: page-1 rows stay rendered under the failure.
    expect(rowNumbers()).toHaveLength(25);
    expect(toastError).toHaveBeenCalledWith("page 2 failed");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(3));
    // Retry re-requests page 2 under the same generation, not page 1.
    expect(getJobsList).toHaveBeenLastCalledWith(
      2, 25, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "custom");
    await settle(2, ok([makeJob("page2-row")], 26));
    await waitFor(() => expect(rowNumbers()).toHaveLength(26));
    expect(
      screen.queryByTestId("jobs-load-error"),
    ).not.toBeInTheDocument();
    expect(rowNumbers()[25]).toHaveTextContent("26");
    expect(screen.getByText("Title seed-1")).toBeInTheDocument();
    expect(screen.getByText("Title page2-row")).toBeInTheDocument();
  }, 15_000);

  it("keeps the committed query's in-flight request valid when React abandons a render", async () => {
    // A render pass React discards (suspended here, never committed) must not
    // invalidate the committed query's in-flight request. A render-phase
    // generation write would have bumped it anyway.
    let captured: any = null;
    const gate: { pending: Promise<void> | null } = { pending: null };
    const HookHarness = () => {
      const list = useJobsList({
        companyFilter: null,
        appliedFilter: false,
        titleFilter: null,
        locationFilter: null,
        sourceFilter: null,
      });
      if (gate.pending) throw gate.pending;
      captured = list;
      return null;
    };
    const harness = () => (
      <Suspense fallback={<div data-testid="harness-fallback" />}>
        <HookHarness />
      </Suspense>
    );
    const { rerender } = render(harness());
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));

    // The new-query render starts but suspends before commit: React throws
    // the work away and commits the fallback instead.
    gate.pending = new Promise<void>(() => {});
    setUrl("/dashboard/myjobs?filter=interview");
    await act(async () => rerender(harness()));
    expect(screen.getByTestId("harness-fallback")).toBeInTheDocument();

    // The committed query's response lands while that render is abandoned.
    await settle(0, ok([makeJob("committed-a")], 1));

    gate.pending = null;
    await act(async () => rerender(harness()));
    expect(captured?.jobs.map((job: any) => job.id)).toEqual(["committed-a"]);

    // The committed query change still refetches once it actually lands.
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    expect(getJobsList).toHaveBeenLastCalledWith(
      1, 25, "interview", undefined, undefined, undefined, undefined, undefined, undefined, "custom");
  }, 15_000);

  it("does not append rows whose id is already in the list", async () => {
    renderComponent();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(1));
    const firstPage = makePage("seed", 25);
    await settle(0, ok(firstPage, 27));
    await waitFor(() => expect(rowNumbers()).toHaveLength(25));

    // A write between pages shifts the window: page 2 echoes a row that was
    // already appended from page 1.
    await triggerSentinel();
    await waitFor(() => expect(getJobsList).toHaveBeenCalledTimes(2));
    await settle(
      1,
      ok([firstPage[24], makeJob("seed-26"), makeJob("seed-27")], 27),
    );
    await waitFor(() => expect(rowNumbers()).toHaveLength(27));
    expect(screen.getAllByText("Title seed-25")).toHaveLength(1);
    expect(rowNumbers()[26]).toHaveTextContent("27");
    expect(getJobsList).toHaveBeenCalledTimes(2);
  }, 15_000);
});
