import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const {
  ZOOM_FILE_NAME,
  clampZoomFactor,
  createZoomController,
  nextZoomFactor,
  titleBarOverlayHeight,
} = createRequire(import.meta.url)("./zoom.js");

describe("zoom factor math", () => {
  it("steps by 10 percent and clamps to 50–200", () => {
    expect(nextZoomFactor(1, "in")).toBe(1.1);
    expect(nextZoomFactor(1, "out")).toBe(0.9);
    expect(nextZoomFactor(1.5, "reset")).toBe(1);
    expect(nextZoomFactor(1.96, "in")).toBe(2);
    expect(nextZoomFactor(0.54, "out")).toBe(0.5);
    expect(clampZoomFactor(3)).toBe(2);
    expect(clampZoomFactor(Number.NaN)).toBe(1);
    expect(titleBarOverlayHeight(1.5)).toBe(54);
  });
});

describe("zoom controller", () => {
  function makeWindow(start = 1) {
    let factor = start;
    const listeners = {};
    const webContents = {
      setZoomMode: vi.fn(),
      setZoomFactor: vi.fn((next) => {
        factor = next;
      }),
      getZoomFactor: () => factor,
      setVisualZoomLevelLimits: vi.fn(() => Promise.resolve()),
      on: vi.fn((event, handler) => {
        listeners[event] = handler;
      }),
    };
    return {
      isDestroyed: () => false,
      webContents,
      setTitleBarOverlay: vi.fn(),
      wheel() {
        listeners["zoom-changed"]?.();
      },
    };
  }

  it("restores the saved factor in isolation and grows the title bar with it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-zoom-"));
    const filePath = path.join(root, ZOOM_FILE_NAME);
    fs.writeFileSync(filePath, JSON.stringify({ factor: 1.5 }));
    const win = makeWindow();
    const nativeTheme = { shouldUseDarkColors: false };
    const controller = createZoomController({
      filePath,
      getWindow: () => win,
      nativeTheme,
    });
    expect(controller.factor()).toBe(1.5);
    controller.attach(win);
    expect(win.webContents.setZoomMode).toHaveBeenCalledWith("isolated");
    expect(win.webContents.setZoomFactor).toHaveBeenCalledWith(1.5);
    expect(
      win.webContents.setZoomMode.mock.invocationCallOrder[0],
    ).toBeLessThan(win.webContents.setZoomFactor.mock.invocationCallOrder[0]);
    expect(win.webContents.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
    if (process.platform === "win32") {
      expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
        height: 54,
        color: "#ffffff",
        symbolColor: "#020817",
      });
    }
    expect(controller.adjust("in")).toBe(1.6);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).factor).toBe(1.6);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("clamps a wheel zoom that leaves the supported range and keeps an in-range wheel step", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-zoom-"));
    const filePath = path.join(root, ZOOM_FILE_NAME);
    const win = makeWindow(1);
    const controller = createZoomController({
      filePath,
      getWindow: () => win,
      nativeTheme: { shouldUseDarkColors: true },
    });
    controller.attach(win);
    win.webContents.setZoomFactor(1.2);
    win.wheel();
    expect(controller.factor()).toBe(1.2);
    expect(JSON.parse(fs.readFileSync(filePath, "utf8")).factor).toBe(1.2);
    win.webContents.setZoomFactor(2.4);
    win.wheel();
    expect(win.webContents.setZoomFactor).toHaveBeenCalledWith(2);
    expect(controller.factor()).toBe(2);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
