// Main-process credential primitive. Reuses Electron's OS-backed safeStorage;
// tokens never enter renderer IPC, settings, SQLite, or portable backup data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");

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
    clear(localUserId) { const target = filename(localUserId); if (fs.existsSync(target)) fs.unlinkSync(target); },
  };
}
async function startHostedSessionBroker({ token, store }) {
  if (!token) throw new Error("Internal session broker authentication required");
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    const expected = Buffer.from(`Bearer ${token}`); const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) { res.writeHead(401); res.end('{"code":"MANAGED_AUTH_REQUIRED"}'); return; }
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/session") { res.writeHead(404); res.end(); return; }
      const session = store.read(url.searchParams.get("localUserId"));
      if (!session) { res.writeHead(401); res.end('{"code":"MANAGED_AUTH_REQUIRED"}'); return; }
      res.end(JSON.stringify({ token: session }));
    } catch { res.writeHead(401); res.end('{"code":"MANAGED_AUTH_REQUIRED"}'); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
module.exports = { createHostedSessionStore, startHostedSessionBroker };
