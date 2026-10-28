import { act, renderHook } from "@testing-library/react";
import { useQueryDialog } from "@/hooks/useQueryDialog";

let searchParams = new URLSearchParams();
const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/dashboard/tasks",
  useSearchParams: () => searchParams,
}));

beforeEach(() => {
  replace.mockClear();
  searchParams = new URLSearchParams();
});

it.each(["add-job", "add-task", "add-activity", "add-question", "import-resume"])(
  "consumes %s without losing filters and handles a second toolbar click",
  (parameter) => {
    const open = vi.fn();
    searchParams = new URLSearchParams(`${parameter}=true&status=open`);
    const { rerender } = renderHook(() => useQueryDialog(parameter, open));
    expect(open).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenLastCalledWith("/dashboard/tasks?status=open", { scroll: false });
    rerender();
    expect(open).toHaveBeenCalledTimes(1);
    act(() => { searchParams = new URLSearchParams("status=open"); rerender(); });
    act(() => { searchParams = new URLSearchParams(`${parameter}=true&status=open`); rerender(); });
    expect(open).toHaveBeenCalledTimes(2);
  },
);

it("does not open an unavailable flow or alter its URL", () => {
  searchParams = new URLSearchParams("import-resume=true");
  const open = vi.fn();
  renderHook(() => useQueryDialog("import-resume", open, false));
  expect(open).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("ignores unrelated and false parameters", () => {
  searchParams = new URLSearchParams("add-task=false&filter=todo");
  const open = vi.fn();
  renderHook(() => useQueryDialog("add-task", open));
  expect(open).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});
