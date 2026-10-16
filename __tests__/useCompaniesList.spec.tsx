import { act, renderHook, waitFor } from "@testing-library/react";
import { useCompaniesList } from "@/components/admin/companies-container/useCompaniesList";
import { getCompanyList } from "@/actions/company.actions";

vi.mock("@/actions/company.actions", () => ({
  getCompanyList: vi.fn(),
}));

// The real blocked-family Action result — shape must match queries.ts.
const BLOCKED_RESULT = {
  success: false,
  message: "Career jobs are unavailable (ab-migration-incomplete)",
};

const LIST_RESPONSE = {
  data: [
    {
      id: "1",
      label: "Amazon",
      value: "amazon",
      createdBy: "user-1",
      _count: { contacts: 0 },
    },
  ],
  total: 1,
};

async function settle() {
  // load()'s continuation is a microtask behind a setTimeout(0); crossing a
  // real macrotask boundary flushes both.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useCompaniesList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads a non-empty list and stays error-free", async () => {
    (getCompanyList as any).mockResolvedValue(LIST_RESPONSE);

    const { result } = renderHook(() => useCompaniesList("mine", "", true));

    await waitFor(() => expect(result.current.companies).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(result.current.total).toBe(1);
    expect(result.current.initialLoading).toBe(false);
  });

  it("keeps a genuinely empty list distinct from a failure", async () => {
    (getCompanyList as any).mockResolvedValue({ data: [], total: 0 });

    const { result } = renderHook(() => useCompaniesList("mine", "", true));

    await waitFor(() => expect(getCompanyList).toHaveBeenCalledTimes(1));
    await settle();
    expect(result.current.companies).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.initialLoading).toBe(false);
  });

  it("surfaces a failed Action result instead of an empty list", async () => {
    (getCompanyList as any).mockResolvedValue(BLOCKED_RESULT);

    const { result } = renderHook(() => useCompaniesList("mine", "", true));

    await waitFor(() =>
      expect(result.current.error).toBe(BLOCKED_RESULT.message),
    );
    expect(result.current.companies).toEqual([]);
    expect(result.current.initialLoading).toBe(false);
  });

  it("surfaces a rejected Action call instead of hanging on a spinner", async () => {
    (getCompanyList as any).mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useCompaniesList("mine", "", true));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.initialLoading).toBe(false);
    expect(result.current.loadingMore).toBe(false);
  });

  it("surfaces an empty Action result as a failure too", async () => {
    (getCompanyList as any).mockResolvedValue(undefined);

    const { result } = renderHook(() => useCompaniesList("mine", "", true));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.companies).toEqual([]);
  });

  it("clears the error and restores the real list after a successful retry", async () => {
    (getCompanyList as any)
      .mockResolvedValueOnce(BLOCKED_RESULT)
      .mockResolvedValue(LIST_RESPONSE);

    const { result } = renderHook(() => useCompaniesList("mine", "", true));

    await waitFor(() =>
      expect(result.current.error).toBe(BLOCKED_RESULT.message),
    );

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.companies).toHaveLength(1);
    expect(result.current.total).toBe(1);
    expect(getCompanyList).toHaveBeenCalledTimes(2);
  });

  it("does not fetch at all while the tab is inactive", async () => {
    (getCompanyList as any).mockResolvedValue(LIST_RESPONSE);

    renderHook(() => useCompaniesList("mine", "", false));

    await settle();
    expect(getCompanyList).not.toHaveBeenCalled();
  });
});
