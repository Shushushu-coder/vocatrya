import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  isNavigationAbortError,
  waitForAllowedNavigation,
} from "./navigation-settle.js";

const ORIGIN = "http://127.0.0.1:43987";
const allowed = (url) => {
  try {
    const candidate = new URL(url);
    return candidate.hostname === "127.0.0.1" && String(candidate.port) === "43987";
  } catch {
    return false;
  }
};

function makeWindow(url = "", { loading = false } = {}) {
  const contents = new EventEmitter();
  contents.getURL = () => url;
  contents.isLoadingMainFrame = () => loading;
  return {
    webContents: contents,
    url: (next) => (url = next),
    loading: (next) => (loading = next),
    destroyed: false,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("isNavigationAbortError", () => {
  it("recognizes ERR_ABORTED by errno and by message", () => {
    const abort = new Error("ERR_ABORTED (-3) loading 'http://127.0.0.1:43987/signup'");
    abort.errno = -3;
    expect(isNavigationAbortError(abort)).toBe(true);
    expect(isNavigationAbortError(new Error("ERR_ABORTED (-3) loading 'x'"))).toBe(true);
  });

  it("rejects real load and backend failures", () => {
    expect(isNavigationAbortError(new Error("ERR_CONNECTION_REFUSED (-102) loading 'x'"))).toBe(false);
    expect(isNavigationAbortError(new Error("Backend exited before readiness"))).toBe(false);
    expect(isNavigationAbortError(null)).toBe(false);
  });
});

describe("waitForAllowedNavigation", () => {
  it("accepts immediately when the window already sits on a backend page", async () => {
    const win = makeWindow(`${ORIGIN}/signin`);
    await expect(waitForAllowedNavigation(win, { isAllowed: allowed })).resolves.toBe(true);
  });

  it("accepts when the superseding navigation commits a backend page (normal signin redirect)", async () => {
    const win = makeWindow(`${ORIGIN}/signin`);
    // Committed /signin is already allowed — the entry abort is benign.
    await expect(waitForAllowedNavigation(win, { isAllowed: allowed })).resolves.toBe(true);
  });

  it("accepts when the abort leaves an earlier commit but a backend navigation lands", async () => {
    const win = makeWindow("data:text/html,splash");
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 1000 });
    win.url(`${ORIGIN}/signup`);
    win.webContents.emit("did-navigate", {}, `${ORIGIN}/signup`);
    await expect(pending).resolves.toBe(true);
  });

  it("keeps waiting through another aborted superseding navigation", async () => {
    const win = makeWindow("data:text/html,splash");
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 1000 });
    win.webContents.emit("did-fail-load", {}, -3, "", `${ORIGIN}/signup`, true);
    win.url(`${ORIGIN}/signup`);
    win.webContents.emit("did-navigate", {}, `${ORIGIN}/signup`);
    await expect(pending).resolves.toBe(true);
  });

  it("ignores subframe failures while waiting", async () => {
    const win = makeWindow("data:text/html,splash");
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 1000 });
    win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", `${ORIGIN}/api/x`, false);
    win.url(`${ORIGIN}/signin`);
    win.webContents.emit("did-finish-load");
    await expect(pending).resolves.toBe(true);
  });

  it("rejects on a real main-frame load failure (backend unreachable)", async () => {
    const win = makeWindow("data:text/html,splash");
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 5000 });
    win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", `${ORIGIN}/signin`, true);
    await expect(pending).resolves.toBe(false);
  });

  it("does not accept a stale allowed URL while the replacement navigation is still loading", async () => {
    const win = makeWindow(`${ORIGIN}/signin`, { loading: true });
    let resolved = false;
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 1000 })
      .then((result) => {
        resolved = true;
        return result;
      });
    await tick();
    // The old page URL is valid but the superseding load is in flight —
    // the wait must still be observing, not already accepted.
    expect(resolved).toBe(false);
    win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", `${ORIGIN}/signin`, true);
    await expect(pending).resolves.toBe(false);
  });

  it("accepts only after the replacement navigation finishes on an allowed page", async () => {
    const win = makeWindow(`${ORIGIN}/signin`, { loading: true });
    let resolved = false;
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 1000 })
      .then((result) => {
        resolved = true;
        return result;
      });
    await tick();
    expect(resolved).toBe(false);
    // Commit alone is not success — the document is still loading.
    win.url(`${ORIGIN}/signup`);
    win.webContents.emit("did-navigate", {}, `${ORIGIN}/signup`);
    await tick();
    expect(resolved).toBe(false);
    win.loading(false);
    win.webContents.emit("did-finish-load");
    await expect(pending).resolves.toBe(true);
  });

  it("rejects when a valid URL is still loading at the timeout", async () => {
    const win = makeWindow(`${ORIGIN}/signin`, { loading: true });
    await expect(waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 60 })).resolves.toBe(false);
  });

  it("rejects when the replacement navigation commits a disallowed page", async () => {
    const win = makeWindow("data:text/html,splash");
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 60 });
    win.url("chrome-error://chromewebdata/");
    win.webContents.emit("did-navigate", {}, "chrome-error://chromewebdata/");
    await expect(pending).resolves.toBe(false);
  });

  it("rejects when nothing valid commits before the timeout (external nav blocked)", async () => {
    const win = makeWindow("data:text/html,splash");
    await expect(waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 60 })).resolves.toBe(false);
  });

  it("rejects when the window is destroyed while waiting", async () => {
    const win = makeWindow("data:text/html,splash");
    const pending = waitForAllowedNavigation(win, { isAllowed: allowed, timeoutMs: 5000 });
    win.webContents.emit("destroyed");
    await expect(pending).resolves.toBe(false);
  });

  it("rejects when there is no webContents to observe", async () => {
    await expect(waitForAllowedNavigation(null, { isAllowed: allowed })).resolves.toBe(false);
    await expect(waitForAllowedNavigation({}, { isAllowed: allowed })).resolves.toBe(false);
  });
});
