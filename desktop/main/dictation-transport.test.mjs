import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { startCredentialBroker } = require("./credential-broker.js");
const { createDictationTransport } = require("./dictation-transport.js");
const token = "synthetic-internal-token";
const target = "https://api.openai.com/v1/audio/transcriptions";

async function run(fetchImpl, test) {
  const broker = await startCredentialBroker({ token, dictationTransport: createDictationTransport(fetchImpl) });
  const request = (destination = target, authorization = `Bearer ${token}`) => fetch(`${broker.url}/dictation/request`, {
    method: "POST", headers: { authorization, "x-dictation-target": destination,
      "x-dictation-api-key": "synthetic-provider-key", "content-type": "application/json" }, body: "{}",
  });
  try { await test(request, broker.url); }
  finally { await new Promise(resolve => broker.server.close(resolve)); }
}

describe("desktop dictation network transport", () => {
  it("authenticates before dispatch and rejects destinations outside the allowlist", async () => {
    const upstream = vi.fn();
    await run(upstream, async request => {
      expect((await request(target, "Bearer wrong")).status).toBe(401);
      for (const url of ["http://127.0.0.1:1234", `${target}?key=secret`, `${target}/extra`, "https://api.openai.com.evil/v1/audio/transcriptions"]) {
        expect((await request(url)).status).toBe(400);
      }
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  it("passes the provider credential only to the fixed upstream and preserves errors", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 }));
    await run(upstream, async request => {
      const response = await request();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "invalid_api_key" } });
      expect(upstream).toHaveBeenCalledWith(target, expect.objectContaining({
        redirect: "error", body: Buffer.from("{}"),
        headers: { "content-type": "application/json", authorization: "Bearer synthetic-provider-key" },
      }));
      expect(JSON.stringify(upstream.mock.calls)).not.toContain(token);
    });
  });

  it("cancels the upstream when the backend disconnects", async () => {
    let signal;
    const upstream = vi.fn(async (_url, init) => {
      signal = init.signal;
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    await run(upstream, async (_request, url) => {
      const controller = new AbortController();
      const pending = fetch(`${url}/dictation/request`, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "x-dictation-target": target,
        "x-dictation-api-key": "synthetic", "content-type": "application/json",
      }, body: "{}", signal: controller.signal }).catch(() => {});
      await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
    });
  });

  it("does not echo unexpected network failure details", async () => {
    await run(async () => { throw new Error("synthetic secret"); }, async request => {
      const response = await request();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ success: false, code: "DICTATION_NETWORK" });
    });
  });
});
