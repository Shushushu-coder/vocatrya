// Main-process credential primitive. Reuses Electron's OS-backed safeStorage;
// tokens never enter renderer IPC, settings, SQLite, or portable backup data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 8 * 1024;

// Store location: a dev VOCATRYA_DESKTOP_DATA_ROOT override isolates the
// profile through the foundation layout, so sessions live under that
// root's config dir. Packaged and plain dev keep the existing state-root
// location so already-stored sessions stay valid.
function resolveHostedSessionDirectory({ isPackaged, foundationLayout, stateRoot }) {
  if (!isPackaged && foundationLayout) return path.join(foundationLayout.configDir, "hosted-sessions");
  return path.join(stateRoot, "hosted-sessions");
}

function createHostedSessionStore({ directory, safeStorage, logger } = {}) {
  const secure = () => {
    if (!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error("Secure hosted session storage unavailable");
  };
  const filename = (localUserId) => {
    if (typeof localUserId !== "string" || !localUserId.trim() || localUserId.length > 256) throw new Error("Invalid local account binding");
    return path.join(directory, crypto.createHash("sha256").update(localUserId).digest("hex") + ".dat");
  };
  const log = (message) => {
    try { logger?.info?.(`[hosted-session] ${message}`); } catch { /* logging must never affect storage */ }
  };
  return {
    // Trusted login completion/operator primitive only; no renderer setter.
    save(localUserId, token) {
      secure();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid hosted session");
      const target = filename(localUserId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = target + "." + crypto.randomUUID() + ".tmp";
      try { fs.writeFileSync(temporary, safeStorage.encryptString(token), { mode: 0o600 }); fs.renameSync(temporary, target); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    },
    read(localUserId) {
      secure(); const target = filename(localUserId);
      let ciphertext;
      try {
        ciphertext = fs.readFileSync(target);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        // A filesystem error is transient and does not prove the session is
        // absent — surface it instead of downgrading to "no session".
        throw error;
      }
      let token;
      try {
        token = safeStorage.decryptString(ciphertext);
      } catch (error) {
        // A decrypt failure cannot be distinguished from a temporarily
        // unavailable key or OS store — keep the blob and surface the
        // honest storage error instead of dropping a recoverable session.
        throw error;
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        // The blob decrypted cleanly but is not a session token — it is
        // provably dead weight (foreign or truncated content), so converge
        // on "no session" and drop it for consistency with clear/redeem.
        try { fs.unlinkSync(target); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        log("dropped malformed session blob");
        return null;
      }
      return token;
    },
    clear(localUserId, expectedToken) {
      const target = filename(localUserId);
      // Synchronous compare/delete: a late rejection of an older session
      // cannot delete a newer credential saved by a successful redemption.
      if (expectedToken !== undefined && this.read(localUserId) !== expectedToken) return false;
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return true;
    },
  };
}
function readBoundedBody(req, allowEmpty = false) {
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { try { resolve(length === 0 && allowEmpty ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("invalid payload")); } });
    req.on("error", reject);
  });
}
async function startHostedSessionBroker({ token, store, logger } = {}) {
  if (!token) throw new Error("Internal session broker authentication required");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    // Sanitized stage log: method, path and status only — never the
    // localUserId query, bearer, or session material.
    let pathname = "?";
    try { pathname = new URL(req.url, "http://127.0.0.1").pathname; } catch { /* logged below */ }
    const route = pathname === "/session" ? pathname : "unknown-route";
    const logResult = (status, code) => {
      const method = ["GET", "POST", "DELETE"].includes(req.method) ? req.method : "OTHER";
      try { logger?.info?.(`[hosted-session] ${method} ${route} -> ${status}${code ? ` ${code}` : ""}`); } catch { /* logging must never affect the broker */ }
    };
    const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); res.end('{"code":"MANAGED_AUTH_REQUIRED"}'); logResult(401, "MANAGED_AUTH_REQUIRED"); return; }
    const fail = (status, code) => { res.writeHead(status); res.end(JSON.stringify({ code })); logResult(status, code); };
    void (async () => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/session") { fail(404, "NOT_FOUND"); return; }
        if (req.method === "GET") {
          const session = store.read(url.searchParams.get("localUserId"));
          if (!session) { fail(401, "MANAGED_AUTH_REQUIRED"); return; }
          res.end(JSON.stringify({ token: session }));
          logResult(200);
          return;
        }
        // Write/clear is the backend's trusted login-completion channel: the
        // Next server redeems a hosted-issued credential and hands it here
        // for OS-protected storage. It never flows through renderer IPC.
        if (req.method === "PUT") {
          const body = await readBoundedBody(req);
          if (!body || typeof body !== "object") { fail(400, "INVALID_PAYLOAD"); return; }
          store.save(body.localUserId, body.token);
          res.end('{"saved":true}');
          logResult(200);
          return;
        }
        if (req.method === "DELETE") {
          const localUserId = url.searchParams.get("localUserId");
          if (typeof localUserId !== "string" || !localUserId.trim() || localUserId.length > 256) { fail(400, "INVALID_PAYLOAD"); return; }
          const body = req.headers["content-type"] === "application/json" ? await readBoundedBody(req, true) : {};
          if (!body || typeof body !== "object" || (body.expectedToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(body.expectedToken))) { fail(400, "INVALID_PAYLOAD"); return; }
          const cleared = store.clear(localUserId, body.expectedToken);
          res.end(JSON.stringify({ cleared }));
          logResult(200);
          return;
        }
        fail(404, "NOT_FOUND");
      } catch { fail(400, "INVALID_PAYLOAD"); }
    })();
  });
  // Bound in-flight request handling the same way the credential broker
  // does — a stalled upload must not outlive the server itself.
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
module.exports = { createHostedSessionStore, resolveHostedSessionDirectory, startHostedSessionBroker };
