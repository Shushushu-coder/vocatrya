// Whole-window page zoom for the desktop shell. Chromium's zoom factor
// (webContents.setZoomFactor) keeps layout, hit testing, and media queries
// in one CSS-pixel space. The factor is a device preference, stored beside
// the other app-owned config files, and applied per webContents.
//
// The main window uses zoom mode "isolated" so its factor does not follow
// — or overwrite — another window on the same origin. The hidden resume
// print window sets its own isolated factor of 1 before loading.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ZOOM_DEFAULT = 1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
const TITLEBAR_BASE_HEIGHT = 36;
const ZOOM_FILE_NAME = "zoom-preferences.json";

const ZOOM_IPC_CHANNELS = Object.freeze({
  get: "desktopZoom:get",
  adjust: "desktopZoom:adjust",
  changed: "desktopZoom:changed",
});

function clampZoomFactor(value) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : ZOOM_DEFAULT;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, numeric));
  return Math.round(clamped * 100) / 100;
}

function nextZoomFactor(current, direction) {
  const base = clampZoomFactor(current);
  if (direction === "reset") return ZOOM_DEFAULT;
  if (direction === "in") return clampZoomFactor(base + ZOOM_STEP);
  if (direction === "out") return clampZoomFactor(base - ZOOM_STEP);
  throw new Error("Invalid zoom direction");
}

function titleBarOverlayHeight(factor) {
  return Math.round(TITLEBAR_BASE_HEIGHT * clampZoomFactor(factor));
}

function overlayColors(dark) {
  return dark
    ? { color: "#09090b", symbolColor: "#e4e4e7" }
    : { color: "#ffffff", symbolColor: "#020817" };
}

function createZoomController({ filePath, fsImpl = fs, getWindow, nativeTheme, logger = console } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Zoom preferences file path is required");
  }
  let factor = ZOOM_DEFAULT;
  let applying = false;
  const listeners = new Set();

  function readStored() {
    try {
      const raw = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
      if (raw && typeof raw === "object" && typeof raw.factor === "number") {
        return clampZoomFactor(raw.factor);
      }
    } catch {
      // Missing or damaged files fall back to 100%.
    }
    return ZOOM_DEFAULT;
  }

  function persist(next) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temporary, `${JSON.stringify({ factor: next }, null, 2)}\n`, "utf8");
    fsImpl.renameSync(temporary, filePath);
  }

  function emit() {
    for (const listener of listeners) listener(factor);
  }

  function overlayOptions(theme) {
    const dark = theme === "dark" || (theme !== "light" && Boolean(nativeTheme && nativeTheme.shouldUseDarkColors));
    return { height: titleBarOverlayHeight(factor), ...overlayColors(dark) };
  }

  function syncOverlay(win) {
    if (!win || win.isDestroyed() || process.platform !== "win32") return;
    try {
      win.setTitleBarOverlay(overlayOptions());
    } catch (error) {
      logger.error("Title bar overlay could not follow the zoom factor", error);
    }
  }

  function applyFactor(win, next) {
    factor = clampZoomFactor(next);
    if (!win || win.isDestroyed()) return factor;
    applying = true;
    try {
      win.webContents.setZoomFactor(factor);
    } catch (error) {
      logger.error("Window zoom could not be applied", error);
    } finally {
      applying = false;
    }
    syncOverlay(win);
    return factor;
  }

  function load() {
    factor = readStored();
    return factor;
  }

  // Isolate first, then set the saved factor, so a shared-origin zoom map
  // cannot pull this window along or publish its factor to the print window.
  function attach(win) {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.setZoomMode("isolated");
    } catch (error) {
      logger.error("Window zoom could not be isolated", error);
    }
    applyFactor(win, factor);
    try {
      const pending = win.webContents.setVisualZoomLevelLimits(1, 1);
      if (pending && typeof pending.catch === "function") {
        pending.catch((error) => {
          logger.error("Pinch zoom could not be locked", error);
        });
      }
    } catch (error) {
      logger.error("Pinch zoom could not be locked", error);
    }
    win.webContents.on("zoom-changed", () => {
      if (applying || win.isDestroyed()) return;
      const live = win.webContents.getZoomFactor();
      const clamped = clampZoomFactor(live);
      if (Math.abs(live - clamped) > 0.001) {
        try {
          win.webContents.setZoomFactor(clamped);
        } catch (error) {
          logger.error("Window zoom could not be clamped", error);
        }
      }
      if (Math.abs(clamped - factor) <= 0.001) {
        syncOverlay(win);
        return;
      }
      factor = clamped;
      try {
        persist(factor);
      } catch (error) {
        logger.error("Zoom preference could not be saved", error);
      }
      syncOverlay(win);
      emit();
    });
  }

  function adjust(direction) {
    const next = nextZoomFactor(factor, direction);
    try {
      persist(next);
    } catch (error) {
      logger.error("Zoom preference could not be saved", error);
      throw error;
    }
    applyFactor(typeof getWindow === "function" ? getWindow() : null, next);
    emit();
    return factor;
  }

  load();

  return {
    adjust,
    attach,
    factor: () => factor,
    load,
    overlayOptions,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function registerZoomIpc(ipcMain, { controller, getWindow, getOrigin }) {
  if (!controller) throw new Error("zoom controller is required");
  const resolveWindow = typeof getWindow === "function" ? getWindow : () => undefined;

  function assertTrustedSender(event) {
    const win = resolveWindow();
    const window = win && !win.isDestroyed() ? win : null;
    const origin = typeof getOrigin === "function" ? getOrigin() : getOrigin;
    if (!window || typeof origin !== "string" || !origin) {
      throw new Error("Untrusted zoom sender");
    }
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin
    ) {
      throw new Error("Untrusted zoom sender");
    }
  }

  const unsubscribe = controller.subscribe((next) => {
    const win = resolveWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(ZOOM_IPC_CHANNELS.changed, next);
  });

  ipcMain.handle(ZOOM_IPC_CHANNELS.get, (event) => {
    assertTrustedSender(event);
    return controller.factor();
  });
  ipcMain.handle(ZOOM_IPC_CHANNELS.adjust, (event, direction) => {
    assertTrustedSender(event);
    return controller.adjust(direction);
  });
  return () => {
    unsubscribe();
    ipcMain.removeHandler(ZOOM_IPC_CHANNELS.get);
    ipcMain.removeHandler(ZOOM_IPC_CHANNELS.adjust);
  };
}

module.exports = {
  TITLEBAR_BASE_HEIGHT,
  ZOOM_DEFAULT,
  ZOOM_FILE_NAME,
  ZOOM_IPC_CHANNELS,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoomFactor,
  createZoomController,
  nextZoomFactor,
  registerZoomIpc,
  titleBarOverlayHeight,
};
