// Isolated cold-start smoke. A disposable userData directory and a local
// loopback gate stand in for NextAuth. The shell never writes the session
// cookie and never treats cookie presence alone as a login.
//
// VOCATRYA_SESSION_SMOKE_DIR  disposable directory (required)
// VOCATRYA_SESSION_SMOKE_PHASE  write | read
//
// write: store a valid token, flush the cookie jar, exit.
// read: new process, same userData. /dashboard restores only the valid
// token. An expired or unknown token lands on /signin.
"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveColdStartEntry } = require("../main/cold-start");
const { flushDefaultSession } = require("../main/shutdown");

const dir = (process.env.VOCATRYA_SESSION_SMOKE_DIR || "").trim();
const phase = (process.env.VOCATRYA_SESSION_SMOKE_PHASE || "").trim();
const VALID = "valid-token";

function writeReport(report) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `session-${phase}-report.json`), `${JSON.stringify(report, null, 2)}\n`);
}

if (!dir || (phase !== "write" && phase !== "read")) {
  console.error("VOCATRYA_SESSION_SMOKE_DIR and PHASE=write|read are required");
  app.exit(2);
} else {
  app.setPath("userData", path.join(dir, "user-data"));
  app.whenReady().then(async () => {
    const report = { phase, steps: [], pass: false };
    const record = (name, ok, detail) => {
      report.steps.push({ name, ok: Boolean(ok), detail: detail == null ? null : String(detail) });
      console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    };
    try {
      if (phase === "write") {
        const expirationDate = Math.floor(Date.now() / 1000) + 3600;
        await session.defaultSession.cookies.set({
          url: "http://127.0.0.1/dashboard",
          name: "authjs.session-token",
          value: VALID,
          expirationDate,
        });
        await flushDefaultSession(session.defaultSession);
        const stored = await session.defaultSession.cookies.get({ name: "authjs.session-token" });
        record("flush-valid-token", stored.length === 1 && stored[0].value === VALID);
        report.pass = report.steps.every((step) => step.ok);
        writeReport(report);
        app.exit(report.pass ? 0 : 1);
        return;
      }

      const server = http.createServer((req, res) => {
        const cookies = Object.fromEntries(
          (req.headers.cookie || "")
            .split(";")
            .filter(Boolean)
            .map((part) => {
              const [key, ...rest] = part.trim().split("=");
              return [key, rest.join("=")];
            }),
        );
        const token = cookies["authjs.session-token"];
        const pathname = new URL(req.url, "http://127.0.0.1").pathname;
        if (pathname === "/dashboard") {
          if (token === VALID) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<h1 id=\"gate\">DASHBOARD</h1>");
            return;
          }
          res.writeHead(302, { location: "/signin" });
          res.end();
          return;
        }
        if (pathname === "/signin") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<h1 id=\"gate\">SIGNIN</h1>");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.on("clientError", () => {});
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      const entry = resolveColdStartEntry(origin);
      const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: true } });

      async function navigate(label, expectGate) {
        await win.loadURL(entry);
        const landed = win.webContents.getURL();
        const body = await win.webContents.executeJavaScript("document.querySelector('#gate')?.textContent || ''");
        record(label, landed.startsWith(origin) && body === expectGate, `url=${landed} gate=${body}`);
      }

      const before = await session.defaultSession.cookies.get({ name: "authjs.session-token" });
      record("cold-start-sees-flushed-token", before.length === 1 && before[0].value === VALID);
      await navigate("valid-session-restores-dashboard", "DASHBOARD");

      await session.defaultSession.cookies.set({
        url: "http://127.0.0.1/dashboard",
        name: "authjs.session-token",
        value: "expired-token",
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
      await navigate("invalid-token-stays-signed-out", "SIGNIN");

      await session.defaultSession.cookies.remove("http://127.0.0.1/dashboard", "authjs.session-token");
      await session.defaultSession.cookies.set({
        url: "http://127.0.0.1/dashboard",
        name: "authjs.session-token",
        value: VALID,
        expirationDate: Math.floor(Date.now() / 1000) - 60,
      });
      await navigate("expired-token-stays-signed-out", "SIGNIN");

      const mintedByShell = await session.defaultSession.cookies.get({ name: "authjs.session-token" });
      record(
        "shell-did-not-mint-a-session",
        mintedByShell.every((cookie) => cookie.value !== "shell-minted"),
        `count=${mintedByShell.length}`,
      );

      report.pass = report.steps.every((step) => step.ok);
      writeReport(report);
      win.destroy();
      server.close();
      app.exit(report.pass ? 0 : 1);
    } catch (error) {
      record("smoke-error", false, error && error.stack ? error.stack : String(error));
      report.pass = false;
      writeReport(report);
      app.exit(1);
    }
  });

  setTimeout(() => {
    writeReport({ phase, steps: [{ name: "watchdog-timeout", ok: false, detail: "exceeded 30s" }], pass: false });
    app.exit(2);
  }, 30_000).unref();
}
