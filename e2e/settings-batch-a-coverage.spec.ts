import { test, expect, login, useEnglishLocale } from "./fixtures";
import { E2E_TEST_USER } from "./support/testUser";
import type { Browser, Page } from "@playwright/test";

// INT-01 only. Batch A browser coverage for the integration host.
// Persistence is read back from the synthetic SQLite file, not from a mock.

// Test-only audit props installed by addInitScript below.
type Int01KeyAdd = { target: string; type: string; stack: string };
type Int01MediaCalls = { getUserMedia: number; enumerateDevices: number; setSinkId: number };

declare global {
  interface Window {
    __int01KeyAdds: Int01KeyAdd[];
    __int01MediaCalls: Int01MediaCalls;
  }
}

const NAV = '[data-testid="settings-nav"]';
const THEME_LABEL = { light: "Light", dark: "Dark", system: "System" } as const;
type ThemeValue = keyof typeof THEME_LABEL;

const EN_GROUPS: { label: string; entries: string[] }[] = [
  { label: "Preferences", entries: ["General", "Notifications", "Appearance"] },
  { label: "AI Configuration", entries: ["AI Services", "AI Assignments"] },
  { label: "Devices & Input", entries: ["Shortcuts", "Audio"] },
  { label: "Data & Support", entries: ["Data & Privacy", "About"] },
];
const ZH_GROUPS: { label: string; entries: string[] }[] = [
  { label: "偏好设置", entries: ["常规偏好", "通知", "外观"] },
  { label: "AI 模型配置", entries: ["AI 服务", "AI 业务分配"] },
  { label: "设备与输入", entries: ["快捷键", "音频"] },
  { label: "数据与支持", entries: ["数据与隐私", "关于"] },
];

type SettingsRow = {
  theme: string | null;
  updatedAt: number | null;
  settings: string | null;
};

function syntheticDbPath(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a file: URL for the synthetic database.");
  }
  const filePath = url.slice("file:".length);
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.endsWith("/prisma/w1-batch-a-int.synthetic.db")) {
    throw new Error("Refusing to read a database outside the integration synthetic file.");
  }
  return filePath;
}

function readSettingsRow(): SettingsRow {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options: { readOnly: boolean },
    ) => {
      prepare: (sql: string) => {
        get: (...args: unknown[]) => { settings: string; updatedAt: number } | undefined;
      };
      close: () => void;
    };
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return readSettingsRowOnce();
    } catch (error) {
      lastError = error;
      if (!String(error).includes("locked")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw lastError;
}

function readSettingsRowOnce(): SettingsRow {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options: { readOnly: boolean; timeout?: number },
    ) => {
      prepare: (sql: string) => {
        get: (...args: unknown[]) => { settings: string; updatedAt: number } | undefined;
      };
      close: () => void;
    };
  };
  const db = new DatabaseSync(syntheticDbPath(), { readOnly: true, timeout: 2000 });
  try {
    const row = db
      .prepare(
        `SELECT s.settings AS settings, s.updatedAt AS updatedAt
         FROM UserSettings s
         JOIN User u ON u.id = s.userId
         WHERE u.email = ?`,
      )
      .get(E2E_TEST_USER.email);
    if (!row) return { theme: null, updatedAt: null, settings: null };
    const parsed = JSON.parse(row.settings) as { display?: { theme?: string } };
    return {
      theme: parsed.display?.theme ?? null,
      updatedAt: row.updatedAt,
      settings: row.settings,
    };
  } finally {
    db.close();
  }
}

function themeRadio(page: Page, theme: ThemeValue) {
  return page.getByRole("radio", { name: THEME_LABEL[theme], exact: true });
}

async function openAppearance(page: Page) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard/settings#appearance");
  await expect(page.getByTestId("settings-section-appearance")).toBeVisible();
  await expect(themeRadio(page, "light")).toBeVisible();
}

