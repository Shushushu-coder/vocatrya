// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ensureNotionCallbackListener, closeNotionCallbackListener, notionCallbackListenerPort } from "@/lib/extensions/notion/callbackServer";
import { NOTION_CALLBACK_PATH, NOTION_OAUTH_PENDING_TTL_MS } from "@/lib/extensions/notion/constants";
afterEach(() => closeNotionCallbackListener());
it.each([true, false])("finishes on the listener without a dashboard redirect (connected=%s)", async connected => {
  const port = await ensureNotionCallbackListener([0], async () => ({ connected, redirectUrl: "http://127.0.0.1:3737/dashboard/extensions/notion?notion=connected" }));
  const response = await fetch(`http://127.0.0.1:${port}${NOTION_CALLBACK_PATH}?code=synthetic-code&state=synthetic-state`, { redirect: "manual" });
  expect(response.status).toBe(connected ? 200 : 400);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  expect(html).toContain(connected ? "Notion 授权已完成" : "Notion 授权未完成");
  expect(html).not.toContain("synthetic-code");
  expect(html).not.toContain("synthetic-state");
});
it("re-arms the expiry when a restarted flow reuses the listener", async () => {
  vi.useFakeTimers();
  try {
    const handler = async () => ({ connected: true, redirectUrl: null });
    const port = await ensureNotionCallbackListener([0], handler);
    const ttl = NOTION_OAUTH_PENDING_TTL_MS + 30_000;
    await vi.advanceTimersByTimeAsync(ttl - 1_000);
    expect(await ensureNotionCallbackListener([0], handler)).toBe(port);
    // The first flow's timer would have fired here and closed the newer flow's listener.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(notionCallbackListenerPort()).toBe(port);
    await vi.advanceTimersByTimeAsync(ttl);
    expect(notionCallbackListenerPort()).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
