import { act, renderHook, waitFor } from "@testing-library/react";
import { useTasksList } from "@/components/tasks/tasks-container/useTasksList";
import { getActivityTypesWithTaskCounts, getTasksList } from "@/actions/task.actions";

vi.mock("@/actions/task.actions", () => ({
  getActivityTypesWithTaskCounts: vi.fn(),
  getTasksList: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("does not let a previous search overwrite the current category counts", async () => {
  const old = deferred<any>();
  const latest = deferred<any>();
  vi.mocked(getTasksList).mockResolvedValue({ success: true, data: [], total: 0 });
  vi.mocked(getActivityTypesWithTaskCounts)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise);
  const { result } = renderHook(() => useTasksList({}));
  await waitFor(() => expect(getActivityTypesWithTaskCounts).toHaveBeenCalledTimes(1));
  act(() => result.current.setSearchTerm("new search"));
  await waitFor(() => expect(getActivityTypesWithTaskCounts).toHaveBeenCalledTimes(2));
  await act(async () => latest.resolve({ success: true, data: [], totalTasks: 7 }));
  expect(result.current.typeTotal).toBe(7);
  await act(async () => old.resolve({ success: true, data: [], totalTasks: 99 }));
  expect(result.current.typeTotal).toBe(7);
});
