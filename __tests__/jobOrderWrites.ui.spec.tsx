import { act, renderHook, waitFor } from "@testing-library/react";
import { useJobsList } from "@/components/myjobs/jobs-container/useJobsList";
import { getJobsList, reorderJob, setJobPinned } from "@/actions/job.actions";
import type { JobResponse } from "@/models/job.model";

const state = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard/myjobs",
  useSearchParams: () => state.params,
}));
vi.mock("@/components/agent/AgentChatProvider", () => ({ useAgentChat: () => ({ jobWrites: 0 }) }));
vi.mock("@/actions/job.actions", () => ({ getJobsList: vi.fn(), reorderJob: vi.fn(), setJobPinned: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), GENERIC_ERROR_MESSAGE: "Failed" }));
const options = { companyFilter: null, appliedFilter: false, titleFilter: null, locationFilter: null, sourceFilter: null };
const rows = ["a", "b", "c"].map((id) => ({ id, pinnedAt: null }) as JobResponse);
function deferred() {
  let resolve!: (result: { success: boolean; message?: string }) => void;
  const promise = new Promise<{ success: boolean; message?: string }>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  state.params = new URLSearchParams();
  vi.mocked(getJobsList).mockResolvedValue({ success: true, data: rows, total: 3 });
});

it("serializes pin and move writes and restores a failed move's own snapshot", async () => {
  const pending = deferred();
  vi.mocked(reorderJob).mockReturnValue(pending.promise);
  const { result } = renderHook(() => useJobsList(options));
  await waitFor(() => expect(result.current.jobs).toHaveLength(3));
  act(() => { void result.current.moveJob("c", "a"); });
  expect(result.current.jobs.map((row) => row.id)).toEqual(["a", "c", "b"]);
  await act(async () => { await result.current.toggleJobPinned("b", true); });
  expect(setJobPinned).not.toHaveBeenCalled();
  await act(async () => { pending.resolve({ success: false }); });
  expect(result.current.jobs.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(result.current.orderSaving).toBe(false);
});

it("does not roll a new filter's list back when an old order write fails", async () => {
  const pending = deferred();
  vi.mocked(reorderJob).mockReturnValue(pending.promise);
  const { result, rerender } = renderHook(() => useJobsList(options));
  await waitFor(() => expect(result.current.jobs).toHaveLength(3));
  act(() => { void result.current.moveJob("c", "a"); });
  vi.mocked(getJobsList).mockResolvedValue({ success: true, data: [rows[1]], total: 1 });
  state.params = new URLSearchParams("filter=interview");
  rerender();
  await waitFor(() => expect(result.current.jobs).toHaveLength(1));
  await act(async () => { pending.resolve({ success: false }); });
  expect(result.current.jobs.map((row) => row.id)).toEqual(["b"]);
});

it("reloads a saved pin under date sorting to reconcile page membership", async () => {
  state.params = new URLSearchParams("sort=createdAtDesc");
  vi.mocked(setJobPinned).mockResolvedValue({ success: true });
  const { result } = renderHook(() => useJobsList(options));
  await waitFor(() => expect(result.current.jobs).toHaveLength(3));
  await act(async () => { await result.current.toggleJobPinned("c", true); });
  expect(setJobPinned).toHaveBeenCalledWith("c", true);
  expect(getJobsList).toHaveBeenCalledTimes(2);
  expect(vi.mocked(getJobsList).mock.calls[1][9]).toBe("createdAtDesc");
});
