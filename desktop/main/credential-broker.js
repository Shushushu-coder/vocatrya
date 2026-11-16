// BYOK credential-envelope broker — a loopback-only seal/unseal oracle
// inside Electron main, the only process that can touch OS-backed
// safeStorage (DPAPI on Windows). The backend reaches it over
// 127.0.0.1 with the per-launch VOCATRYA_DESKTOP_INTERNAL_TOKEN bearer;
// the renderer has no path to it at all (no IPC channel, no preload
// bridge, token lives only in main and the backend env).
//
//   GET  /credential/status           -> {ok, available, backend}
//   POST /credential/seal   {plaintext} -> {blob}     (base64 safeStorage ciphertext)
//   POST /credential/unseal {blob}      -> {plaintext}
//   POST /dictation/request            -> optional fixed-destination transport
// The dictation handler shares authentication/listener lifecycle only; it
// owns its own audio bounds and does not change credential operations.
//
// Fail closed: when safeStorage reports encryption unavailable or the
// basic_text fallback, every operation — status included — answers
// CREDENTIAL_STORE_UNAVAILABLE and nothing is ever produced as plaintext
// or application-key ciphertext. The broker holds no credential
// semantics: no file paths, no enumeration, no provider awareness — it
// only transforms blobs. Error responses carry stable codes and never
// echo request material or internal exception details.
const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const STATUS_PATH = "/credential/status";
const SEAL_PATH = "/credential/seal";
const UNSEAL_PATH = "/credential/unseal";
// 8KB plaintext cap: a provider API key is well under 200 bytes; the bound
// exists so a malformed caller cannot turn the broker into a bulk oracle.
const MAX_PLAINTEXT_BYTES = 8 * 1024;
// 32KB ciphertext cap (raw bytes; the wire value is base64). DPAPI blobs
// for an API key are a few hundred bytes — 32KB is generous headroom.
const MAX_BLOB_BYTES = 32 * 1024;
const MAX_BLOB_CHARS = Math.ceil((MAX_BLOB_BYTES / 3) * 4) + 8;
const MAX_BODY_BYTES = 48 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  STORE_UNAVAILABLE: "CREDENTIAL_STORE_UNAVAILABLE",
  DECRYPT_FAILED: "CREDENTIAL_DECRYPT_FAILED",
};

function bearerMatches(header, token) {
  if (typeof header !== "string" || typeof token !== "string") return false;
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, code, extra) {
  sendJson(res, status, { ok: false, code, ...(extra || {}) });
}

// Reads the request body under a hard byte cap. Over-cap bytes are drained
// and discarded (destroying the socket mid-upload would reset the
// connection before the 413 reaches the caller); buffered content is
// never logged or retained.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(new Error("body-too-large"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// Reports the OS storage gate. available requires a real OS backend —
// Electron's basic_text fallback is plaintext and must fail closed.
function storageState(safeStorage) {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") {
      return { available: false, backend: null };
    }
    const backend =
      typeof safeStorage.getSelectedStorageBackend === "function"
        ? safeStorage.getSelectedStorageBackend()
        : null;
    const available =
      safeStorage.isEncryptionAvailable() === true && backend !== "basic_text";
    return {
      available: available === true,
      backend: typeof backend === "string" ? backend : null,
    };
  } catch {
    return { available: false, backend: null };
  }
}

