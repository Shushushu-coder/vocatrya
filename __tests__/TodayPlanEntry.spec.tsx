import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { TodayPlanEntry } from "@/components/todayPlan/TodayPlanEntry";
import type { TodayPlanView } from "@/lib/todayPlan/types";

const mock = vi.hoisted(() => ({ cid: "a" as string | null, role: "pilot", read: vi.fn(), write: vi.fn(), undo: vi.fn(), ensure: vi.fn(), t: (key: string) => key }));
vi.mock("@/components/agent/AgentChatProvider", () => ({ useAgentChat: () => ({ conversationId: mock.cid, activeRole: mock.role, ensureTodayPlanConversation: mock.ensure }) }));
vi.mock("@/actions/todayPlan.actions", () => ({ getTodayPlan: mock.read, mutateTodayPlan: mock.write, undoTodayPlan: mock.undo }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: mock.t }) }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children, onOpenChange }: any) => <div><button onClick={() => onOpenChange(true)}>open</button>{children}</div>,
  PopoverTrigger: ({ children }: any) => children,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("next/link", () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const item = (id: string) => ({ id, taskId: `task-${id}`, title: id, status: "in-progress", completed: false, plannedOn: "2026-11-24", position: 0 });
const view = (cid: string): TodayPlanView => ({ conversationId: cid, conversationTitle: `Chat ${cid}`, conversationTitleFallback: null, today: "2026-11-24", tomorrow: "2026-11-25", timeZone: "Asia/Shanghai", buckets: { today: [item(cid)], tomorrow: [], later: [], overdue: [], history: [] } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  mock.cid = "a"; mock.role = "pilot";
  mock.read.mockReset().mockImplementation(async cid => ({ success: true, data: view(cid) }));
  mock.write.mockReset().mockResolvedValue({ success: true, data: { status: "ok", changed: [], operationId: "op", undoable: true } });
  mock.ensure.mockReset().mockResolvedValue("created"); mock.undo.mockReset();
});
afterEach(cleanup);

it("discards a delayed old-conversation read after switching", async () => {
  const late = deferred<any>(); mock.read.mockImplementation(cid => cid === "a" ? late.promise : Promise.resolve({ success: true, data: view(cid) }));
  const ui = render(<TodayPlanEntry />); mock.cid = "b"; ui.rerender(<TodayPlanEntry />);
  await screen.findByText("b");
  await act(async () => late.resolve({ success: true, data: view("a") }));
  expect(screen.queryByText("a")).toBeNull(); expect(screen.getByText("b")).toBeInTheDocument();
});
it("discards a pending write receipt after switching, including A-B-A", async () => {
  const late = deferred<any>(); mock.write.mockReturnValue(late.promise);
  const ui = render(<TodayPlanEntry />); await screen.findByText("a");
  fireEvent.click(screen.getByRole("checkbox"));
  mock.cid = "b"; ui.rerender(<TodayPlanEntry />); await screen.findByText("b");
  mock.cid = "a"; ui.rerender(<TodayPlanEntry />); await screen.findByText("a");
  await act(async () => late.resolve({ success: true, data: { status: "ok", undoable: true, operationId: "old" } }));
  expect(screen.queryByRole("button", { name: "todayPlan.undo" })).toBeNull();
});
it("creates a conversation only on explicit manual add", async () => {
  mock.cid = null; render(<TodayPlanEntry />); expect(mock.ensure).not.toHaveBeenCalled(); expect(mock.read).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "manual" } });
  fireEvent.click(screen.getByRole("button", { name: "todayPlan.createAndAdd" }));
  await waitFor(() => expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "created", write: { action: "add", titles: ["manual"], target: "today" } })));
});
it("exposes rename, move and all history items", async () => {
  const data = view("a"); data.buckets.history = Array.from({ length: 8 }, (_, i) => ({ ...item(`history${i}`), plannedOn: "2026-11-01", completed: true }));
  mock.read.mockResolvedValue({ success: true, data }); render(<TodayPlanEntry />);
  await screen.findByText("history0"); expect(screen.getByText("history7")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "todayPlan.edit" })[0]);
  fireEvent.change(screen.getByRole("textbox", { name: "todayPlan.edit" }), { target: { value: "renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "todayPlan.save" }));
  await waitFor(() => expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({ write: { action: "rename", selector: { itemId: "a" }, newTitle: "renamed" } })));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "todayPlan.edit" })).toBeNull());
  fireEvent.click(screen.getAllByRole("button", { name: "todayPlan.moveTomorrow" })[0]);
  await waitFor(() => expect(mock.write).toHaveBeenCalledWith(expect.objectContaining({ write: { action: "move", selector: { itemId: "a" }, target: "tomorrow" } })));
});
it("shows load errors and retries instead of displaying an empty checklist", async () => {
  mock.read.mockResolvedValueOnce({ success: false, message: "load failed" }); render(<TodayPlanEntry />);
  expect(await screen.findByRole("alert")).toHaveTextContent("load failed");
  fireEvent.click(screen.getByRole("button", { name: "todayPlan.retry" }));
  await screen.findByText("a"); expect(screen.queryByRole("alert")).toBeNull();
});
it("refreshes on opening, focus, and visible day rollover", async () => {
  render(<TodayPlanEntry />); await screen.findByText("a");
  mock.read.mockClear(); fireEvent.click(screen.getByText("open")); await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(1));
  fireEvent.focus(window); await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(2));
  const data = view("a"); data.today = "2026-11-25"; data.buckets.overdue = data.buckets.today; data.buckets.today = [];
  mock.read.mockResolvedValue({ success: true, data }); fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(screen.getByText(/2026-11-25/)).toBeInTheDocument());
  expect(screen.getByText("todayPlan.overdue")).toBeInTheDocument();
});
