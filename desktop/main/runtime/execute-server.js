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
const NATIVE_STREAM_PATH = "/internal/ai-connections/native-session-stream";
const EXECUTE_STREAM_PATH = "/internal/ai-connections/execute-stream";
const RUNTIME_STATE_PATH = "/internal/ai-connections/runtime-state";
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const MAX_PROMPT_CHARS = 256 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_NAME_CHARS = 128;

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
      const pathname = req.url ? req.url.split("?")[0] : "";
      const routeOk =
        (req.method === "POST" &&
          (pathname === EXECUTE_PATH || pathname === EXECUTE_STREAM_PATH || pathname === NATIVE_STREAM_PATH)) ||
        (req.method === "GET" && pathname === RUNTIME_STATE_PATH);
      if (!routeOk) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND" });
        return;
      }
      if (!bearerMatches(req.headers.authorization, token)) {
        sendJson(res, 401, { ok: false, code: "UNAUTHORIZED" });
        return;
      }

      // Capability/readiness pre-flight for the backend: the static
      // descriptor plus the version probed on the installed binary. The
      // backend gates streaming surfaces on this before minting a ticket.
      if (req.method === "GET") {
        const url = new URL(req.url, "http://127.0.0.1");
        const backendKind = url.searchParams.get("backendKind") || "";
        const accountProvider = url.searchParams.get("provider") || undefined;
        sendJson(
          res,
          200,
          service.runtimeState({ backendKind, accountProvider }),
        );
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

      if (pathname === NATIVE_STREAM_PATH) {
        const session = payload.nativeSession;
        const allowed = ["conversationId", "threadId", "runtimeVersion", "runtimeProfileRef", "configHash"];
        const valid = session && typeof session === "object" && !Array.isArray(session) &&
          Object.keys(session).every(key => allowed.includes(key)) &&
          typeof session.conversationId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(session.conversationId) &&
          (session.threadId === null || (typeof session.threadId === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(session.threadId))) &&
          ["runtimeVersion", "runtimeProfileRef", "configHash"].every(key => session[key] === undefined || (typeof session[key] === "string" && session[key].length <= 256));
        // Slice-1 business bridge descriptor: shape-checked here; the runtime
        // re-validates loopback URL, fixed env var and the tool allowlist.
        const mcp = payload.nativeBusinessMcp;
        const mcpKeys = mcp && typeof mcp === "object" && !Array.isArray(mcp) ? Object.keys(mcp) : [];
        const mcpValid = mcp && mcpKeys.length === 4 && ["url", "bearerTokenEnvVar", "token", "allowedTools"].every(key => mcpKeys.includes(key)) &&
          typeof mcp.url === "string" && mcp.url.length <= 2048 &&
          mcp.bearerTokenEnvVar === "VOCATRYA_NATIVE_BUSINESS_MCP_TOKEN" &&
          typeof mcp.token === "string" && mcp.token.length <= 512 &&
          Array.isArray(mcp.allowedTools) && mcp.allowedTools.length <= 24 &&
          mcp.allowedTools.every(name => typeof name === "string" && name.length <= 64);
        if (payload.permissionScope !== "NATIVE_SESSION_V1" || !valid || !mcpValid || payload.structuredOutput !== undefined ||
            typeof payload.instructions !== "string" || payload.instructions.length > 16000 || typeof service.executeNativeSession !== "function") {
          sendJson(res, 400, { ok: false, code: "INVALID_PAYLOAD" }); return;
        }
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableEnded) controller.abort(); });
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        const write = event => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
        const result = await service.executeNativeSession({ ticket, connectionId, model, prompt, instructions: payload.instructions,
          nativeSession: session, nativeBusinessMcp: mcp, timeoutMs, signal: controller.signal, onEvent: event => { if (event.type !== "error") write(event); },
        });
        write(result.ok ? { type: "completed", text: result.text } : { type: "error", code: result.code });
        if (!res.destroyed) res.end();
        return;
      }

      // Optional structured-output probe contract. The schema is an
      // inline JSON Schema object owned by Vocatrya — never a filesystem
      // path, never caller-supplied args. Strict shape: {schema, schemaName}
      // only, schema <= 64KB serialized.
      let structuredOutput;
      if (payload.structuredOutput !== undefined) {
        const so = payload.structuredOutput;
        const keys =
          so && typeof so === "object" && !Array.isArray(so)
            ? Object.keys(so)
            : [];
        const schemaOk =
          so &&
          typeof so === "object" &&
          !Array.isArray(so) &&
          keys.every((k) => k === "schema" || k === "schemaName") &&
          so.schema &&
          typeof so.schema === "object" &&
          !Array.isArray(so.schema) &&
          typeof so.schemaName === "string" &&
          so.schemaName.length > 0 &&
          so.schemaName.length <= MAX_SCHEMA_NAME_CHARS &&
          Buffer.byteLength(JSON.stringify(so.schema), "utf8") <=
            MAX_SCHEMA_BYTES;
        if (!schemaOk) {
          sendJson(res, 400, { ok: false, code: "INVALID_PAYLOAD" });
          return;
        }
        structuredOutput = { schema: so.schema, schemaName: so.schemaName };
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

      if (pathname === EXECUTE_STREAM_PATH) {
        // Streaming variant of /execute: normalized RuntimeStreamEvent
        // objects as NDJSON — one {"type":"text-delta","delta":...} line per
        // delta as it arrives (never buffered), then a terminal
        // {"type":"completed",text} or {"type":"error",code}. The same
        // ticket, permission and verification gates apply — this is the
        // provider-neutral streaming seam Career Dialogue consumes.
        if (structuredOutput) {
          // Decision steps go through the buffered /execute path — mixing
          // schema output into the delta stream is not part of the
          // streaming contract.
          sendJson(res, 400, { ok: false, code: "INVALID_PAYLOAD" });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
        const writeEvent = (event) => {
          try {
            if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
          } catch {
            // Client is gone — the close handler already aborted the run.
          }
        };
        const result = await service.executeTextStream({
          ticket,
          connectionId,
          model,
          prompt,
          timeoutMs,
          signal: controller.signal,
          // Deltas and vendor errors stream through; the parser's own
          // terminal "completed" is superseded by the canonical result
          // event written below — the client stops at the first terminal.
          onEvent: (event) => {
            if (event.type !== "completed") writeEvent(event);
          },
        });
        writeEvent(
          result.ok
            ? {
                type: "completed",
                text: result.text,
                model: result.model,
                durationMs: result.durationMs,
                ...(result.runtime ? { runtime: result.runtime } : {}),
              }
            : { type: "error", code: result.code },
        );
        if (!res.destroyed) res.end();
        return;
      }

      const result = await service.executeText({
        ticket,
        connectionId,
        model,
        prompt,
        structuredOutput,
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
