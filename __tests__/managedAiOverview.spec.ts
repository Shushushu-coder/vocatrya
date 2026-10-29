// @vitest-environment node
/**
 * Managed AI settings surface — entitlement/usage client reads plus the
 * getManagedAiOverview server action assembly.
 *
 * The client tests run against the real in-memory HostedManagedService so
 * the DTO contract is exercised over the actual wire path, not a stub.
 */
import { HostedStore } from "../services/managed-ai/src/store";
import { ModelCatalog } from "../services/managed-ai/src/catalog";
import {
  ManagedGatewayRuntime,
  VERIFIED_GATEWAY_CAPABILITIES,
} from "../services/managed-ai/src/gateway";
import { HostedManagedService } from "../services/managed-ai/src/service";
import { PlanAuthority } from "../services/managed-ai/src/plan";
import type { ManagedEntitlement } from "@/lib/ai/managed-client";
// The action tests stub HostedManagedClient module-wide — protocol tests
// pull the real class through importActual.
const { HostedManagedClient } = await vi.importActual<
  typeof import("@/lib/ai/managed-client")
>("@/lib/ai/managed-client");

const USER_ID = "local-a";

const CATALOG = {
  revision: "catalog-1",
  managedAiEnabled: true,
  defaultModelKey: "vocatrya-fast",
  models: [
    {
      modelKey: "vocatrya-fast",
      displayName: "Fast",
      upstreamModelId: "vendor-v1",
      enabled: true,
      planRequirement: null,
      sortOrder: 0,
      mappingRevision: "mapping-1",
      maxInputTokens: 32000,
      maxOutputTokens: 4096,
      capabilities: { text: true, streaming: true, structuredOutput: true, tools: false },
    },
    {
      modelKey: "vocatrya-deep",
      displayName: "Deep",
      upstreamModelId: "vendor-v2",
      enabled: false,
      planRequirement: null,
      sortOrder: 1,
      mappingRevision: "mapping-1",
      maxInputTokens: 32000,
      maxOutputTokens: 4096,
      capabilities: { text: true, streaming: false, structuredOutput: true, tools: false },
    },
  ],
};

