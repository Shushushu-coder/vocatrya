import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManagedAiCard from "@/components/settings/ManagedAiCard";
import type { ManagedAiOverview } from "@/actions/managedAi.actions";
import en from "@/i18n/messages/en.json";
import zhCN from "@/i18n/messages/zh-CN.json";

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));
const overview = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/actions/managedAi.actions", () => ({ getManagedAiOverview: overview.get }));

const EMPTY: ManagedAiOverview = {
  availability: "ENABLED",
  connection: null,
  entitlement: null,
  usage: null,
  models: [],
  errorCode: null,
};

const LAUNCHED: ManagedAiOverview = {
  ...EMPTY,
  connection: { id: "conn", displayName: "Vocatrya Managed AI", status: "CONNECTED", lastVerifiedAt: null },
  entitlement: {
    subscriptionStatus: "ACTIVE",
    planKey: "starter",
    planRevision: "plans-1",
    quotaPlanRevision: "plans-1",
    managedAiEnabled: true,
    allowedModels: ["vocatrya-fast"],
    periodStart: 1000,
    periodEnd: 2000,
    quotaLimitUnits: 100,
    reservedUnits: 0,
    committedUnits: 3,
    remainingUnits: 97,
  },
  usage: {
    subscriptionStatus: "ACTIVE",
    planKey: "starter",
    planRevision: "plans-1",
    quotaPlanRevision: "plans-1",
    periodStart: 1000,
    periodEnd: 2000,
    quotaLimitUnits: 100,
    reservedUnits: 0,
    committedUnits: 3,
    remainingUnits: 97,
  },
  models: [{ modelKey: "vocatrya-fast", displayName: "Fast", streaming: true, structuredOutput: true }],
};

function shows(overviewData: ManagedAiOverview) {
  overview.get.mockResolvedValue({ success: true, data: overviewData });
  render(<ManagedAiCard />);
}

describe("ManagedAiCard", () => {
  it("ships the Coming Soon copy in en and zh-CN", () => {
    const copy = (messages: typeof en) =>
      messages.settings as Record<string, unknown>;
    expect(copy(en).managedComingSoon).toBe("Coming Soon");
    expect(copy(zhCN).managedComingSoon).toBe("即将推出");
    for (const messages of [en, zhCN]) {
      for (const key of ["managedComingSoonHint", "aiAssignManagedComingSoon"]) {
        expect(copy(messages)[key]).toMatch(/\S/);
      }
    }
  });

  it("shows only Coming Soon while Managed AI is not launched", async () => {
    shows({ ...EMPTY, availability: "COMING_SOON" });
    expect(await screen.findByText("settings.managedComingSoon")).toBeInTheDocument();
    expect(screen.getByText("settings.managedComingSoonHint")).toBeInTheDocument();
    for (const misleading of [
      "settings.managedDescription",
      "settings.managedUnavailable",
      "settings.managedSubscription",
      "settings.managedPlan",
      "settings.managedQuotaUsed",
      "settings.managedModels",
      "settings.managedAssignHint",
    ]) {
      expect(screen.queryByText(misleading)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/MANAGED_/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(overview.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the live subscription, quota and models view once launched", async () => {
    shows(LAUNCHED);
    expect(await screen.findByText("Vocatrya Managed AI")).toBeInTheDocument();
    expect(screen.getByText("settings.managedSubscription")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("starter")).toBeInTheDocument();
    expect(screen.getByText("3 / 100")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
    expect(screen.getByText("settings.managedAssignHint")).toBeInTheDocument();
    expect(screen.queryByText("settings.managedComingSoon")).not.toBeInTheDocument();
  });

  it("reports a temporary Hosted failure after launch as unavailable, not as coming soon", async () => {
    shows({ ...EMPTY, errorCode: "MANAGED_RUNTIME_UNAVAILABLE" });
    expect(await screen.findByText("settings.managedUnavailable")).toBeInTheDocument();
    expect(screen.getByText(/MANAGED_RUNTIME_UNAVAILABLE/)).toBeInTheDocument();
    expect(screen.queryByText("settings.managedComingSoon")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button"));
    expect(overview.get).toHaveBeenCalledTimes(2);
  });
});
