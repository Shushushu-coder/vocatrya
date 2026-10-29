// @vitest-environment node
/**
 * Local isolated closed-loop verification of the Managed AI product path
 * over the REAL wire. Every pre-existing spec drives
 * HostedManagedService.handle() in memory; this file is the first coverage
 * of the full chain in one pass:
 *
 *   safeStorage-backed session store → loopback session broker
 *   (desktop/main/hosted-session.js) → DesktopHostedSessionProvider →
 *   HostedManagedClient → real HTTP → createHostedServer (http.ts
 *   Node↔Fetch adapter) → HostedManagedService → HostedStore (file DB)
 *
 * plus the production env wiring (VOCATRYA_DEV_* gates, stubbed via
 * vi.stubEnv) and the real server actions, execution seams and prisma DB.
 *
 * The only synthetic piece is the upstream OpenAI-compatible fetch inside
 * ManagedGatewayRuntime — the same role fixtures give it on the service
 * side. This proves the desktop-side chain can talk to a hosted service
 * over real HTTP with real tokens. It is NOT evidence that the
 * managed.shucubed.xyz deployment or a real upstream gateway is reachable:
 * both remain BLOCKED on the real environment by design.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { PrismaClient } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const require = createRequire(import.meta.url);
const { createHostedSessionStore, startHostedSessionBroker } = require(
  "../desktop/main/hosted-session.js",
);

import { HostedStore } from "../services/managed-ai/src/store";
import { ModelCatalog } from "../services/managed-ai/src/catalog";
import {
  ManagedGatewayRuntime,
  VERIFIED_GATEWAY_CAPABILITIES,
} from "../services/managed-ai/src/gateway";
import { HostedManagedService } from "../services/managed-ai/src/service";
import { PlanAuthority } from "../services/managed-ai/src/plan";
import type { ManagedPlanConfig } from "../services/managed-ai/src/plan";
import { OperatorStore } from "../services/managed-ai/src/operator/store";
import { createHostedServer } from "../services/managed-ai/src/http";
import { DesktopHostedSessionProvider, HostedManagedClient } from "@/lib/ai/managed-client";
import { executeAIConnectionText } from "@/lib/ai/execution";
import {
  checkStreamingTurnReadiness,
  executeAIConnectionTextStream,
} from "@/lib/ai/streaming-execution";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import {
  assignManagedBusinessAiSource,
  disconnectManagedAiSession,
  getManagedAiOverview,
  redeemManagedAiSession,
} from "@/actions/managedAi.actions";

// ---------------------------------------------------------------------------
// prisma + auth seams: a real disposable SQLite DB, requireUser bound to the
// seeded account — the same shape every managed spec uses.
// ---------------------------------------------------------------------------
const seam = vi.hoisted(() => ({
  userId: "",
  prisma: null as PrismaClient | null,
}));

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const helpers = await import("./helpers/backupTestDb");
  const { url } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  seam.prisma = new PrismaClient({ datasources: { db: { url } } });
  return { default: seam.prisma, prisma: seam.prisma };
});

vi.mock("@/actions/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/actions/shared")>()),
  requireUser: async () => ({ id: seam.userId }),
}));

const prisma = () => seam.prisma!;

// ---------------------------------------------------------------------------
// Hosted side: file-backed HostedStore (durable ledger on disk, not memory),
// the real service and the real Node↔Fetch HTTP adapter on a loopback port.
// ---------------------------------------------------------------------------
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
      modelKey: "vocatrya-plus",
      displayName: "Plus",
      upstreamModelId: "vendor-plus",
      enabled: true,
      planRequirement: "pro",
      sortOrder: 1,
      mappingRevision: "mapping-1",
      maxInputTokens: 32000,
      maxOutputTokens: 8192,
      capabilities: { text: true, streaming: true, structuredOutput: true, tools: false },
    },
  ],
};

const PLANS: ManagedPlanConfig = {
  revision: "plans-1",
  plans: [
    {
      planKey: "starter",
      managedAiEnabled: true,
      allowedModels: ["vocatrya-fast"],
      periodQuotaUnits: 100,
      modelUsageUnits: { "vocatrya-fast": 1, "vocatrya-plus": 1 },
    },
    {
      planKey: "pro",
      managedAiEnabled: true,
      allowedModels: ["vocatrya-fast", "vocatrya-plus"],
      periodQuotaUnits: 100,
      modelUsageUnits: { "vocatrya-fast": 1, "vocatrya-plus": 1 },
    },
    {
      planKey: "tiny",
      managedAiEnabled: true,
      allowedModels: ["vocatrya-fast"],
      periodQuotaUnits: 1,
      modelUsageUnits: { "vocatrya-fast": 1 },
    },
  ],
};

let hostedDir: string;
let sessionDir: string;
let store: InstanceType<typeof HostedStore>;
let operatorDb: InstanceType<typeof DatabaseSync>;
let operator: InstanceType<typeof OperatorStore>;
let server: Server;
let brokerServer: Server;
let base: string;
let brokerUrl: string;
let sessionStore: {
  save(localUserId: string, token: string): void;
  read(localUserId: string): string | null;
  clear(localUserId: string): void;
};

// Controllable upstream: the only synthetic boundary in the chain.
let upstreamCalls: RequestInit[] = [];
let upstreamImpl: (init: RequestInit | undefined) => Promise<Response>;
const upstream: typeof fetch = async (_url, init) => {
  upstreamCalls.push(init ?? {});
  return upstreamImpl(init ?? undefined);
};

function sseUpstream(model: string, chunks: string[]): Response {
  const frames = [
    ...chunks.slice(0, -1).map((content) => ({
      model,
      choices: [{ delta: { content } }],
    })),
    {
      model,
      choices: [{ delta: { content: chunks.at(-1) }, finish_reason: "stop" }],
    },
    { model, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
  ];
  return new Response(
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

const defaultUpstream = async (init: RequestInit | undefined) => {
  const payload = JSON.parse(String(init?.body));
  if (payload.stream === true) return sseUpstream(payload.model, ["stream ", "chunk"]);
  return Response.json({
    model: payload.model,
    choices: [
      { message: { content: "managed reply" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  });
};

/** Mints a hosted session for a fresh hosted user, optionally subscribes it,
 *  and stores the token under the current local user in the OS-backed store —
 *  the same flow an operator provision + desktop receipt would take. */
