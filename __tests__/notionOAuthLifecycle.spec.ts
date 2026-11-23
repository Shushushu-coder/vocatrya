// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { sealApiKeySecret } from "@/lib/ai/credential-store";
import { hashPendingState, setNotionOAuthFetch } from "@/lib/extensions/notion/oauth";
import { disconnectNotion, getNotionExtensionState, handleNotionOAuthCallback, resolveNotionAccessToken } from "@/lib/extensions/notion/service";

process.env.ENCRYPTION_KEY = "isolated-notion-lifecycle-test";

async function fixture() {
  const sealed = await sealApiKeySecret(JSON.stringify({ v: 1, state: "flow-state", codeVerifier: "test-verifier", redirectUri: "http://127.0.0.1:43880/extensions/notion/oauth/callback", appOrigin: "http://127.0.0.1:3737", expiresAt: Date.now() + 60000 }));
  const row: Record<string, unknown> = { userId: "oauth-test", status: "DISCONNECTED", oauthClientId: "test-client", pendingStateHash: hashPendingState("flow-state"), pendingCipher: sealed.encryptedKey, pendingIv: sealed.iv, encryptedCredential: null, credentialIv: null, connectedAt: null, lastVerifiedAt: null };
  const matches = (where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => row[key] === value);
  const db = { notionConnection: {
    findUnique: vi.fn(async () => structuredClone(row)),
    findFirst: vi.fn(async ({ where }) => matches(where) ? structuredClone(row) : null),
    updateMany: vi.fn(async ({ where, data }) => { if (!matches(where)) return { count: 0 }; Object.assign(row, data); return { count: 1 }; }),
    upsert: vi.fn(async ({ update }) => { Object.assign(row, update); return structuredClone(row); }),
  } };
  return { row, db };
}

function tokenExchangeGate() {
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  setNotionOAuthFetch(async (input) => {
    const url = String(input);
    if (url.includes("oauth-protected-resource")) return Response.json({ authorization_servers: ["https://mcp.notion.com"] });
    if (url.includes("well-known")) return Response.json({ authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://mcp.notion.com/token" });
    if (url.endsWith("/token")) { arrived(); await waiting; return Response.json({ access_token: "synthetic-access", expires_in: 3600 }); }
    throw new Error("Unexpected URL");
  });
  return { release, reached };
}

describe("Notion OAuth lifecycle races", () => {
  it("clears an expired flow so a disconnected account can reconnect", async () => {
    const { row, db } = await fixture();
    const sealed = await sealApiKeySecret(JSON.stringify({ v: 1, expiresAt: Date.now() - 1000 }));
    Object.assign(row, { pendingCipher: sealed.encryptedKey, pendingIv: sealed.iv });
    expect((await getNotionExtensionState("oauth-test", { db: db as never })).status).toBe("DISCONNECTED");
    expect(row.pendingCipher).toBeNull();
    expect(row.pendingStateHash).toBeNull();
  });

  it("keeps an active flow waiting for authorization", async () => {
    const { row, db } = await fixture();
    expect((await getNotionExtensionState("oauth-test", { db: db as never })).status).toBe("CONNECTING");
    expect(row.pendingCipher).not.toBeNull();
    expect(db.notionConnection.updateMany).not.toHaveBeenCalled();
  });

  it("does not clear a newer flow while cleaning an abandoned flow", async () => {
    const { row, db } = await fixture();
    row.pendingCipher = "unreadable-old-flow";
    const update = db.notionConnection.updateMany.getMockImplementation()!;
    db.notionConnection.updateMany.mockImplementationOnce(async (args) => {
      row.pendingCipher = "new-flow";
      row.pendingStateHash = "new-state";
      return update(args);
    });
    expect((await getNotionExtensionState("oauth-test", { db: db as never })).status).toBe("CONNECTING");
    expect(row.pendingCipher).toBe("new-flow");
    expect(row.pendingStateHash).toBe("new-state");
  });

  it("does not restore credentials when disconnect occurs during code exchange", async () => {
    const { row, db } = await fixture();
    const gate = tokenExchangeGate();
    const callback = handleNotionOAuthCallback({ code: "test-code", state: "flow-state" }, { db: db as never });
    await gate.reached;
    await disconnectNotion("oauth-test", { db: db as never });
    gate.release();
    expect((await callback).redirectUrl).toContain("STATE_MISMATCH");
    expect(row.status).toBe("DISCONNECTED");
    expect(row.encryptedCredential).toBeNull();
    expect(row.pendingStateHash).toBeNull();
  });

  it("does not consume a newer authorization flow when an old callback finishes", async () => {
    const { row, db } = await fixture();
    const gate = tokenExchangeGate();
    const callback = handleNotionOAuthCallback({ code: "test-code", state: "flow-state" }, { db: db as never });
    await gate.reached;
    row.pendingStateHash = "new-flow";
    row.pendingCipher = "new-sealed-flow";
    gate.release();
    expect((await callback).redirectUrl).toContain("STATE_MISMATCH");
    expect(row.pendingStateHash).toBe("new-flow");
    expect(row.encryptedCredential).toBeNull();
  });

  it("does not reseal a refreshed grant after disconnect", async () => {
    const { row, db } = await fixture();
    const sealed = await sealApiKeySecret(JSON.stringify({ v: 1, accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1, clientId: "test-client" }));
    Object.assign(row, { status: "CONNECTED", encryptedCredential: sealed.encryptedKey, credentialIv: sealed.iv });
    const gate = tokenExchangeGate();
    const refresh = resolveNotionAccessToken("oauth-test", { db: db as never });
    const rejected = expect(refresh).rejects.toMatchObject({ code: "NOTION_NOT_CONNECTED" });
    await gate.reached;
    await disconnectNotion("oauth-test", { db: db as never });
    gate.release();
    await rejected;
    expect(row.status).toBe("DISCONNECTED");
    expect(row.encryptedCredential).toBeNull();
  });
});
