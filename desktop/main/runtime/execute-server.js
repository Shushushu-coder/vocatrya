// Internal execution endpoint — the backend → desktop leg of the business
// TEXT_ONLY execution seam. This is a plain loopback HTTP server inside
// Electron main (NOT an IPC channel): the renderer can never reach it
// because requests must carry the internal bearer token, which only the
// backend and main process know.
//
//   backend executeAIConnectionText()
//     → POST /internal/ai-connections/execute (127.0.0.1, bearer token)
//     → {ticket, model, prompt, permissionScope: "TEXT_ONLY"}
//     → connection-service.executeText() — ticket redeems to the trusted
//       connection binding, the adapter runs its locked-down one-shot in a
//       fresh temp cwd
//
// No executable path, args, env, cwd, profile path, or credential ever
// crosses this boundary in either direction.
const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");

const EXECUTE_PATH = "/internal/ai-connections/execute";
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const MAX_PROMPT_CHARS = 256 * 1024;

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
  });
  res.end(body);
}

// Reads the request body with a hard byte cap — no streaming to disk, no
// logging. Over-cap bytes are drained and discarded (destroying the socket
// mid-upload would reset the connection before the 413 reaches the
// caller); the buffered content is never retained or parsed.
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

function readString(value, maxChars) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (typeof maxChars === "number" && value.length > maxChars) return null;
  return value;
}

// Creates the server. `service` is the connection-ops facade from
// connection-service.js; `token` is the same internal secret that guards
// the desktop → backend internal API. Returns the http.Server — call
// listen() via startExecutionServer.
function createExecutionServer({ token, service, maxBodyBytes } = {}) {
  const bodyCap =
    typeof maxBodyBytes === "number" && maxBodyBytes > 0
      ? maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;

  return http.createServer(async (req, res) => {
    try {
      if (
        req.method !== "POST" ||
        !req.url ||
        req.url.split("?")[0] !== EXECUTE_PATH
      ) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND" });
        return;
      }
      if (!bearerMatches(req.headers.authorization, token)) {
        sendJson(res, 401, { ok: false, code: "UNAUTHORIZED" });
        return;
      }

      let raw;
      try {
        raw = await readBody(req, bodyCap);
      } catch {
        sendJson(res, 413, { ok: false, code: "AI_REQUEST_TOO_LARGE" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { ok: false, code: "INVALID_PAYLOAD" });
        return;
      }
      if (!payload || typeof payload !== "object") {
        sendJson(res, 400, { ok: false, code: "INVALID_PAYLOAD" });
        return;
      }

      const ticket = readString(payload.ticket);
      const connectionId = readString(payload.connectionId);
      const model = readString(payload.model);
      const prompt = readString(payload.prompt, MAX_PROMPT_CHARS);
      const timeoutMs =
        typeof payload.timeoutMs === "number" &&
        Number.isFinite(payload.timeoutMs)
          ? Math.max(1_000, payload.timeoutMs)
          : undefined;

      if (!ticket || !connectionId || !model || !prompt) {
        sendJson(res, 400, { ok: false, code: "INVALID_PAYLOAD" });
        return;
      }
      if (payload.permissionScope !== "TEXT_ONLY") {
        sendJson(res, 403, {
          ok: false,
          code: "PERMISSION_BOUNDARY_NOT_READY",
        });
        return;
      }

      // A client disconnect aborts the underlying runtime child process.
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      const result = await service.executeText({
        ticket,
        connectionId,
        model,
        prompt,
        timeoutMs,
        signal: controller.signal,
      });
      sendJson(res, 200, result);
    } catch {
      // Never leak internals — a stable code is the whole contract. The
      // socket may already be gone (client disconnect); responding then is
      // impossible, so this must not throw.
      try {
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, 500, { ok: false, code: "AI_EXECUTION_FAILED" });
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
function startExecutionServer(options) {
  const server = createExecutionServer(options);
  // Slow-loris hygiene for a long-lived loopback listener: headers must
  // arrive promptly; a request gets the exec ceiling plus margin.
  server.headersTimeout = 30_000;
  server.requestTimeout = 330_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

module.exports = {
  EXECUTE_PATH,
  MAX_PROMPT_CHARS,
  createExecutionServer,
  startExecutionServer,
};
