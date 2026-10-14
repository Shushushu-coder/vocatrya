import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
const require = createRequire(import.meta.url);
const { startCredentialBroker } = require("./credential-broker.js");

const token = "internal-credential-test";
const SECRET = "sk-synthetic-test-key-0001";

// safeStorage stand-in: encryptString tags bytes with the owning "OS user";
// decryptString only succeeds for the same tag — a foreign blob throws,
// exactly like DPAPI under a different Windows user.
function storage(tag = "userA") {
  const marker = `dpapi:${tag}:`;
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "dpapi",
    encryptString: (value) => Buffer.concat([Buffer.from(marker), Buffer.from(value, "utf8")]),
    decryptString: (buffer) => {
      const raw = Buffer.from(buffer).toString("utf8");
      if (!raw.startsWith(marker)) throw new Error("decrypt failed");
      const out = raw.slice(marker.length);
      if (!out) throw new Error("decrypt failed");
      return out;
    },
  };
}

const auth = { authorization: `Bearer ${token}` };

async function withBroker(safeStorage, fn) {
  const broker = await startCredentialBroker({ token, safeStorage });
  try {
    await fn(broker.url);
  } finally {
    await new Promise((resolve) => broker.server.close(resolve));
  }
}

describe("credential broker — seal/unseal envelope", () => {
  it("round-trips a plaintext credential through base64 ciphertext", async () => {
    await withBroker(storage(), async (url) => {
      const seal = await fetch(`${url}/credential/seal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ plaintext: SECRET }),
      });
      expect(seal.status).toBe(200);
      const sealed = await seal.json();
      expect(sealed.ok).toBe(true);
      expect(typeof sealed.blob).toBe("string");
      expect(sealed.blob).not.toContain(SECRET);
      expect(JSON.stringify(sealed)).not.toContain(SECRET);

      const unseal = await fetch(`${url}/credential/unseal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ blob: sealed.blob }),
      });
      expect(unseal.status).toBe(200);
      expect((await unseal.json()).plaintext).toBe(SECRET);
    });
  });

  it("a restarted broker instance unseals a blob for the same OS user", async () => {
    let blob;
    await withBroker(storage("userA"), async (url) => {
      const res = await fetch(`${url}/credential/seal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ plaintext: SECRET }),
      });
      blob = (await res.json()).blob;
    });
    await withBroker(storage("userA"), async (url) => {
      const res = await fetch(`${url}/credential/unseal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ blob }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).plaintext).toBe(SECRET);
    });
  });

  it("fails closed when encryption is unavailable or basic_text", async () => {
    for (const safeStorage of [
      { ...storage(), isEncryptionAvailable: () => false },
      { ...storage(), getSelectedStorageBackend: () => "basic_text" },
      undefined,
    ]) {
      await withBroker(safeStorage, async (url) => {
        const status = await fetch(`${url}/credential/status`, { headers: auth });
        expect(status.status).toBe(503);
        const statusBody = await status.json();
        expect(statusBody.code).toBe("CREDENTIAL_STORE_UNAVAILABLE");
        expect(statusBody.available).toBe(false);

        for (const [path, body] of [
          ["/credential/seal", { plaintext: SECRET }],
          ["/credential/unseal", { blob: "QUJD" }],
        ]) {
          const res = await fetch(`${url}${path}`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          expect(res.status).toBe(503);
          const parsed = await res.json();
          expect(parsed.code).toBe("CREDENTIAL_STORE_UNAVAILABLE");
          expect(JSON.stringify(parsed)).not.toContain(SECRET);
        }
      });
    }
  });

  it("reports a corrupt, foreign-user, or malformed blob as DECRYPT_FAILED", async () => {
    let foreignBlob;
    await withBroker(storage("userB"), async (otherUrl) => {
      const res = await fetch(`${otherUrl}/credential/seal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ plaintext: SECRET }),
      });
      foreignBlob = (await res.json()).blob;
    });
    await withBroker(storage("userA"), async (url) => {
      const res = await fetch(`${url}/credential/unseal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ blob: foreignBlob }),
      });
      expect(res.status).toBe(422);
      const parsed = await res.json();
      expect(parsed.code).toBe("CREDENTIAL_DECRYPT_FAILED");
      expect(JSON.stringify(parsed)).not.toContain(SECRET);
    });
  });

  it("rejects malformed payloads without echoing material", async () => {
    await withBroker(storage(), async (url) => {
      const cases = [
        ["/credential/seal", { plaintext: "" }, 400],
        ["/credential/seal", { plaintext: 42 }, 400],
        ["/credential/seal", { nope: true }, 400],
        ["/credential/seal", { plaintext: "x".repeat(9000) }, 400],
        ["/credential/unseal", { blob: "not base64!!!" }, 400],
        ["/credential/unseal", { blob: "" }, 400],
        ["/credential/unseal", {}, 400],
      ];
      for (const [path, body, expected] of cases) {
        const res = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(expected);
        const parsed = await res.json();
        expect(parsed.ok).toBe(false);
        expect(parsed.code).toBe("INVALID_PAYLOAD");
        expect(JSON.stringify(parsed)).not.toContain(SECRET);
      }
      const notJson = await fetch(`${url}/credential/seal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "definitely not json",
      });
      expect(notJson.status).toBe(400);
      const tooLarge = await fetch(`${url}/credential/seal`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ plaintext: "p".repeat(60 * 1024) }),
      });
      expect(tooLarge.status).toBe(413);
    });
  });

  it("requires the bearer token and only serves the fixed routes", async () => {
    await withBroker(storage(), async (url) => {
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "bearer " + token }]) {
        const res = await fetch(`${url}/credential/status`, { headers });
        expect(res.status).toBe(401);
        expect((await res.json()).code).toBe("UNAUTHORIZED");
      }
      for (const [method, path] of [
        ["GET", "/credential/seal"],
        ["GET", "/session"],
        ["POST", "/credential/status"],
        ["DELETE", "/credential/unseal"],
        ["POST", "/credential/other"],
        ["GET", "/credential"],
      ]) {
        const res = await fetch(`${url}${path}`, { method, headers: auth });
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe("NOT_FOUND");
      }
    });
  });

  it("handles concurrent seal/unseal without cross-talk", async () => {
    await withBroker(storage(), async (url) => {
      const secrets = Array.from({ length: 16 }, (_, i) => `sk-parallel-${i}-${SECRET}`);
      const blobs = await Promise.all(
        secrets.map(async (plaintext) => {
          const res = await fetch(`${url}/credential/seal`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ plaintext }),
          });
          return (await res.json()).blob;
        }),
      );
      const opened = await Promise.all(
        blobs.map(async (blob) => {
          const res = await fetch(`${url}/credential/unseal`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ blob }),
          });
          return (await res.json()).plaintext;
        }),
      );
      expect(opened).toEqual(secrets);
    });
  });
});