function hosted() {
  const store = new HostedStore(":memory:");
  const token = store.issueSession("hosted-a", Date.now() + 60000);
  store.setSubscription("hosted-a", {
    planKey: "starter",
    status: "ACTIVE",
    periodStart: Date.now() - 1000,
    periodEnd: Date.now() + 60000,
  });
  const plans = new PlanAuthority({
    revision: "plans-1",
    plans: [
      {
        planKey: "starter",
        managedAiEnabled: true,
        allowedModels: ["vocatrya-fast"],
        periodQuotaUnits: 100,
        modelUsageUnits: { "vocatrya-fast": 1 },
      },
    ],
  });
  const service = new HostedManagedService(
    store,
    new ModelCatalog(CATALOG, VERIFIED_GATEWAY_CAPABILITIES),
    plans,
    new ManagedGatewayRuntime(
      { baseUrl: "https://gateway.example/v1", apiKey: "SYNTHETIC" },
      async () =>
        Response.json({
          model: "vendor-v1",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
    ),
  );
  const client = new HostedManagedClient(
    { tokenForLocalUser: async (id) => (id === USER_ID ? token : null) },
    "https://hosted.example",
    async (url, init) => service.handle(new Request(String(url), init)),
  );
  return { client, store };
}

describe("HostedManagedClient entitlement/usage", () => {
  it("reads the live entitlement DTO", async () => {
    const { client, store } = hosted();
    try {
      const dto = await client.entitlement(USER_ID);
      expect(dto.subscriptionStatus).toBe("ACTIVE");
      expect(dto.planKey).toBe("starter");
      expect(dto.managedAiEnabled).toBe(true);
      expect(dto.allowedModels).toContain("vocatrya-fast");
      expect(dto.quotaLimitUnits).toBe(100);
      expect(dto.committedUnits).toBe(0);
      expect(dto.remainingUnits).toBe(100);
    } finally {
      store.close();
    }
  });

  it("reads the live usage summary and reflects committed quota", async () => {
    const { client, store } = hosted();
    try {
      const bound = await client.bind(USER_ID, {
        modelKey: "vocatrya-fast",
        business: "TEXT_EXECUTION",
        resourceKey: "op-usage-1",
      });
      await client.generateText(USER_ID, {
        bindingId: bound.managedBindingId,
        modelKey: "vocatrya-fast",
        prompt: "hi",
        operationId: "op-usage-1",
        invocationKey: "op-usage-1:0",
        attemptIndex: 0,
      });
      const usage = await client.usage(USER_ID);
      expect(usage.subscriptionStatus).toBe("ACTIVE");
      expect(usage.committedUnits).toBe(1);
      expect(usage.remainingUnits).toBe(99);
      // The usage summary carries no entitlement-only fields.
      expect((usage as unknown as Record<string, unknown>).allowedModels).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("fails MANAGED_AUTH_REQUIRED without a hosted session", async () => {
    const client = new HostedManagedClient({
      tokenForLocalUser: async () => null,
    });
    await expect(client.entitlement(USER_ID)).rejects.toMatchObject({
      code: "MANAGED_AUTH_REQUIRED",
    });
    await expect(client.usage(USER_ID)).rejects.toMatchObject({
      code: "MANAGED_AUTH_REQUIRED",
    });
  });

  it("fails GATEWAY_RESPONSE on a malformed entitlement body", async () => {
    const client = new HostedManagedClient(
      { tokenForLocalUser: async () => "a".repeat(43) },
      "https://hosted.example",
      async () => Response.json({ planKey: 42 }),
    );
    await expect(client.entitlement(USER_ID)).rejects.toMatchObject({
      code: "GATEWAY_RESPONSE",
    });
  });
});

// Action-level assembly: a stubbed client class lets us observe partial
// Hosted failures surfacing as stable codes while real reads render.
const stub = vi.hoisted(() => ({
  identity: vi.fn(),
  entitlement: vi.fn(),
  usage: vi.fn(),
  catalog: vi.fn(),
}));
const db = vi.hoisted(() => ({
  aIConnection: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findUnique: vi.fn(),
  },
}));
vi.mock("@/lib/ai/managed-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/managed-client")>();
  return {
    ...actual,
    HostedManagedClient: vi.fn().mockImplementation(() => stub),
  };
});
vi.mock("@/actions/shared", () => ({
  requireUser: async () => ({ id: USER_ID }),
}));
vi.mock("@/lib/db", () => ({ default: db }));
// The release constant is COMING_SOON; the action tests flip it explicitly so
// both the launched and the not-launched behavior are exercised.
const availability = vi.hoisted(() => ({ current: "ENABLED" as "ENABLED" | "COMING_SOON" }));
vi.mock("@/lib/ai/managed-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/managed-availability")>()),
  managedAiAvailability: () => availability.current,
}));

const { getManagedAiOverview, assignManagedBusinessAiSource } = await import("@/actions/managedAi.actions");
const { ManagedError } = await import("@/lib/ai/managed-contract");
const mockedModule = await import("@/lib/ai/managed-client");

