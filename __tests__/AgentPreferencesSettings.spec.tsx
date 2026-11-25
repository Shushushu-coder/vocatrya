import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import AgentPreferencesSettings from "@/components/settings/AgentPreferencesSettings";
import { DEFAULT_AGENT_PREFERENCES } from "@/lib/agent/preferences";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock("@/actions/agentPreferences.actions", () => ({ getAgentPreferences: mocks.get, saveAgentPreferences: mocks.save }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ locale: "zh-CN" }) }));

beforeEach(() => { mocks.get.mockResolvedValue(DEFAULT_AGENT_PREFERENCES); mocks.save.mockResolvedValue({ success: true }); });
it("loads, edits and saves all preferences; invalid text cannot be saved", async () => {
  render(<AgentPreferencesSettings />);
  const save = screen.getByRole("button", { name: "保存偏好" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(screen.getByLabelText("自定义提示词"), { target: { value: "只使用真实经历" } });
  fireEvent.change(screen.getByLabelText("默认权限"), { target: { value: "ask" } });
  fireEvent.click(save);
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ personalInstructions: "只使用真实经历", defaultPermission: "ask" })));
  await screen.findByText("已保存");
  fireEvent.change(screen.getByLabelText("自定义提示词"), { target: { value: "长".repeat(2001) } });
  expect(save).toBeDisabled();
});
it("keeps saving disabled when loading fails instead of overwriting preferences with defaults", async () => {
  mocks.get.mockRejectedValue(new Error("offline"));
  render(<AgentPreferencesSettings />);
  await screen.findByText("设置加载失败，请重新打开设置重试。");
  expect(screen.getByRole("button", { name: "保存偏好" })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("exposes the permission comparison on hover as well as keyboard focus", async () => {
  render(<AgentPreferencesSettings />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存偏好" })).toBeEnabled());
  fireEvent.mouseEnter(screen.getByRole("button", { name: "权限模式说明" }));
  const table = await screen.findByRole("table", { name: "业务工具的三档权限" });
  expect(table).toBeInTheDocument();
  expect(table).toHaveTextContent("帮我审批（推荐）");
  expect(table).toHaveTextContent("完全访问（不推荐）");
  expect(table).toHaveTextContent("本机系统级风险由用户自担");
});
it("keeps approve-by-rules as recommended default and shows explicit risk warning when full access is chosen", async () => {
  render(<AgentPreferencesSettings />);
  const select = screen.getByLabelText("默认权限") as HTMLSelectElement;
  await waitFor(() => expect(select).toBeEnabled());
  expect(select.value).toBe("rules");
  expect(screen.getByRole("option", { name: "帮我审批（推荐）" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "完全访问（不推荐）" })).toBeInTheDocument();
  expect(screen.queryByTestId("full-access-risk-warning")).not.toBeInTheDocument();
  fireEvent.change(select, { target: { value: "full" } });
  const warning = screen.getByTestId("full-access-risk-warning");
  expect(warning).toHaveTextContent("不推荐使用「完全访问」");
  expect(warning).toHaveTextContent("由用户自担");
});
