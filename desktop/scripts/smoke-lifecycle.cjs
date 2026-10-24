// Isolated lifecycle smoke for the Vocatrya desktop shell. Runs a REAL
// Electron session against an app-owned settings file in a disposable
// directory — no backend, database, network, or user data is touched.
//
// Verifies on this machine: tray creation, close-to-tray interception,
// tray restore, minimized-launch, explicit quit (window destroyed, not
// hidden), and the read path of OS login items (read-only — the smoke never
// registers a login item).
//
// Usage:
//   set VOCATRYA_LIFECYCLE_SMOKE_DIR=<temp dir>
//   electron desktop/scripts/smoke-lifecycle.cjs
// Report: <dir>/smoke-lifecycle-report.json, exit code 0 = PASS.
"use strict";
const { app, BrowserWindow, Menu, Tray, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createDesktopLifecycle } = require("../main/lifecycle");
const { createDesktopSettingsStore } = require("../main/desktop-settings");

const dir = (process.env.VOCATRYA_LIFECYCLE_SMOKE_DIR || "").trim();
const report = {
  platform: process.platform,
  electron: process.versions.electron,
  steps: [],
  pass: false,
};

function record(name, ok, detail) {
  report.steps.push({ name, ok: Boolean(ok), detail: detail == null ? null : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function writeReport() {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "smoke-lifecycle-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

if (!dir) {
  console.error("VOCATRYA_LIFECYCLE_SMOKE_DIR is required");
  app.exit(2);
} else {
  // Keep Chromium profile data inside the disposable smoke directory.
  app.setPath("userData", path.join(dir, "user-data"));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 400));

  app.whenReady().then(async () => {
    try {
      // Capture the real menu template handed to the OS — a real Tray does
      // not expose its menu items, so the template is the honest evidence.
      let trayTemplate = null;
      const realBuildFromTemplate = Menu.buildFromTemplate.bind(Menu);
      Menu.buildFromTemplate = (template) => {
        trayTemplate = template;
        return realBuildFromTemplate(template);
      };

      const store = createDesktopSettingsStore({
        filePath: path.join(dir, "config", "desktop-settings.json"),
      });
      store.update({ closeToTray: true, startMinimized: true });

      let window = null;
      const lifecycle = createDesktopLifecycle({
        app,
        Tray,
        Menu,
        nativeImage,
        trayIconPath: path.join(__dirname, "..", "assets", "icon.ico"),
        settingsStore: store,
        getWindow: () => window,
      });

      const tray = lifecycle.ensureTray();
      record("tray-created", Boolean(tray));
      const trayLabels = (trayTemplate || []).map((item) => item.label || item.type);
      record(
        "tray-menu-contract",
        trayLabels[0] === "打开 Vocatrya" && trayLabels[2] === "退出 Vocatrya",
        trayLabels.join("|"),
      );
      const state = lifecycle.getState();
      record(
        "login-item-real-read",
        state.openAtLoginSupported && state.openAtLoginError === null,
        `openAtLogin=${state.openAtLogin}`,
      );

      // Minimized launch: hidden until ready-to-show, then opens minimized.
      // First-run GPU/renderer init can delay ready-to-show well past a
      // fixed tick, so poll the real window state with a deadline.
      window = new BrowserWindow({ show: !lifecycle.shouldStartMinimized(), width: 800, height: 600 });
      lifecycle.attachWindow(window);
      await window.loadURL("data:text/html,<h1>lifecycle smoke</h1>");
      const waitFor = async (predicate, ms = 8000) => {
        const deadline = Date.now() + ms;
        while (!predicate() && Date.now() < deadline) await tick();
        return predicate();
      };
      const minimizedAtStart = await waitFor(() => window.isMinimized());
      record("start-minimized", minimizedAtStart, `minimized=${window.isMinimized()}`);

      await lifecycle.showMainWindow();
      record(
        "restore-from-minimized",
        await waitFor(() => window.isVisible() && !window.isMinimized(), 3000),
      );

      window.close();
      await tick();
      record(
        "close-to-tray",
        !window.isDestroyed() && !window.isVisible(),
        `destroyed=${window.isDestroyed()} visible=${window.isVisible()}`,
      );

      // Drive the REAL menu-item click handlers captured from the template
      // (the same functions the OS tray menu invokes).
      trayTemplate[0].click();
      record(
        "tray-restore",
        await waitFor(() => window.isVisible() && !window.isDestroyed(), 3000),
        `visible=${window.isVisible()} destroyed=${window.isDestroyed()} minimized=${window.isMinimized()}`,
      );

      // Explicit quit via the tray quit item: windows must be destroyed,
      // never merely hidden.
      app.once("will-quit", () => {
        record(
          "explicit-quit-real",
          window.isDestroyed(),
          "window destroyed on quit (not hidden)",
        );
        report.pass = report.steps.every((step) => step.ok);
        process.exitCode = report.pass ? 0 : 1;
        writeReport();
      });
      trayTemplate[2].click();
    } catch (error) {
      record("smoke-error", false, error.stack || error.message);
      writeReport();
      app.exit(2);
    }
  });

  // Watchdog: a hung window/tray interaction must not block forever.
  setTimeout(() => {
    record("watchdog-timeout", false, "smoke exceeded 30s");
    writeReport();
    app.exit(2);
  }, 30_000).unref();
}
