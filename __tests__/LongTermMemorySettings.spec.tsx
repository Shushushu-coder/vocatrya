import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import LongTermMemorySettings from "@/components/settings/LongTermMemorySettings";
import { DEFAULT_AGENT_PREFERENCES } from "@/lib/agent/preferences";
import { translate } from "@/i18n/translate";

const mocks = vi.hoisted(() => ({
  getPrefs: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  edit: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  setEnabled: vi.fn(),
  locale: "zh-CN" as "zh-CN" | "en",
}));

vi.mock("@/actions/agentPreferences.actions", () => ({
  getAgentPreferences: mocks.getPrefs,
}));
vi.mock("@/actions/userMemory.actions", () => ({
  getUserMemoryEntries: mocks.list,
  saveUserMemoryEntry: mocks.save,
  editUserMemoryEntry: mocks.edit,
  removeUserMemoryEntry: mocks.remove,
  clearAllUserMemory: mocks.clear,
  setLongTermMemoryEnabled: mocks.setEnabled,
}));
// Real translate(), mocked locale — assertions read the shipped strings.
vi.mock("@/i18n", () => ({
  useI18n: () => ({
    locale: mocks.locale,
    t: (key: string, params?: Record<string, string | number>) => translate(mocks.locale, key, params),
    formatDateTime: () => "2026-11-25 10:00",
    formatDate: () => "2026-11-25",
    formatMonthYear: () => "2026-11",
    formatNumber: (n: number) => String(n),
    setLocale: () => {},
  }),
}));

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "mem-1",
  category: "career_goal",
  key: "target_cities",
  content: "上海、杭州",
  source: "USER_MANUAL",
  sourceConversationId: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locale = "zh-CN";
  mocks.getPrefs.mockResolvedValue(DEFAULT_AGENT_PREFERENCES);
  mocks.list.mockResolvedValue([entry()]);
  mocks.save.mockResolvedValue({ success: true });
  mocks.edit.mockResolvedValue({ success: true });
  mocks.remove.mockResolvedValue({ success: true });
  mocks.clear.mockResolvedValue({ success: true });
  mocks.setEnabled.mockResolvedValue({ success: true });
});

it("defaults to enabled, groups entries by category and renders zh-CN", async () => {
  render(<LongTermMemorySettings />);
  const toggle = await screen.findByRole("switch", { name: "启用长期记忆" });
  expect(toggle).toHaveAttribute("data-state", "checked");
  expect(await screen.findByText("求职目标")).toBeInTheDocument();
  expect(screen.getByText("target_cities")).toBeInTheDocument();
  expect(screen.getByText("上海、杭州")).toBeInTheDocument();
  expect(screen.getByTestId("memory-count")).toHaveTextContent("1/40");
});

it("toggles the master switch through the dedicated write", async () => {
  render(<LongTermMemorySettings />);
  const toggle = await screen.findByRole("switch", { name: "启用长期记忆" });
  fireEvent.click(toggle);
  await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(false));
  expect(await screen.findByTestId("memory-disabled-hint")).toBeInTheDocument();
});

it("adds a manual entry and refreshes the list", async () => {
  render(<LongTermMemorySettings />);
  await screen.findByRole("switch", { name: "启用长期记忆" });
  fireEvent.click(screen.getByRole("button", { name: "新增条目" }));
  fireEvent.change(screen.getByLabelText("标识"), { target: { value: "salary_floor" } });
  fireEvent.change(screen.getByLabelText("内容"), { target: { value: "月薪不低于 30k" } });
  mocks.list.mockResolvedValueOnce([entry(), entry({ id: "mem-2", key: "salary_floor", content: "月薪不低于 30k" })]);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      category: "career_goal",
      key: "salary_floor",
      content: "月薪不低于 30k",
    }),
  );
  await waitFor(() => expect(screen.getByTestId("memory-count")).toHaveTextContent("2/40"));
});

it("edits and deletes an entry", async () => {
  render(<LongTermMemorySettings />);
  await screen.findByText("上海、杭州");
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByLabelText("内容"), { target: { value: "上海" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(mocks.edit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mem-1", content: "上海" }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ id: "mem-1" }));
});

it("requires a second click before clearing everything", async () => {
  render(<LongTermMemorySettings />);
  await screen.findByText("上海、杭州");
  const clear = screen.getByRole("button", { name: "清空全部记忆" });
  fireEvent.click(clear);
  expect(mocks.clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /确认清空/ }));
  await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1));
});

it("shows a provenance badge — hand-written rows are locked, AI rows are not", async () => {
  mocks.list.mockResolvedValue([
    entry({ id: "mem-manual", source: "USER_MANUAL" }),
    entry({ id: "mem-ai", source: "AI_EXTRACTED", key: "salary_floor", content: "30k" }),
  ]);
  render(<LongTermMemorySettings />);
  await screen.findByText("上海、杭州");
  expect(screen.getByTestId("memory-source-mem-manual")).toHaveTextContent("手写 · 已锁定");
  expect(screen.getByTestId("memory-source-mem-ai")).toHaveTextContent("自动沉淀");
});

it("renders the English labels when the locale is en", async () => {
  mocks.locale = "en";
  render(<LongTermMemorySettings />);
  await screen.findByRole("switch", { name: "Enable long-term memory" });
  expect(screen.getByText("Career goals")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add entry" })).toBeInTheDocument();
});
