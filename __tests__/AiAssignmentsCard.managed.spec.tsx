import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";
import { toastError } from "@/lib/toast";

vi.mock("@/i18n", () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock("@/actions/shared", () => ({ requireUser: () => ({ id: "u" }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
const persisted = vi.hoisted(() => [
  { id: "managed", provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Vocatrya Managed", status: "REAUTH_REQUIRED", accountIdentity: null, runtimeProfileRef: null, lastVerifiedAt: null, createdAt: new Date() },
  { id: "account", provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", displayName: "Own account", status: "REAUTH_REQUIRED", accountIdentity: null, runtimeProfileRef: null, lastVerifiedAt: null, createdAt: new Date() },
  { id: "byok", provider: "DEEPSEEK", backendKind: "LOCAL_BYOK", authType: "API_KEY", displayName: "DeepSeek (API key)", status: "CONNECTED", accountIdentity: null, runtimeProfileRef: null, credentialRef: "9b2d1c2a-0000-4000-8000-000000000001", archivedAt: null, lastVerifiedAt: null, createdAt: new Date() },
]);
// Real list action and service run against this persisted-row projection.
vi.mock("@/lib/db", () => ({ default: {
  aIConnection: { findMany: vi.fn(async () => persisted), update: vi.fn(async () => ({})), create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
  apiKey: { findMany: vi.fn(async () => [{ id: "9b2d1c2a-0000-4000-8000-000000000001", provider: "deepseek" }]) },
} }));
vi.mock("@/actions/aiAssignment.actions", () => ({
  listBusinessAiAssignments: async () => ({ success: true, data: [{ id: "historical", purpose: "GLOBAL_DEFAULT", connectionId: "managed", model: "stable-model", connection: { id: "managed", provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", displayName: "Vocatrya Managed", status: "CONNECTED" } }] }),
  resolveBusinessAiConfig: async () => ({ success: true, data: { status: "INVALID_ASSIGNMENT", code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" } }),
  clearBusinessAiAssignment: vi.fn(), setBusinessAiAssignment: vi.fn(),
}));
// By default Managed reads fail Hosted-unavailable here: the sentinel option
// must not appear, and the historical managed assignment still renders as the
// saved pair (retargeting is never implicit).
const managedOverview = vi.hoisted(() => {
  const unavailable = { availability: "ENABLED", connection: null, entitlement: null, usage: null, models: [], errorCode: "MANAGED_AUTH_REQUIRED" } as Record<string, unknown>;
  return { unavailable, current: unavailable };
});
const assignManaged = vi.hoisted(() => vi.fn());
vi.mock("@/actions/managedAi.actions", () => ({
  getManagedAiOverview: async () => ({ success: true, data: managedOverview.current }),
  assignManagedBusinessAiSource: assignManaged,
}));
const COMING_SOON = { availability: "COMING_SOON", connection: null, entitlement: null, usage: null, models: [], errorCode: null };
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
});
afterEach(() => {
  managedOverview.current = managedOverview.unavailable;
});
it("picker offers account + BYOK connections while a historical Managed assignment keeps its saved pair", async () => {
  const user = userEvent.setup();
  render(<AiAssignmentsCard />);
  await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
  expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument();
  await user.click(screen.getAllByRole("combobox")[0]);
  expect(await screen.findByRole("option", { name: /Own account/ })).toBeInTheDocument();
  expect(await screen.findByRole("option", { name: /DeepSeek \(API key\)/ })).toBeInTheDocument();
  // Hosted is unavailable in this fixture — no Managed sentinel option.
  expect(screen.queryByRole("option", { name: /Vocatrya Managed AI/ })).not.toBeInTheDocument();
  expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument();
});

async function openFirstPicker() {
  const user = userEvent.setup();
  render(<AiAssignmentsCard />);
  await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
  await user.click(screen.getAllByRole("combobox")[0]);
  return user;
}

it("offers the Managed option once Managed AI is launched and connected", async () => {
  managedOverview.current = {
    availability: "ENABLED",
    connection: { id: "managed", displayName: "Vocatrya Managed AI", status: "CONNECTED", lastVerifiedAt: null },
    entitlement: null, usage: null, models: [], errorCode: null,
  };
  await openFirstPicker();
  expect(await screen.findByRole("option", { name: "settings.aiAssignManagedOption" })).toBeInTheDocument();
});

it("offers no Managed option and no outage notice while Managed AI is coming soon, leaving account and BYOK untouched", async () => {
  managedOverview.current = COMING_SOON;
  await openFirstPicker();
  expect(await screen.findByRole("option", { name: /Own account/ })).toBeInTheDocument();
  expect(await screen.findByRole("option", { name: /DeepSeek \(API key\)/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "settings.aiAssignManagedOption" })).not.toBeInTheDocument();
  expect(screen.queryByText("settings.aiAssignManagedGroup")).not.toBeInTheDocument();
  expect(screen.queryByText(/settings\.aiAssignManagedUnavailable/)).not.toBeInTheDocument();
  expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument();
});

it("explains Coming Soon, not a generic error, when a historical Managed assignment is saved", async () => {
  managedOverview.current = COMING_SOON;
  assignManaged.mockResolvedValue({ success: false, code: "MANAGED_NOT_LAUNCHED" });
  const user = userEvent.setup();
  render(<AiAssignmentsCard />);
  await waitFor(() => expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument());
  fireEvent.change(screen.getByDisplayValue("stable-model"), { target: { value: "edited-model" } });
  await user.click(screen.getAllByRole("button", { name: "common.save" })[0]);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith("settings.aiAssignManagedComingSoon"));
  expect(assignManaged).toHaveBeenCalledWith({ purpose: "GLOBAL_DEFAULT", modelKey: "edited-model" });
});

it.each([
  ["NOT_ENTITLED", "settings.aiAssignErrNotEntitled"],
  ["MODEL_NOT_ALLOWED", "settings.aiAssignErrModelNotAllowed"],
])("explains Managed assignment rejection %s", async (code, messageKey) => {
  assignManaged.mockResolvedValue({ success: false, code });
  const user = userEvent.setup();
  render(<AiAssignmentsCard />);
  await waitFor(() => expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument());
  fireEvent.change(screen.getByDisplayValue("stable-model"), { target: { value: "edited-model" } });
  await user.click(screen.getAllByRole("button", { name: "common.save" })[0]);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(messageKey));
});

it("does not mark an unchanged Managed assignment dirty", async () => {
  render(<AiAssignmentsCard />);
  await screen.findByDisplayValue("stable-model");
  expect(screen.getAllByRole("button", { name: "common.save" })[0]).toBeDisabled();
});

it("keeps the edited Managed model and explains an unconfirmed transport result", async () => {
  assignManaged.mockRejectedValueOnce(new Error("transport"));
  render(<AiAssignmentsCard />);
  await screen.findByDisplayValue("stable-model");
  fireEvent.change(screen.getByDisplayValue("stable-model"), { target: { value: "retry-model" } });
  fireEvent.click(screen.getAllByRole("button", { name: "common.save" })[0]);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith("settings.aiAssignSaveUnconfirmed"));
  expect(screen.getByDisplayValue("retry-model")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "common.save" })[0]).toBeEnabled();
});

it("uses the committed Managed assignment returned by save without another overview read", async () => {
  assignManaged.mockResolvedValueOnce({ success: true, data: {
    id: "historical", purpose: "GLOBAL_DEFAULT", connectionId: "managed", model: "committed-model",
    connection: { id: "managed", provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", displayName: "Vocatrya Managed", status: "CONNECTED" },
  } });
  render(<AiAssignmentsCard />);
  await screen.findByDisplayValue("stable-model");
  fireEvent.change(screen.getByDisplayValue("stable-model"), { target: { value: "committed-model" } });
  fireEvent.click(screen.getAllByRole("button", { name: "common.save" })[0]);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "common.save" })[0]).toBeDisabled());
  expect(screen.getByDisplayValue("committed-model")).toBeInTheDocument();
});
