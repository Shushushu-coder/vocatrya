import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManagedRechargeCard from "@/components/settings/ManagedRechargeCard";
import type { ManagedAiOverview } from "@/actions/managedAi.actions";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
  }),
}));
const actions = vi.hoisted(() => ({ get: vi.fn(), redeem: vi.fn() }));
vi.mock("@/actions/managedAi.actions", () => ({
  getManagedAiOverview: actions.get,
  redeemManagedAiSession: actions.redeem,
}));

const EMPTY: ManagedAiOverview = {
  availability: "ENABLED",
  connection: null,
  entitlement: null,
  usage: null,
  models: [],
  hostedUserId: null,
  errorCode: null,
};

const CONNECTED: ManagedAiOverview = {
  ...EMPTY,
  connection: {
    id: "conn",
    displayName: "Vocatrya Managed AI",
    status: "CONNECTED",
    lastVerifiedAt: null,
  },
  hostedUserId: "hosted-beta",
  entitlement: {
    subscriptionStatus: "ACTIVE",
    planKey: "beta",
    planRevision: "plans-1",
    quotaPlanRevision: "plans-1",
    managedAiEnabled: true,
    allowedModels: ["deepseek-flash"],
    periodStart: 1000,
    periodEnd: 2000,
    quotaLimitUnits: 1000,
    reservedUnits: 0,
    committedUnits: 4,
    remainingUnits: 996,
  },
  usage: {
    subscriptionStatus: "ACTIVE",
    planKey: "beta",
    planRevision: "plans-1",
    quotaPlanRevision: "plans-1",
    periodStart: 1000,
    periodEnd: 2000,
    quotaLimitUnits: 1000,
    reservedUnits: 0,
    committedUnits: 4,
    remainingUnits: 996,
  },
};

function shows(overviewData: ManagedAiOverview) {
  actions.get.mockResolvedValue({ success: true, data: overviewData });
  render(<ManagedRechargeCard />);
}

describe("ManagedRechargeCard", () => {
  it("shows only Coming Soon while Managed AI is not launched", async () => {
    shows({ ...EMPTY, availability: "COMING_SOON" });
    expect(
      await screen.findByText("settings.managedComingSoon"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.managedComingSoonHint"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByText("settings.managedRechargeNoKeyHint"),
    ).not.toBeInTheDocument();
  });

  it("offers the key entry and the customer-service note while disconnected", async () => {
    shows({ ...EMPTY, errorCode: "MANAGED_AUTH_REQUIRED" });
    expect(
      await screen.findByText("settings.managedUnavailable"),
    ).toBeInTheDocument();
    const input = screen.getByPlaceholderText(
      "settings.managedRechargeKeyPlaceholder",
    );
    expect(input).toBeInTheDocument();
    expect(
      screen.getByText("settings.managedRechargeNoKeyHint"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("settings.managedRechargeConnectedHint"),
    ).not.toBeInTheDocument();
  });

  it("redeems the pasted key through the managed session action", async () => {
    actions.redeem.mockResolvedValue({ success: true });
    shows(EMPTY);
    const input = await screen.findByPlaceholderText(
      "settings.managedRechargeKeyPlaceholder",
    );
    const token = "a".repeat(43);
    await userEvent.setup().type(input, token);
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "settings.managedRechargeSubmit" }),
      );
    expect(actions.redeem).toHaveBeenCalledWith({ token });
    // Successful redemption refreshes the overview for the new state.
    expect(actions.get).toHaveBeenCalledTimes(2);
  });

  it("surfaces the managed error code when redemption is rejected", async () => {
    actions.redeem.mockResolvedValue({
      success: false,
      code: "MANAGED_AUTH_REQUIRED",
    });
    shows(EMPTY);
    const input = await screen.findByPlaceholderText(
      "settings.managedRechargeKeyPlaceholder",
    );
    await userEvent.setup().type(input, "a".repeat(43));
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "settings.managedRechargeSubmit" }),
      );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "MANAGED_AUTH_REQUIRED",
    );
  });

  it("keeps the key entry available for renewal while connected", async () => {
    shows(CONNECTED);
    expect(await screen.findByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("hosted-beta")).toBeInTheDocument();
    expect(screen.getByText("4 / 1000")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("settings.managedRechargeKeyPlaceholder"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.managedRechargeConnectedHint"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("settings.managedRechargeNoKeyHint"),
    ).toBeInTheDocument();
  });
});
