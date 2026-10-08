import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiAssignmentsCard from "@/components/settings/AiAssignmentsCard";

vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/actions/shared", () => ({ requireUser: () => ({ id: "u" }) }));
vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
const persisted = vi.hoisted(() => [
  { id: "managed", provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Vocatrya Managed", status: "REAUTH_REQUIRED", accountIdentity: null, runtimeProfileRef: null, lastVerifiedAt: null, createdAt: new Date() },
  { id: "account", provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", displayName: "Own account", status: "REAUTH_REQUIRED", accountIdentity: null, runtimeProfileRef: null, lastVerifiedAt: null, createdAt: new Date() },
]);
// Real list action and service run against this persisted-row projection.
vi.mock("@/lib/db", () => ({ default: { aIConnection: { findMany: vi.fn(async () => persisted) } } }));
vi.mock("@/actions/aiAssignment.actions", () => ({
  listBusinessAiAssignments: async () => ({ success: true, data: [{ id: "historical", purpose: "GLOBAL_DEFAULT", connectionId: "managed", model: "stable-model" }] }),
  resolveBusinessAiConfig: async () => ({ success: true, data: { status: "INVALID_ASSIGNMENT", code: "MANAGED_EXECUTION_NOT_IMPLEMENTED" } }),
  clearBusinessAiAssignment: vi.fn(), setBusinessAiAssignment: vi.fn(),
}));
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
});
it("account picker excludes restored Managed while retaining a historical assignment without retargeting", async () => {
  const user = userEvent.setup();
  render(<AiAssignmentsCard />);
  await waitFor(() => expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0));
  expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument();
  await user.click(screen.getAllByRole("combobox")[0]);
  expect(await screen.findByRole("option", { name: /Own account/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Vocatrya/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Vocatrya Managed/)).not.toBeInTheDocument();
  expect(screen.getByDisplayValue("stable-model")).toBeInTheDocument();
});