describe("getManagedAiOverview", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    availability.current = "ENABLED";
    // resetAllMocks clears the constructor implementation — re-attach it.
    vi.mocked(mockedModule.HostedManagedClient).mockImplementation(
      function () {
        return stub as object as InstanceType<
          typeof mockedModule.HostedManagedClient
        >;
      },
    );
    stub.identity.mockResolvedValue("hosted-a");
    stub.entitlement.mockResolvedValue({
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
    } satisfies ManagedEntitlement);
    stub.usage.mockResolvedValue({
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
    });
    stub.catalog.mockResolvedValue({
      revision: "catalog-1",
      models: [
        {
          modelKey: "vocatrya-fast",
          displayName: "Fast",
          enabled: true,
          available: true,
          capabilities: { text: true, streaming: true, structuredOutput: true, tools: false },
        },
        {
          modelKey: "vocatrya-off",
          displayName: "Off",
          enabled: false,
          available: true,
          capabilities: { text: true, streaming: true, structuredOutput: true, tools: false },
        },
      ],
    });
    const managedRow = {
      id: "conn-managed",
      userId: USER_ID,
      provider: "VOCATRYA",
      backendKind: "MANAGED_GATEWAY",
      authType: "MANAGED",
      displayName: "Vocatrya Managed AI",
      status: "CONNECTED",
      credentialRef: null,
      runtimeProfileRef: null,
      accountIdentity: null,
      lastVerifiedAt: new Date(0),
    };
    db.aIConnection.findFirst.mockResolvedValue(managedRow);
    db.aIConnection.findUnique.mockResolvedValue(managedRow);
    db.aIConnection.update.mockResolvedValue(managedRow);
    db.aIConnection.create.mockResolvedValue(managedRow);
  });

  it("renders real entitlement + usage + catalog, filtering disabled models", async () => {
    const result = await getManagedAiOverview();
    expect(result.success).toBe(true);
    const data = result.data!;
    expect(data.availability).toBe("ENABLED");
    expect(data.connection).toMatchObject({
      displayName: "Vocatrya Managed AI",
      status: "CONNECTED",
    });
    expect(data.entitlement).toMatchObject({
      subscriptionStatus: "ACTIVE",
      planKey: "starter",
      remainingUnits: 97,
    });
    expect(data.usage?.committedUnits).toBe(3);
    expect(data.models).toEqual([
      expect.objectContaining({ modelKey: "vocatrya-fast" }),
    ]);
    expect(data.errorCode).toBeNull();
    // The platform never sees the local user id — the session provider
    // issued the token for it, and identity() confirmed the mapping.
    expect(stub.identity).toHaveBeenCalledWith(USER_ID);
  });

  it("reports a stable MANAGED_* code when a Hosted read fails", async () => {
    stub.usage.mockRejectedValue(new ManagedError("MANAGED_RUNTIME_UNAVAILABLE"));
    const result = await getManagedAiOverview();
    expect(result.success).toBe(true);
    expect(result.data?.usage).toBeNull();
    expect(result.data?.errorCode).toBe("MANAGED_RUNTIME_UNAVAILABLE");
    expect(result.data?.entitlement?.planKey).toBe("starter");
  });

  it("keeps an enabled-but-unreachable Hosted distinct from coming soon", async () => {
    stub.identity.mockRejectedValue(new ManagedError("MANAGED_RUNTIME_UNAVAILABLE"));
    const result = await getManagedAiOverview();
    expect(result.data).toEqual({
      availability: "ENABLED",
      connection: null,
      entitlement: null,
      usage: null,
      models: [],
      hostedUserId: null,
      errorCode: "MANAGED_RUNTIME_UNAVAILABLE",
    });
    expect(db.aIConnection.create).not.toHaveBeenCalled();
  });

  it("still reports the Hosted auth failure when assigning after launch", async () => {
    stub.identity.mockRejectedValue(new ManagedError("MANAGED_AUTH_REQUIRED"));
    const result = await assignManagedBusinessAiSource({ purpose: "GLOBAL_DEFAULT", modelKey: "vocatrya-fast" });
    expect(result).toMatchObject({ success: false, code: "MANAGED_AUTH_REQUIRED" });
    expect(db.aIConnection.create).not.toHaveBeenCalled();
  });

  describe("while Managed AI is coming soon", () => {
    beforeEach(() => {
      availability.current = "COMING_SOON";
    });

    function expectNoManagedSideEffects() {
      expect(mockedModule.HostedManagedClient).not.toHaveBeenCalled();
      for (const fn of Object.values(stub)) expect(fn).not.toHaveBeenCalled();
      for (const fn of Object.values(db.aIConnection)) expect(fn).not.toHaveBeenCalled();
    }

    it("returns an empty COMING_SOON overview with no Hosted request and no connection row", async () => {
      const result = await getManagedAiOverview();
      expect(result).toEqual({
        success: true,
        data: {
          availability: "COMING_SOON",
          connection: null,
          entitlement: null,
          usage: null,
          models: [],
          hostedUserId: null,
          errorCode: null,
        },
      });
      expectNoManagedSideEffects();
    });

    it("does not retry the Hosted bootstrap on every settings open", async () => {
      for (let open = 0; open < 3; open += 1) await getManagedAiOverview();
      expectNoManagedSideEffects();
    });

    it("refuses a Managed business assignment before any Hosted call or connection write", async () => {
      const result = await assignManagedBusinessAiSource({ purpose: "GLOBAL_DEFAULT", modelKey: "vocatrya-fast" });
      expect(result).toMatchObject({ success: false, code: "MANAGED_NOT_LAUNCHED" });
      expectNoManagedSideEffects();
    });
  });
});

describe("beta.2 release availability", () => {
  it("is COMING_SOON: ordinary users get no Managed AI subscription or inference", async () => {
    const release = await vi.importActual<typeof import("@/lib/ai/managed-availability")>("@/lib/ai/managed-availability");
    expect(release.managedAiAvailability()).toBe("COMING_SOON");
  });
});
