// Internal execution endpoint boundary tests — real loopback HTTP server
// with a fake connection service. Verifies bearer auth, route scoping,
// body cap, payload validation, and the TEXT_ONLY permission gate. The
// request body is never logged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExecutionServer } from "./execute-server.js";

const TOKEN = "test-internal-token";

let server;
let port;

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

async function start(service) {
  const started = await startExecutionServer({ token: TOKEN, service });
  server = started.server;
  port = started.port;
  return `http://127.0.0.1:${port}`;
}

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  ticket: "t1",
  connectionId: "conn-1",
  model: "m1",
  prompt: "hello",
  permissionScope: "TEXT_ONLY",
};

describe("internal execution endpoint", () => {
  it("serves a valid TEXT_ONLY execution through the service", async () => {
    const executeText = vi.fn(async () => ({
      ok: true,
      text: "answer",
      provider: "OPENAI",
      backendKind: "CODEX_RUNTIME",
      model: "m1",
      connectionId: "conn-1",
      durationMs: 3,
    }));
    const base = await start({ executeText });
    const res = await post(base, "/internal/ai-connections/execute", VALID_BODY);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      text: "answer",
      connectionId: "conn-1",
    });
    expect(executeText).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket: "t1",
        connectionId: "conn-1",
        model: "m1",
        prompt: "hello",
      }),
    );
  });

  it("rejects requests without the bearer token", async () => {
    const executeText = vi.fn();
    const base = await start({ executeText });
    const res = await post(base, "/internal/ai-connections/execute", VALID_BODY, {
      authorization: "Bearer wrong",
    });
    expect(res.status).toBe(401);
    const noAuth = await fetch(`${base}/internal/ai-connections/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(noAuth.status).toBe(401);
    expect(executeText).not.toHaveBeenCalled();
  });

  it("rejects other paths, methods, and malformed payloads", async () => {
    const executeText = vi.fn();
    const base = await start({ executeText });
    expect(
      (await post(base, "/other", VALID_BODY)).status,
    ).toBe(404);
    const get = await fetch(`${base}/internal/ai-connections/execute`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(404);
    expect(
      (await post(base, "/internal/ai-connections/execute", "not-json")).status,
    ).toBe(400);
    for (const missing of ["ticket", "connectionId", "model", "prompt"]) {
      const body = { ...VALID_BODY };
      delete body[missing];
      expect(
        (await post(base, "/internal/ai-connections/execute", body)).status,
      ).toBe(400);
    }
    expect(executeText).not.toHaveBeenCalled();
  });

  it("rejects non-TEXT_ONLY permission scopes", async () => {
    const executeText = vi.fn();
    const base = await start({ executeText });
    const res = await post(base, "/internal/ai-connections/execute", {
      ...VALID_BODY,
      permissionScope: "USER_SELECTED_FILES_READ",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "PERMISSION_BOUNDARY_NOT_READY",
    });
    expect(executeText).not.toHaveBeenCalled();
  });

  it("caps the request body", async () => {
    const executeText = vi.fn();
    const base = await start({ executeText });
    const res = await fetch(`${base}/internal/ai-connections/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ ...VALID_BODY, prompt: "x".repeat(600 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(executeText).not.toHaveBeenCalled();
  });

  it("propagates service failure codes verbatim", async () => {
    const executeText = vi.fn(async () => ({
      ok: false,
      code: "CONNECTION_DISCONNECTED",
    }));
    const base = await start({ executeText });
    const res = await post(base, "/internal/ai-connections/execute", VALID_BODY);
    expect(await res.json()).toEqual({
      ok: false,
      code: "CONNECTION_DISCONNECTED",
    });
  });
});
