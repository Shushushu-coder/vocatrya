// Cold-start navigation settle for the desktop shell.
//
// Electron's loadURL promise rejects with ERR_ABORTED whenever another
// main-frame navigation supersedes the in-flight load — a driver/tooling
// goto, a renderer-side push during hydration, or a session-restore
// navigation. That is a cancelled navigation, not a backend failure: the
// entry load must only fail startup when the window never settles on an
// allowed backend page. waitForAllowedNavigation decides which aborts are
// benign so genuinely broken startups still fail.
"use strict";

const NAVIGATION_ABORT_ERRNO = -3;
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

function isNavigationAbortError(error) {
  if (!error) return false;
  if (error.errno === NAVIGATION_ABORT_ERRNO) return true;
  return /ERR_ABORTED/.test(String(error.message || ""));
}

// Resolves true only when the window's last-committed URL passes
// `isAllowed` AND the main frame has finished loading. A committed
// backend URL that is still loading is not settled — the load can still
// fail (did-fail-load), so URL alone never decides success. Resolves
// false on timeout (including a valid URL still loading), window loss,
// or a subsequent non-abort main-frame load failure — a real error
// keeps the caller's startup-failure path. Aborted superseding
// navigations are ignored: their replacement still gets to commit.
function waitForAllowedNavigation(window, { isAllowed, timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS } = {}) {
  const contents = window && !window.isDestroyed?.() ? window.webContents : null;
  if (!contents || typeof isAllowed !== "function") return Promise.resolve(false);
  const currentUrl = () => {
    try {
      return contents.getURL();
    } catch {
      return "";
    }
  };
  const mainFrameLoading = () => {
    try {
      return contents.isLoadingMainFrame();
    } catch {
      return false;
    }
  };
  const isSettled = () => isAllowed(currentUrl()) && !mainFrameLoading();
  if (isSettled()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (result) => {
      clearTimeout(timer);
      contents.removeListener("did-navigate", onSettle);
      contents.removeListener("did-navigate-in-page", onSettle);
      contents.removeListener("did-finish-load", onSettle);
      contents.removeListener("did-stop-loading", onSettle);
      contents.removeListener("did-fail-load", onFail);
      contents.removeListener("did-fail-provisional-load", onFail);
      contents.removeListener("destroyed", onDestroyed);
      resolve(result);
    };
    const onSettle = () => {
      if (isSettled()) finish(true);
    };
    const onFail = (_event, errorCode, _description, _validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      // Another superseded navigation — keep waiting for its replacement.
      if (errorCode === NAVIGATION_ABORT_ERRNO) return;
      finish(false);
    };
    const onDestroyed = () => finish(false);
    contents.on("did-navigate", onSettle);
    contents.on("did-navigate-in-page", onSettle);
    contents.on("did-finish-load", onSettle);
    contents.on("did-stop-loading", onSettle);
    contents.on("did-fail-load", onFail);
    contents.on("did-fail-provisional-load", onFail);
    contents.once("destroyed", onDestroyed);
    timer = setTimeout(() => finish(isSettled()), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

module.exports = {
  DEFAULT_SETTLE_TIMEOUT_MS,
  NAVIGATION_ABORT_ERRNO,
  isNavigationAbortError,
  waitForAllowedNavigation,
};