function provision(hostedUserId: string, planKey?: string) {
  const token = store.issueSession(hostedUserId, Date.now() + 600_000);
  if (planKey) {
    store.setSubscription(hostedUserId, {
      planKey,
      status: "ACTIVE",
      periodStart: Date.now() - 1000,
      periodEnd: Date.now() + 600_000,
    });
  }
  sessionStore.save(seam.userId, token);
}

async function managedConnection() {
  return prisma().aIConnection.findFirstOrThrow({
    where: { userId: seam.userId, authType: "MANAGED" },
  });
}

const execInput = (over: Record<string, unknown> = {}) => ({
  userId: seam.userId,
  connectionId: "",
  model: "vocatrya-fast",
  prompt: "ping",
  operationId: `loop-${Math.random().toString(36).slice(2)}`,
  managedResource: {
    business: "MATCH_ANALYSIS",
    resourceKey: `loop:${Math.random().toString(36).slice(2)}`,
  },
  ...over,
});

beforeAll(async () => {
  const helpers = await import("./helpers/backupTestDb");
  seam.userId = await helpers.seedAccount(
    prisma(),
    "managed-loopback@example.com",
  );

  hostedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vocatrya-managed-hosted-"),
  );
  const hostedDbPath = path.join(hostedDir, "hosted.db");
  store = new HostedStore(hostedDbPath);
  operatorDb = new DatabaseSync(hostedDbPath);
  operator = new OperatorStore(operatorDb);

  const service = new HostedManagedService(
    store,
    new ModelCatalog(CATALOG, VERIFIED_GATEWAY_CAPABILITIES),
    new PlanAuthority(PLANS),
    new ManagedGatewayRuntime(
      {
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "SYNTHETIC_MANAGED_GATEWAY_SECRET_M2",
      },
      upstream,
    ),
  );
  server = createHostedServer(service);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  sessionDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vocatrya-managed-session-"),
  );
  // Same stub shape hosted-session.test.mjs uses: ciphertext != plaintext is
  // all the store contract needs; the real build uses Electron safeStorage.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from([...value].reverse().join("")),
    decryptString: (value: Buffer) =>
      [...value.toString()].reverse().join(""),
  };
  sessionStore = createHostedSessionStore({
    directory: sessionDir,
    safeStorage,
  });
  const broker = await startHostedSessionBroker({
    token: "internal-loopback-token",
    store: sessionStore,
  });
  brokerServer = broker.server;
  brokerUrl = broker.url;
});

