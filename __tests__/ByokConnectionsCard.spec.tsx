import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiServicesLayout from "@/components/settings/AiServicesLayout";
import ByokConnectionsCard from "@/components/settings/ByokConnectionsCard";

const actions = vi.hoisted(() => ({ getUserApiKeys: vi.fn(), saveApiKey: vi.fn(), deleteApiKey: vi.fn() }));
vi.mock("@/actions/apiKey.actions", () => actions);
vi.mock("@/actions/byokCredential.actions", () => ({ getByokCredentialStorageStatus: vi.fn(async () => ({ success: false })), migrateByokCredentialsToOsStore: vi.fn(), verifyByokCredentials: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

it("retains an unverified key draft and moves the saved service into the center", async () => {
  actions.getUserApiKeys.mockResolvedValue({ success: true, data: [] });
  actions.saveApiKey.mockImplementation(async () => {
    actions.getUserApiKeys.mockResolvedValue({ success: true, data: [{ provider: "deepseek", last4: "1234", protection: "os" }] });
    return { success: true };
  });
  const verify = vi.fn().mockResolvedValueOnce({ json: async () => ({ success: false, error: "Invalid key" }) }).mockResolvedValueOnce({ json: async () => ({ success: true }) });
  vi.stubGlobal("fetch", verify);
  render(<AiServicesLayout><ByokConnectionsCard /></AiServicesLayout>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Vocatrya Hosted AI" }));
  await user.click(await screen.findByRole("button", { name: "DeepSeek" }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByLabelText("API Key");
  fireEvent.change(input, { target: { value: "test-key-1234" } });
  await user.click(within(dialog).getByRole("button", { name: "Verify & Save" }));
  expect(input).toHaveValue("test-key-1234");
  expect(actions.saveApiKey).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Verify & Save" }));
  await waitFor(() => expect(within(screen.getByTestId("ai-services-byok-connected")).getByText("DeepSeek")).toBeInTheDocument());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(within(screen.getByTestId("ai-services-byok-available")).queryByText("DeepSeek")).not.toBeInTheDocument();
});