function isCanonicalBase64(value, maxChars) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    return false;
  }
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function readJsonObject(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

function createCredentialBrokerServer({ token, safeStorage, maxBodyBytes, logger, dictationTransport } = {}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Credential broker authentication token is required");
  }
  const bodyCap =
    typeof maxBodyBytes === "number" && maxBodyBytes > 0
      ? maxBodyBytes
      : MAX_BODY_BYTES;

  return http.createServer(async (req, res) => {
    // Sanitized stage log: method, path and status only — never the
    // bearer, plaintext, or ciphertext material.
    const pathname = req.url ? req.url.split("?")[0] : "";
    const route = [STATUS_PATH, SEAL_PATH, UNSEAL_PATH].includes(pathname) ? pathname : "unknown-route";
    const logResult = (status, code) => {
      const method = ["GET", "POST"].includes(req.method) ? req.method : "OTHER";
      try { logger?.info?.(`[credential-broker] ${method} ${route} -> ${status}${code ? ` ${code}` : ""}`); } catch { /* logging must never affect the broker */ }
    };
    const reply = (status, payload) => {
      sendJson(res, status, payload);
      logResult(status, payload && payload.code);
    };
    const replyError = (status, code, extra) => {
      sendError(res, status, code, extra);
      logResult(status, code);
    };
    try {
      // Auth before routing: an unauthenticated caller learns nothing
      // about the surface (same convention as the hosted-session broker).
      if (!bearerMatches(req.headers.authorization, token)) {
        replyError(401, CODES.UNAUTHORIZED);
        return;
      }
      if (req.method === "POST" && req.url === "/dictation/request" && dictationTransport) {
        await dictationTransport(req, res);
        return;
      }
      const state = storageState(safeStorage);

      if (req.method === "GET" && pathname === STATUS_PATH) {
        if (!state.available) {
          replyError(503, CODES.STORE_UNAVAILABLE, {
            available: false,
            backend: state.backend,
          });
          return;
        }
        reply(200, {
          ok: true,
          available: true,
          backend: state.backend,
        });
        return;
      }

      if (
        req.method !== "POST" ||
        (pathname !== SEAL_PATH && pathname !== UNSEAL_PATH)
      ) {
        replyError(404, CODES.NOT_FOUND);
        return;
      }

      if (!state.available) {
        replyError(503, CODES.STORE_UNAVAILABLE, {
          available: false,
          backend: state.backend,
        });
        return;
      }

      let raw;
      try {
        raw = await readBody(req, bodyCap);
      } catch {
        replyError(413, CODES.INVALID_PAYLOAD);
        return;
      }
      const payload = readJsonObject(raw);
      if (!payload) {
        replyError(400, CODES.INVALID_PAYLOAD);
        return;
      }

      if (pathname === SEAL_PATH) {
        const plaintext = payload.plaintext;
        if (
          typeof plaintext !== "string" ||
          plaintext.length === 0 ||
          Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES
        ) {
          replyError(400, CODES.INVALID_PAYLOAD);
          return;
        }
        let ciphertext;
        try {
          const sealed = safeStorage.encryptString(plaintext);
          ciphertext = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
        } catch {
          replyError(503, CODES.STORE_UNAVAILABLE);
          return;
        }
        if (ciphertext.length === 0) {
          replyError(503, CODES.STORE_UNAVAILABLE);
          return;
        }
        reply(200, { ok: true, blob: ciphertext.toString("base64") });
        return;
      }

      // UNSEAL_PATH
      const blob = payload.blob;
      if (!isCanonicalBase64(blob, MAX_BLOB_CHARS)) {
        replyError(400, CODES.INVALID_PAYLOAD);
        return;
      }
      let plaintext;
      try {
        plaintext = safeStorage.decryptString(Buffer.from(blob, "base64"));
      } catch {
        // The blob cannot be decrypted in this OS context — foreign user,
        // foreign machine, or corruption. Permanent, not environmental.
        replyError(422, CODES.DECRYPT_FAILED);
        return;
      }
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        replyError(422, CODES.DECRYPT_FAILED);
        return;
      }
      reply(200, { ok: true, plaintext });
    } catch {
      // Never leak internals — a stable code is the whole contract.
      try {
        if (!res.headersSent && !res.destroyed) {
          sendError(res, 500, CODES.STORE_UNAVAILABLE);
          logResult(500, CODES.STORE_UNAVAILABLE);
        } else if (!res.destroyed) {
          res.end();
        }
      } catch {
        // Nothing left to do.
      }
    }
  });
}

// Binds to an OS-assigned loopback port and resolves once listening.
function startCredentialBroker(options) {
  const server = createCredentialBrokerServer(options);
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = {
  CODES,
  MAX_PLAINTEXT_BYTES,
  MAX_BLOB_BYTES,
  createCredentialBrokerServer,
  startCredentialBroker,
};