beforeEach(async () => {
  upstreamCalls = [];
  upstreamImpl = defaultUpstream;
  await prisma().aIBusinessAssignment.deleteMany({
    where: { userId: seam.userId },
  });
  await prisma().aIConnection.deleteMany({
    where: { userId: seam.userId, authType: "MANAGED" },
  });
  sessionStore.clear(seam.userId);
  // The production wiring a packaged build would inject — the release
  // availability constant stays COMING_SOON; only the dev gates open the
  // loopback path, and only outside production.
  vi.stubEnv("VOCATRYA_DEV_MANAGED_AVAILABILITY", "ENABLED");
  vi.stubEnv("VOCATRYA_DEV_HOSTED_ENDPOINT", base);
  vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", brokerUrl);
  vi.stubEnv("VOCATRYA_DESKTOP_INTERNAL_TOKEN", "internal-loopback-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    brokerServer ? brokerServer.close(() => resolve()) : resolve(),
  );
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  store?.close();
  operatorDb?.close();
  await prisma().$disconnect();
  fs.rmSync(hostedDir, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

describe("Managed AI real-HTTP loopback closed loop", () => {
  it("fails closed until a hosted session exists, then runs the full product loop over real HTTP", async () => {
    const client = new HostedManagedClient();

    // No stored session: broker answers 401, the provider fails closed and
    // the settings surface reports the real error — never fabricated data.
    const before = await getManagedAiOverview();
    expect(before.data?.availability).toBe("ENABLED");
    expect(before.data?.errorCode).toBe("MANAGED_AUTH_REQUIRED");
    expect(before.data?.entitlement).toBeNull();
    await expect(client.entitlement(seam.userId)).rejects.toMatchObject({
      code: "MANAGED_AUTH_REQUIRED",
    });

    provision("hosted-main", "starter");

    const overview = await getManagedAiOverview();
    expect(overview.data?.entitlement).toMatchObject({
      planKey: "starter",
      quotaLimitUnits: 100,
      allowedModels: ["vocatrya-fast"],
    });
    // Assignable = catalog ∩ plan allow-list: the pro-only model is not shown.
    expect(overview.data?.models.map((m) => m.modelKey)).toEqual([
      "vocatrya-fast",
    ]);
    // Overview auto-bootstraps the system-provisioned connection once the
    // hosted session authenticates — the card shows it CONNECTED.
    expect(overview.data?.connection).toMatchObject({ status: "CONNECTED" });

    const assigned = await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    expect(assigned).toMatchObject({ success: true });
    const connection = await managedConnection();
    expect(connection).toMatchObject({
      provider: "VOCATRYA",
      backendKind: "MANAGED_GATEWAY",
      authType: "MANAGED",
      credentialRef: null,
      runtimeProfileRef: null,
      accountIdentity: null,
    });
    const resolution = await resolveBusinessAIConfig({
      userId: seam.userId,
      purpose: "MATCH_ANALYSIS",
    });
    expect(resolution).toMatchObject({
      status: "RESOLVED",
      connectionId: connection.id,
      model: "vocatrya-fast",
      provider: "VOCATRYA",
      backendKind: "MANAGED_GATEWAY",
    });

    // Text — over real HTTP, against the durable file-backed ledger.
    const text = await executeAIConnectionText(
      execInput({ connectionId: connection.id }),
    );
    expect(text).toMatchObject({
      text: "managed reply",
      provider: "VOCATRYA",
      backendKind: "MANAGED_GATEWAY",
      model: "vocatrya-fast",
      managedAiProvenance: {
        requestedModelKey: "vocatrya-fast",
        upstreamModelId: "vendor-v1",
        mappingRevision: "mapping-1",
      },
    });
    // The upstream saw the vendor model id and nothing about the local user.
    const upstreamBody = JSON.parse(String(upstreamCalls.at(-1)?.body));
    expect(upstreamBody.model).toBe("vendor-v1");
    expect(String(upstreamCalls.at(-1)?.body)).not.toContain(seam.userId);

    // Streaming — NDJSON deltas through the same real chain.
    const events: unknown[] = [];
    for await (const event of executeAIConnectionTextStream(
      execInput({ connectionId: connection.id }),
    )) {
      events.push(event);
    }
    expect(events).toMatchObject([
      { type: "text-delta", delta: "stream " },
      { type: "text-delta", delta: "chunk" },
      { type: "completed", model: "vocatrya-fast" },
    ]);

    // Structured — strict validation through the real seam.
    upstreamImpl = async (init) =>
      Response.json({
        model: JSON.parse(String(init?.body)).model,
        choices: [
          { message: { content: '{"name":"Ada"}' }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    const structured = await executeStructuredForAssignment({
      userId: seam.userId,
      purpose: "MATCH_ANALYSIS",
      prompt: "extract",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      schemaName: "probe",
      operationId: "loop-structured",
      managedResource: {
        business: "MATCH_ANALYSIS",
        resourceKey: "loop:structured-1",
      },
    });
    expect(structured).toMatchObject({
      status: "OK",
      value: { name: "Ada" },
      managedAiProvenance: { upstreamModelId: "vendor-v1" },
    });

    // The durable ledger charged exactly three committed units.
    const usage = await client.usage(seam.userId);
    expect(usage).toMatchObject({
      committedUnits: 3,
      reservedUnits: 0,
      remainingUnits: 97,
      quotaLimitUnits: 100,
    });
    const after = await getManagedAiOverview();
    expect(after.data?.connection?.status).toBe("CONNECTED");
    expect(after.data?.usage?.committedUnits).toBe(3);
  });

  it("enforces the subscription and plan allow-list at assignment write time", async () => {
    // No subscription at all — the catalog entry exists but there is no
    // entitlement, so the write refuses before saving anything.
    provision("hosted-nosub");
    await expect(
      assignManagedBusinessAiSource({
        purpose: "MATCH_ANALYSIS",
        modelKey: "vocatrya-fast",
      }),
    ).resolves.toMatchObject({ success: false, code: "NOT_ENTITLED" });
    expect(
      await prisma().aIBusinessAssignment.findFirst({
        where: { userId: seam.userId },
      }),
    ).toBeNull();

    // A model outside the plan allow-list refuses at write with the same
    // code admission would use — not saved-then-broken.
    provision("hosted-starter", "starter");
    await expect(
      assignManagedBusinessAiSource({
        purpose: "MATCH_ANALYSIS",
        modelKey: "vocatrya-plus",
      }),
    ).resolves.toMatchObject({ success: false, code: "MODEL_NOT_ALLOWED" });
    expect(
      await prisma().aIBusinessAssignment.findFirst({
        where: { userId: seam.userId },
      }),
    ).toBeNull();

    // The same model under a covering plan assigns cleanly.
    provision("hosted-pro", "pro");
    await expect(
      assignManagedBusinessAiSource({
        purpose: "MATCH_ANALYSIS",
        modelKey: "vocatrya-plus",
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it("refuses quota-exhausted invocations at admission with no upstream dispatch", async () => {
    provision("hosted-tiny", "tiny");
    await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    const connection = await managedConnection();

    await executeAIConnectionText(
      execInput({ connectionId: connection.id, operationId: "quota-1" }),
    );
    await expect(
      executeAIConnectionText(
        execInput({ connectionId: connection.id, operationId: "quota-2" }),
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    // The refusal happened inside admission — the upstream was never called.
    expect(upstreamCalls).toHaveLength(1);
    const usage = await new HostedManagedClient().usage(seam.userId);
    expect(usage).toMatchObject({ committedUnits: 1, remainingUnits: 0 });
  });

  it("replays durable retries without a second upstream call and conflicts on payload change", async () => {
    provision("hosted-replay", "starter");
    await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    const connection = await managedConnection();
    const input = execInput({
      connectionId: connection.id,
      operationId: "replay-op",
    });

    await executeAIConnectionText(input);
    await expect(executeAIConnectionText(input)).rejects.toMatchObject({
      code: "INVOCATION_REPLAYED",
      receipt: {
        executionState: "REPLAYED",
        status: "SUCCEEDED",
        invocationKey: "replay-op:0",
      },
    });
    expect(upstreamCalls).toHaveLength(1);
    await expect(
      executeAIConnectionText({ ...input, prompt: "different payload" }),
    ).rejects.toMatchObject({ code: "INVOCATION_CONFLICT" });
    const usage = await new HostedManagedClient().usage(seam.userId);
    expect(usage.committedUnits).toBe(1);
  });

  it("settles a lost upstream dispatch as UNKNOWN then commits it conservatively", async () => {
    provision("hosted-unknown", "starter");
    await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    const connection = await managedConnection();
    const client = new HostedManagedClient();

    upstreamImpl = async () => {
      throw new Error("socket reset mid-dispatch");
    };
    await expect(
      executeAIConnectionText(
        execInput({ connectionId: connection.id, operationId: "lost-op" }),
      ),
    ).rejects.toMatchObject({ name: "AIBusinessError" });

    // The reservation is still held as UNKNOWN — visible, not invented away.
    const pending = await client.usage(seam.userId);
    expect(pending).toMatchObject({ reservedUnits: 1, committedUnits: 0 });

    // The conservative reconciler charges UNKNOWN rows after the grace
    // window — quota is never silently returned on doubt.
    expect(store.reconcileStaleUnknown(Date.now(), 0)).toBe(1);
    const settled = await client.usage(seam.userId);
    expect(settled).toMatchObject({ reservedUnits: 0, committedUnits: 1 });
  });

  it("refuses new invocations while the kill switch is engaged; reads stay live", async () => {
    provision("hosted-kill", "starter");
    await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    const connection = await managedConnection();
    const client = new HostedManagedClient();

    operator.setRuntimeDisabled(
      true,
      { credentialId: "op-test", label: "test", tokenHash: "x" },
      "maintenance",
    );
    try {
      await expect(
        executeAIConnectionText(
          execInput({ connectionId: connection.id, operationId: "kill-op" }),
        ),
      ).rejects.toMatchObject({ code: "MANAGED_AI_DISABLED" });
      // Reads remain live — the card shows a real disabled state, not a
      // fabricated outage.
      expect((await client.entitlement(seam.userId)).planKey).toBe("starter");
      expect(upstreamCalls).toHaveLength(0);
    } finally {
      operator.setRuntimeDisabled(
        false,
        { credentialId: "op-test", label: "test", tokenHash: "x" },
        null,
      );
    }
    // Recovered: a new invocation admits again.
    await executeAIConnectionText(
      execInput({ connectionId: connection.id, operationId: "after-kill" }),
    );
  });

  it("keeps the release availability COMING_SOON unless the exact dev value lifts it", async () => {
    const { managedAiAvailability } = await import(
      "@/lib/ai/managed-availability"
    );
    // beforeEach stubbed ENABLED — prove the gate works, then the default.
    expect(managedAiAvailability()).toBe("ENABLED");
    for (const value of ["", "COMING_SOON", "enabled", "1", "true"]) {
      vi.stubEnv("VOCATRYA_DEV_MANAGED_AVAILABILITY", value);
      expect(managedAiAvailability()).toBe("COMING_SOON");
    }
    vi.stubEnv("VOCATRYA_DEV_MANAGED_AVAILABILITY", "ENABLED");
    expect(managedAiAvailability()).toBe("ENABLED");
  });

  it("keeps a newly redeemed session when an older request returns a delayed 401", async () => {
    const provider = new DesktopHostedSessionProvider();
    const old = "a".repeat(43);
    const fresh = "b".repeat(43);
    await provider.saveSession(seam.userId, old);
    const delayed: typeof fetch = async () => {
      await provider.saveSession(seam.userId, fresh);
      return new Response(JSON.stringify({ code: "MANAGED_AUTH_REQUIRED" }), { status: 401 });
    };
    await expect(new HostedManagedClient(provider, base, delayed).identity(seam.userId))
      .rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    expect(sessionStore.read(seam.userId)).toBe(fresh);
    await provider.clearSession(seam.userId, fresh);
    expect(sessionStore.read(seam.userId)).toBeNull();
  });

  it.each(["http", "network"])("fails explicit disconnect on %s deletion errors without changing connection status", async (failure) => {
    provision("hosted-disconnect-error", "starter");
    await getManagedAiOverview();
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") {
        if (failure === "network") throw new Error("synthetic broker outage");
        return new Response("{}", { status: 500 });
      }
      return realFetch(input, init);
    });
    try {
      expect((await disconnectManagedAiSession()).success).toBe(false);
      expect((await managedConnection()).status).toBe("CONNECTED");
      expect(sessionStore.read(seam.userId)).not.toBeNull();
    } finally { spy.mockRestore(); }
  });

  it("suppresses the development environment token after disconnect until redemption", async () => {
    vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", "");
    vi.stubEnv("VOCATRYA_DESKTOP_INTERNAL_TOKEN", "");
    vi.stubEnv("VOCATRYA_DEV_HOSTED_SESSION_TOKEN", "a".repeat(43));
    const provider = new DesktopHostedSessionProvider();
    const localId = "dev-disconnect-isolation";
    expect(await provider.tokenForLocalUser(localId)).toBe("a".repeat(43));
    await provider.clearSession(localId);
    expect(await provider.tokenForLocalUser(localId)).toBeNull();
    await provider.saveSession(localId, "b".repeat(43));
    await provider.clearSession(localId, "a".repeat(43));
    expect(await provider.tokenForLocalUser(localId)).toBe("b".repeat(43));
  });

  it("accepts an operator-provisioned dev session token only when the broker is not wired", async () => {
    const token = store.issueSession("hosted-dev", Date.now() + 600_000);
    store.setSubscription("hosted-dev", {
      planKey: "starter",
      status: "ACTIVE",
      periodStart: Date.now() - 1000,
      periodEnd: Date.now() + 600_000,
    });
    const client = new HostedManagedClient();
    // The dev channel never bypasses a configured broker: while broker env
    // vars exist the OS-backed store answers (and here holds no session).
    await expect(client.entitlement(seam.userId)).rejects.toMatchObject({
      code: "MANAGED_AUTH_REQUIRED",
    });
    vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", "");
    vi.stubEnv("VOCATRYA_DESKTOP_INTERNAL_TOKEN", "");
    await expect(client.entitlement(seam.userId)).rejects.toMatchObject({
      code: "MANAGED_AUTH_REQUIRED",
    });
    vi.stubEnv("VOCATRYA_DEV_HOSTED_SESSION_TOKEN", token);
    expect((await client.entitlement(seam.userId)).planKey).toBe("starter");
    // A malformed token fails closed, never reaching the wire.
    vi.stubEnv("VOCATRYA_DEV_HOSTED_SESSION_TOKEN", "short");
    await expect(client.entitlement(seam.userId)).rejects.toMatchObject({
      code: "MANAGED_AUTH_REQUIRED",
    });
  });

  it("redeems a pasted hosted session, disconnects, and recovers after revocation", async () => {
    // No stored session — the user-facing surface asks for a credential.
    expect((await getManagedAiOverview()).data?.errorCode).toBe(
      "MANAGED_AUTH_REQUIRED",
    );
    // Malformed paste fails closed without touching the store.
    await expect(
      redeemManagedAiSession({ token: "not-a-real-token" }),
    ).resolves.toMatchObject({ success: false, code: "MANAGED_AUTH_REQUIRED" });
    expect(sessionStore.read(seam.userId)).toBeNull();

    // A hosted-issued token (operator-provisioned for a subscribed user)
    // the user pastes into the card. The action validates it against the
    // authority BEFORE persisting — the broker PUT is what lands here.
    const token = store.issueSession("hosted-redeem", Date.now() + 600_000);
    store.setSubscription("hosted-redeem", {
      planKey: "starter",
      status: "ACTIVE",
      periodStart: Date.now() - 1000,
      periodEnd: Date.now() + 600_000,
    });
    const redeemed = await redeemManagedAiSession({ token });
    expect(redeemed).toMatchObject({
      success: true,
      data: { hostedUserId: "hosted-redeem" },
    });
    expect(sessionStore.read(seam.userId)).toBe(token);
    expect(await managedConnection()).toMatchObject({ status: "CONNECTED" });

    // A valid-format but unknown token is refused by the authority and the
    // stored session is NOT clobbered — the probe never writes.
    const rejected = await redeemManagedAiSession({ token: "z".repeat(43) });
    expect(rejected).toMatchObject({
      success: false,
      code: "MANAGED_AUTH_REQUIRED",
    });
    expect(sessionStore.read(seam.userId)).toBe(token);

    // The full product loop still runs on the redeemed session.
    const overview = await getManagedAiOverview();
    expect(overview.data?.hostedUserId).toBe("hosted-redeem");
    expect(overview.data?.models.map((m) => m.modelKey)).toEqual([
      "vocatrya-fast",
    ]);
    await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    const connection = await managedConnection();
    await executeAIConnectionText(
      execInput({ connectionId: connection.id, operationId: "redeem-op" }),
    );
    expect(
      (await new HostedManagedClient().usage(seam.userId)).committedUnits,
    ).toBe(1);

    // Revocation server-side: the next authority read gets a real 401, the
    // provider drops the stored token, the connection stops claiming
    // CONNECTED, and the surface reports re-auth.
    store.revokeSession(token);
    const revoked = await getManagedAiOverview();
    expect(revoked.data?.errorCode).toBe("MANAGED_AUTH_REQUIRED");
    expect(sessionStore.read(seam.userId)).toBeNull();
    expect(
      (await managedConnection()).status,
    ).toBe("REAUTH_REQUIRED");

    // Recovery: redeem a fresh hosted-issued token for the same account —
    // the connection comes back CONNECTED with live reads.
    const fresh = store.issueSession("hosted-redeem", Date.now() + 600_000);
    await expect(
      redeemManagedAiSession({ token: fresh }),
    ).resolves.toMatchObject({
      success: true,
      data: { hostedUserId: "hosted-redeem" },
    });
    const recovered = await getManagedAiOverview();
    expect(recovered.data?.connection?.status).toBe("CONNECTED");
    expect(recovered.data?.entitlement?.planKey).toBe("starter");

    // Disconnect: the stored credential is dropped and the connection is
    // marked DISCONNECTED — the card goes back to the redeem prompt.
    await expect(disconnectManagedAiSession()).resolves.toMatchObject({
      success: true,
    });
    expect(sessionStore.read(seam.userId)).toBeNull();
    expect((await managedConnection()).status).toBe("DISCONNECTED");
    expect((await getManagedAiOverview()).data?.errorCode).toBe(
      "MANAGED_AUTH_REQUIRED",
    );
  });

  it("runs concurrent invocations through admission without ledger corruption", async () => {
    provision("hosted-concurrent", "pro");
    await assignManagedBusinessAiSource({
      purpose: "MATCH_ANALYSIS",
      modelKey: "vocatrya-fast",
    });
    const connection = await managedConnection();
    // Six distinct operation identities in flight at once — admission is
    // transactional, every one commits exactly once.
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        executeAIConnectionText(
          execInput({
            connectionId: connection.id,
            operationId: `conc-${index}`,
          }),
        ),
      ),
    );
    expect(results).toHaveLength(6);
    expect(upstreamCalls).toHaveLength(6);
    const usage = await new HostedManagedClient().usage(seam.userId);
    expect(usage).toMatchObject({ committedUnits: 6, reservedUnits: 0 });
  });

  it("turn readiness refuses a managed model that cannot emit structured decisions", async () => {
    // A second catalog revision where the model streams but lacks the
    // structured-output capability a managed turn's decision step needs.
    const variant = new HostedManagedService(
      store,
      new ModelCatalog(
        {
          ...CATALOG,
          models: CATALOG.models.map((m) => ({
            ...m,
            capabilities: { ...m.capabilities, structuredOutput: false },
          })),
        },
        VERIFIED_GATEWAY_CAPABILITIES,
      ),
      new PlanAuthority(PLANS),
      new ManagedGatewayRuntime(
        { baseUrl: "https://upstream.invalid/v1", apiKey: "SYNTHETIC_MANAGED_GATEWAY_SECRET_M2" },
        upstream,
      ),
    );
    const variantServer = createHostedServer(variant);
    await new Promise<void>((resolve) =>
      variantServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const variantBase = `http://127.0.0.1:${(variantServer.address() as AddressInfo).port}`;
      const variantClient = new HostedManagedClient(undefined, variantBase);
      provision("hosted-readiness", "starter");
      await assignManagedBusinessAiSource({
        purpose: "MATCH_ANALYSIS",
        modelKey: "vocatrya-fast",
      });
      const connection = await managedConnection();
      await expect(
        checkStreamingTurnReadiness({
          userId: seam.userId,
          connection,
          model: "vocatrya-fast",
          deps: { managedClient: variantClient },
        }),
      ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    } finally {
      await new Promise<void>((resolve) =>
        variantServer.close(() => resolve()),
      );
    }
  });
});
