// Main-process credential primitive. Reuses Electron's OS-backed safeStorage;
// tokens never enter renderer IPC, settings, SQLite, or portable backup data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 8 * 1024;

function createHostedSessionStore({ directory, safeStorage }) {
  const secure = () => {
    if (!safeStorage?.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new Error("Secure hosted session storage unavailable");
  };
  const filename = (localUserId) => {
    if (typeof localUserId !== "string" || !localUserId.trim() || localUserId.length > 256) throw new Error("Invalid local account binding");
    return path.join(directory, crypto.createHash("sha256").update(localUserId).digest("hex") + ".dat");
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
      if (!fs.existsSync(target)) return null;
      const token = safeStorage.decryptString(fs.readFileSync(target));
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid hosted session");
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
async function startHostedSessionBroker({ token, store }) {
  if (!token) throw new Error("Internal session broker authentication required");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); res.end('{"code":"MANAGED_AUTH_REQUIRED"}'); return; }
    const fail = (status, code) => { res.writeHead(status); res.end(JSON.stringify({ code })); };
    void (async () => {
      try {
        const url = new URL(req.url, "http://127.0.0.1");
        if (url.pathname !== "/session") { fail(404, "NOT_FOUND"); return; }
        if (req.method === "GET") {
          const session = store.read(url.searchParams.get("localUserId"));
          if (!session) { fail(401, "MANAGED_AUTH_REQUIRED"); return; }
          res.end(JSON.stringify({ token: session }));
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
          return;
        }
        if (req.method === "DELETE") {
          const localUserId = url.searchParams.get("localUserId");
          if (typeof localUserId !== "string" || !localUserId.trim() || localUserId.length > 256) { fail(400, "INVALID_PAYLOAD"); return; }
          const body = req.headers["content-type"] === "application/json" ? await readBoundedBody(req, true) : {};
          if (!body || typeof body !== "object" || (body.expectedToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(body.expectedToken))) { fail(400, "INVALID_PAYLOAD"); return; }
          const cleared = store.clear(localUserId, body.expectedToken);
          res.end(JSON.stringify({ cleared }));
          return;
        }
        fail(404, "NOT_FOUND");
      } catch { fail(400, "INVALID_PAYLOAD"); }
    })();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
module.exports = { createHostedSessionStore, startHostedSessionBroker };
