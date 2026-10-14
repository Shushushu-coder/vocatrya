import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";

vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
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
// Managed reads fail Hosted-unavailable here: the sentinel option must
// not appear, and the historical managed assignment still renders as the
// saved pair (retargeting is never implicit).
vi.mock("@/actions/managedAi.actions", () => ({
  getManagedAiOverview: async () => ({ success: true, data: { connection: null, entitlement: null, usage: null, models: [], errorCode: "MANAGED_AUTH_REQUIRED" } }),
  assignManagedBusinessAiSource: vi.fn(),
}));
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
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
