import { useEffect, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AiServicesLayout, { AiServiceSlot } from "@/components/settings/AiServicesLayout";
import en from "@/i18n/messages/en.json";
import zhCN from "@/i18n/messages/zh-CN.json";

function Service() {
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  return <AiServiceSlot placement={connected ? "account-connected" : "account-available"}>
    <section aria-label="Example service">
      <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => setConnected(!connected)}>Toggle connection</button>
    </section>
  </AiServiceSlot>;
}

it("shows both service tabs with account sign-in selected by default", () => {
  render(<AiServicesLayout>{null}</AiServicesLayout>);
  expect(screen.getByRole("tab", { name: "Agent account sign-in" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Vocatrya Hosted AI" })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByTestId("ai-services-panel-account")).toBeVisible();
  expect(screen.getByTestId("ai-services-panel-managed")).not.toBeVisible();
});

it("switches the visible panel when selecting the managed tab", async () => {
  const user = userEvent.setup();
  render(<AiServicesLayout>{null}</AiServicesLayout>);
  await user.click(screen.getByRole("tab", { name: "Vocatrya Hosted AI" }));
  expect(screen.getByRole("tab", { name: "Vocatrya Hosted AI" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByTestId("ai-services-panel-managed")).toBeVisible();
  expect(screen.getByTestId("ai-services-panel-account")).not.toBeVisible();
});

it("switches tabs with arrow keys", async () => {
  const user = userEvent.setup();
  render(<AiServicesLayout>{null}</AiServicesLayout>);
  screen.getByRole("tab", { name: "Agent account sign-in" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Vocatrya Hosted AI" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Agent account sign-in" })).toHaveAttribute("aria-selected", "false");
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("tab", { name: "Agent account sign-in" })).toHaveAttribute("aria-selected", "true");
});

it("routes account services to the first tab and API/managed services to the second", () => {
  render(<AiServicesLayout>
    <AiServiceSlot placement="account-available"><span>Account service</span></AiServiceSlot>
    <AiServiceSlot placement="byok-available"><span>BYOK service</span></AiServiceSlot>
    <AiServiceSlot placement="managed-available"><span>Managed service</span></AiServiceSlot>
  </AiServicesLayout>);
  const accountPanel = within(screen.getByTestId("ai-services-panel-account"));
  const managedPanel = within(screen.getByTestId("ai-services-panel-managed"));
  expect(accountPanel.getByText("Account service")).toBeInTheDocument();
  expect(accountPanel.queryByText("BYOK service")).not.toBeInTheDocument();
  expect(accountPanel.queryByText("Managed service")).not.toBeInTheDocument();
  expect(managedPanel.getByText("BYOK service")).toBeInTheDocument();
  expect(managedPanel.getByText("Managed service")).toBeInTheDocument();
  expect(managedPanel.queryByText("Account service")).not.toBeInTheDocument();
});

it("keeps connected/available as secondary groups inside the account tab while retaining drafts across moves", () => {
  render(<AiServicesLayout><Service /></AiServicesLayout>);
  expect(within(screen.getByTestId("ai-services-account-available")).getByRole("region", { name: "Example service" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Toggle connection" }));
  expect(within(screen.getByTestId("ai-services-account-connected")).getByRole("region", { name: "Example service" })).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("unsaved draft");
  fireEvent.click(screen.getByRole("button", { name: "Toggle connection" }));
  expect(screen.getByRole("textbox")).toHaveValue("unsaved draft");
});

it("keeps a hidden tab's controller mounted with its draft and DOM node across tab switches", async () => {
  const mounts = vi.fn();
  function Draft() {
    const [draft, setDraft] = useState("");
    useEffect(() => { mounts(); }, []);
    return <AiServiceSlot placement="byok-available">
      <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
    </AiServiceSlot>;
  }
  const user = userEvent.setup();
  render(<AiServicesLayout><Draft /></AiServicesLayout>);
  const input = screen.getByLabelText("draft");
  fireEvent.change(input, { target: { value: "sk-draft" } });
  await user.click(screen.getByRole("tab", { name: "Vocatrya Hosted AI" }));
  expect(screen.getByLabelText("draft")).toBe(input);
  expect(input).toHaveValue("sk-draft");
  await user.click(screen.getByRole("tab", { name: "Agent account sign-in" }));
  expect(screen.getByLabelText("draft")).toBe(input);
  expect(input).toHaveValue("sk-draft");
  expect(mounts).toHaveBeenCalledTimes(1);
});

it("labels the managed tab's two API sources without implying Vocatrya pays for user keys", () => {
  render(<AiServicesLayout>{null}</AiServicesLayout>);
  const panel = within(screen.getByTestId("ai-services-panel-managed"));
  expect(panel.getByText("Your own model APIs")).toBeInTheDocument();
  expect(panel.getByText(/each provider bills you directly, not Vocatrya/)).toBeInTheDocument();
  expect(panel.getByText("Vocatrya-hosted API")).toBeInTheDocument();
});

it("keeps the connected-tab empty hint and ships the new copy in en and zh-CN", () => {
  render(<AiServicesLayout>{null}</AiServicesLayout>);
  expect(within(screen.getByTestId("ai-services-account-connected")).getByText(/No connected services yet/)).toBeInTheDocument();
  for (const messages of [en, zhCN]) {
    const settings = messages.settings as Record<string, unknown>;
    for (const key of ["aiServicesTabAccount", "aiServicesTabManaged", "aiServicesByokTitle", "aiServicesByokHint", "aiServicesManagedGroupTitle"]) {
      expect(settings[key]).toMatch(/\S/);
    }
  }
});
