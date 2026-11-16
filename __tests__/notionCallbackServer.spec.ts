// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { ensureNotionCallbackListener, closeNotionCallbackListener } from "@/lib/extensions/notion/callbackServer";
import { NOTION_CALLBACK_PATH } from "@/lib/extensions/notion/constants";
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