async function expectApplied(page: Page, theme: ThemeValue) {
  const resolved = theme === "system" ? "light" : theme;
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${resolved}\\b`));
  const other = resolved === "dark" ? "light" : "dark";
  await expect(page.locator("html")).not.toHaveClass(new RegExp(`\\b${other}\\b`));
  await expect(themeRadio(page, theme)).toBeChecked();
}

async function chooseTheme(page: Page, theme: ThemeValue) {
  const current = themeRadio(page, theme);
  if (await current.isChecked()) return;
  // The radio is sr-only; the visible theme card is the label a person clicks.
  await page.getByTestId("settings-section-appearance").locator("label").filter({ has: current }).click();
}

async function waitForPersistedTheme(theme: ThemeValue) {
  await expect.poll(() => readSettingsRow().theme, { timeout: 15_000 }).toBe(theme);
}

function isThemeSave(method: string, headers: Record<string, string>, body: string) {
  return method === "POST" && Boolean(headers["next-action"]) && body.includes("theme");
}

async function restoreSystemTheme(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext();
  try {
    await useEnglishLocale(context, baseURL);
    const page = await context.newPage();
    await page.goto("/signin");
    await login(page);
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
    await openAppearance(page);
    if (!(await themeRadio(page, "system").isChecked())) {
      await chooseTheme(page, "system");
      await waitForPersistedTheme("system");
    }
  } finally {
    await context.close();
  }
}

test.describe("SET-03 appearance in the integration browser", () => {
  test.describe.configure({ mode: "serial" });

  test.afterAll(async ({ browser, baseURL }) => {
    if (readSettingsRow().theme === "system") return;
    await restoreSystemTheme(browser, baseURL);
  });

  test("theme selection applies immediately and has no separate save action", async ({ page }) => {
    await openAppearance(page);
    const panel = page.getByTestId("settings-section-appearance");
    await expect(panel.getByRole("button", { name: /^(Save|保存)$/ })).toHaveCount(0);

    await chooseTheme(page, "dark");
    await expectApplied(page, "dark");
    await chooseTheme(page, "light");
    await expectApplied(page, "light");
    await chooseTheme(page, "system");
    await expectApplied(page, "system");
    await waitForPersistedTheme("system");
  });

  test("a saved theme survives reload and matches the synthetic database", async ({ page }) => {
    await openAppearance(page);
    await chooseTheme(page, "dark");
    await expectApplied(page, "dark");
    await waitForPersistedTheme("dark");
    const savedAt = readSettingsRow().updatedAt;

    await page.reload();
    await expect(themeRadio(page, "light")).toBeVisible();
    await expectApplied(page, "dark");
    expect(readSettingsRow().theme).toBe("dark");
    expect(readSettingsRow().updatedAt).toBe(savedAt);

    await chooseTheme(page, "light");
    await waitForPersistedTheme("light");
    await page.reload();
    await expect(themeRadio(page, "light")).toBeVisible();
    await expectApplied(page, "light");
    expect(readSettingsRow().theme).toBe("light");
  });

  test("rapid theme changes persist the last selection", async ({ page }) => {
    await openAppearance(page);
    await chooseTheme(page, "light");
    await waitForPersistedTheme("light");

    await chooseTheme(page, "dark");
    await chooseTheme(page, "system");
    await chooseTheme(page, "dark");
    await expectApplied(page, "dark");
    await waitForPersistedTheme("dark");

    await page.reload();
    await expect(themeRadio(page, "dark")).toBeVisible();
    await expectApplied(page, "dark");
    expect(readSettingsRow().theme).toBe("dark");
  });

  test("a failed theme save rolls back the page and does not persist", async ({ page }) => {
    await openAppearance(page);
    await chooseTheme(page, "light");
    await waitForPersistedTheme("light");
    const before = readSettingsRow();

    let armed = true;
    let aborted = 0;
    const seen: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      const headers = request.headers();
      if (request.method() === "POST" && headers["next-action"]) {
        seen.push(body.slice(0, 240));
      }
      if (armed && isThemeSave(request.method(), headers, body)) {
        aborted += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    try {
      await chooseTheme(page, "dark");
      await expect(page.getByText("Failed to save display settings.", { exact: true })).toBeVisible();
      await expect(page.getByText("Save failed", { exact: true })).toBeVisible();
      await expectApplied(page, "light");
      expect(aborted, `no theme save was aborted; next-action bodies: ${seen.join(" || ")}`).toBeGreaterThan(0);
      const after = readSettingsRow();
      expect(after.theme).toBe("light");
      expect(after.settings).toBe(before.settings);
      expect(after.updatedAt).toBe(before.updatedAt);
    } finally {
      armed = false;
      await page.unroute("**/*");
    }

    await chooseTheme(page, "dark");
    await waitForPersistedTheme("dark");
    await expectApplied(page, "dark");
  });
});

test("SET-08 pages mount honest capability states and do not write settings", async ({ page }) => {
  await page.addInitScript(() => {
    const adds: Int01KeyAdd[] = [];
    const targetName = (target: EventTarget): string => {
      if (target === window) return "window";
      if (target === document) return "document";
      return target instanceof Node ? target.nodeName : "other";
    };
    const original = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === "keydown" || type === "keyup" || type === "keypress") {
        adds.push({
          target: targetName(this),
          type: type,
          stack: String(new Error().stack || ""),
        });
      }
      return original.call(this, type, listener, options);
    };
    const media = navigator.mediaDevices;
    const calls = { getUserMedia: 0, enumerateDevices: 0, setSinkId: 0 };
    if (media) {
      const gum = media.getUserMedia && media.getUserMedia.bind(media);
      media.getUserMedia = function (constraints?: MediaStreamConstraints) {
        calls.getUserMedia += 1;
        return gum ? gum(constraints) : Promise.reject(new Error("getUserMedia unavailable"));
      };
      const enumerate = media.enumerateDevices && media.enumerateDevices.bind(media);
      media.enumerateDevices = function () {
        calls.enumerateDevices += 1;
        return enumerate ? enumerate() : Promise.resolve([]);
      };
    }
    const audioProto = window.HTMLMediaElement && HTMLMediaElement.prototype;
    if (audioProto && typeof audioProto.setSinkId === "function") {
      const setSinkId = audioProto.setSinkId;
      audioProto.setSinkId = function (sinkId) {
        calls.setSinkId += 1;
        return setSinkId.call(this, sinkId);
      };
    }
    window.__int01KeyAdds = adds;
    window.__int01MediaCalls = calls;
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard/settings");
  const beforeRow = readSettingsRow();
  const nav = page.locator(NAV);

  await nav.getByRole("button", { name: "Notifications", exact: true }).click();
  const notifications = page.getByTestId("notifications-settings");
  await expect(notifications).toBeVisible();
  await expect(notifications.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible();
  await expect(notifications.getByText("In-app feedback messages", { exact: true })).toBeVisible();
  await expect(notifications.getByText("Built-in", { exact: true })).toBeVisible();
  await expect(notifications.getByText("System notifications", { exact: true })).toBeVisible();
  await expect(notifications.getByText("Notification preferences", { exact: true })).toBeVisible();
  await expect(notifications.getByText("Not provided", { exact: true })).toHaveCount(2);
  await expect(notifications.getByRole("switch")).toHaveCount(0);
  await expect(notifications.getByRole("checkbox")).toHaveCount(0);
  await expect(notifications.getByRole("button")).toHaveCount(0);
  await expect(notifications).not.toContainText("settings.notifications");

  const beforeKeys = await page.evaluate(() => window.__int01KeyAdds.length);
  await nav.getByRole("button", { name: "Shortcuts", exact: true }).click();
  const shortcuts = page.getByTestId("shortcuts-settings");
  await expect(shortcuts).toBeVisible();
  await expect(shortcuts.getByRole("heading", { name: "Shortcuts", exact: true })).toBeVisible();
  await expect(shortcuts.getByText("Expand or collapse the sidebar", { exact: true }).first()).toBeVisible();
  await expect(shortcuts.getByText("Active inside the app window; suppressed while a text input is focused (⌘B on macOS).", { exact: true })).toBeVisible();
  await expect(shortcuts.getByText("Go back one page", { exact: true })).toBeVisible();
  await expect(shortcuts.getByText("Go forward one page", { exact: true })).toBeVisible();
  await expect(shortcuts.getByText("Active only inside the desktop app window; not available in a browser.", { exact: true })).toHaveCount(2);
  await expect(page.getByTestId("shortcuts-env-note")).toHaveText(
    "This environment is not the desktop app: shortcuts marked “Desktop app only” do not fire here.",
  );
  await expect(shortcuts.getByText("Desktop app only", { exact: true })).toHaveCount(2);
  await expect(shortcuts.getByText("OS-level global shortcuts", { exact: true })).toBeVisible();
  await expect(shortcuts.getByText("The app registers no OS-level global shortcuts.", { exact: true })).toBeVisible();
  await expect(shortcuts.getByText("Custom keybindings", { exact: true })).toBeVisible();
  await expect(shortcuts.getByText("Shortcuts cannot be edited or rebound in this version; no keybinding store exists.", { exact: true })).toBeVisible();
  await expect(shortcuts.getByRole("textbox")).toHaveCount(0);
  await expect(shortcuts.getByRole("button")).toHaveCount(0);
  const addedKeys = await page.evaluate((start) => window.__int01KeyAdds.slice(start), beforeKeys);
  const globalKeys = addedKeys.filter((entry) => /^(window|document|HTML)$/.test(entry.target));
  // Radix dismiss/menu/radio layers bind document keydown for overlay focus.
  // Those are shared primitives, not shortcut registration by this page.
  const pageKeys = globalKeys.filter((entry) => !/react-dismissable-layer|react-menu|react-radio-group/.test(entry.stack));
  expect(pageKeys.map((entry) => entry.target + ":" + entry.type + " " + entry.stack.split("\n")[1])).toEqual([]);

  await nav.getByRole("button", { name: "Audio", exact: true }).click();
  const audio = page.getByTestId("audio-settings");
  await expect(audio).toBeVisible();
  await expect(audio.getByRole("heading", { name: "Audio", exact: true })).toBeVisible();
  await expect(audio.getByText("Microphone input", { exact: true })).toBeVisible();
  await expect(audio.getByText("The app does not capture audio and never requests microphone permission.", { exact: true })).toBeVisible();
  await expect(audio.getByText("Audio output & device switching", { exact: true })).toBeVisible();
  await expect(audio.getByText("Recording test", { exact: true })).toBeVisible();
  await expect(audio.getByText("Not provided", { exact: true })).toHaveCount(4);
  await expect(audio.getByRole("switch")).toHaveCount(0);
  await expect(audio.getByRole("checkbox")).toHaveCount(0);
  await expect(audio.getByRole("button")).toHaveCount(0);
  const mediaCalls = await page.evaluate(() => window.__int01MediaCalls);
  expect(mediaCalls).toEqual({ getUserMedia: 0, enumerateDevices: 0, setSinkId: 0 });

  const afterRow = readSettingsRow();
  expect(afterRow.settings).toBe(beforeRow.settings);
  expect(afterRow.updatedAt).toBe(beforeRow.updatedAt);
});

test("public zh-CN and en bundles, nine entries, and section priority hold", async ({ page }) => {
  test.setTimeout(180_000);
  const widths = [390, 1280];

  async function expectGroups(groups: { label: string; entries: string[] }[]) {
    const nav = page.locator(NAV);
    const groupLoc = nav.getByRole("group");
    await expect(groupLoc).toHaveCount(groups.length);
    for (const [index, group] of groups.entries()) {
      const el = groupLoc.nth(index);
      await expect(el).toHaveAttribute("aria-label", group.label);
      for (const entry of group.entries) {
        await expect(el.getByRole("button", { name: entry, exact: true })).toBeVisible();
      }
    }
  }

  async function expectNoOverflow(label: string) {
    const metric = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(metric.scrollWidth, label).toBeLessThanOrEqual(metric.viewport);
  }

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dashboard/settings");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator(NAV).getByRole("button", { name: "General", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("settings-language-select")).toBeVisible();
    await expectGroups(EN_GROUPS);

    await page.goto("/dashboard/settings#shortcuts");
    await expect(page.getByTestId("settings-section-shortcuts")).toBeVisible();
    await expect(page.locator(NAV).getByRole("button", { name: "Shortcuts", exact: true })).toHaveAttribute("aria-current", "true");

    await page.goto("/dashboard/settings?section=audio#appearance");
    await expect(page.getByTestId("settings-section-audio")).toBeVisible();
    await expect(page.getByTestId("settings-section-appearance")).toHaveCount(0);
    await expect(page.locator(NAV).getByRole("button", { name: "Audio", exact: true })).toHaveAttribute("aria-current", "true");

    await page.goto("/dashboard/settings");
    await page.getByTestId("settings-language-select").click();
    await page.getByRole("option", { name: "简体中文" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expectGroups(ZH_GROUPS);

    await page.locator(NAV).getByRole("button", { name: "通知", exact: true }).click();
    const notifications = page.getByTestId("notifications-settings");
    await expect(notifications.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
    await expect(notifications.getByText("应用内消息反馈", { exact: true })).toBeVisible();
    await expect(notifications.getByText("内置", { exact: true })).toBeVisible();
    await expect(notifications.getByText("系统通知", { exact: true })).toBeVisible();
    await expect(notifications.getByText("通知偏好", { exact: true })).toBeVisible();
    await expect(notifications.getByText("未提供", { exact: true })).toHaveCount(2);
    await expect(notifications).not.toContainText("This version has no system notification events");
    await expect(notifications).not.toContainText("settings.notifications");
    await expectNoOverflow(`zh notifications ${width}`);

    await page.locator(NAV).getByRole("button", { name: "快捷键", exact: true }).click();
    const shortcuts = page.getByTestId("shortcuts-settings");
    await expect(shortcuts.getByRole("heading", { name: "快捷键", exact: true })).toBeVisible();
    await expect(page.getByTestId("shortcuts-env-note")).toContainText("当前环境不是桌面应用");
    await expect(shortcuts.getByText("仅桌面应用", { exact: true })).toHaveCount(2);
    await expect(shortcuts.getByText("系统级全局快捷键", { exact: true })).toBeVisible();
    await expect(shortcuts).not.toContainText("settings.shortcuts");
    await expectNoOverflow(`zh shortcuts ${width}`);

    await page.locator(NAV).getByRole("button", { name: "音频", exact: true }).click();
    const audio = page.getByTestId("audio-settings");
    await expect(audio.getByRole("heading", { name: "音频", exact: true })).toBeVisible();
    await expect(audio.getByText("麦克风输入", { exact: true })).toBeVisible();
    await expect(audio.getByText("未提供", { exact: true })).toHaveCount(4);
    await expect(audio).not.toContainText("settings.audio");
    await expectNoOverflow(`zh audio ${width}`);

    await page.locator(NAV).getByRole("button", { name: "外观", exact: true }).click();
    const appearance = page.getByTestId("settings-section-appearance");
    await expect(appearance.getByRole("heading", { name: "外观", exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "浅色模式", exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "深色模式", exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: "跟随系统", exact: true })).toBeVisible();
    await expect(appearance).not.toContainText("settings.theme");
    await expectNoOverflow(`zh appearance ${width}`);

    const bundle = await page.evaluate(async () => {
      const urls = performance.getEntriesByType("resource").map((entry) => entry.name);
      let sawEn = false;
      let sawZh = false;
      for (const url of urls) {
        if (!url.includes("/_next/static/")) continue;
        const text = await fetch(url).then((response) => response.text());
        if (text.includes("Failed to save display settings.")) sawEn = true;
        if (text.includes("保存显示设置失败。")) sawZh = true;
        if (sawEn && sawZh) break;
      }
      return { sawEn, sawZh };
    });
    expect(bundle).toEqual({ sawEn: true, sawZh: true });

    await page.locator(NAV).getByRole("button", { name: "常规偏好", exact: true }).click();
    await expect(page.getByTestId("settings-language-select")).toBeVisible();
    await page.getByTestId("settings-language-select").click();
    await page.getByRole("option", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator(NAV).getByRole("button", { name: "General", exact: true })).toBeVisible();
  }
});
