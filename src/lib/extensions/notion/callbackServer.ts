import "server-only";

import { createServer, type Server } from "node:http";
import {
  NOTION_CALLBACK_HOST,
  NOTION_CALLBACK_PATH,
  NOTION_OAUTH_PENDING_TTL_MS,
} from "./constants";

type CallbackHandler = (input: {
  code?: string;
  state?: string;
  error?: string;
}) => Promise<{ redirectUrl: string | null; connected: boolean }>;

let activeServer: { server: Server; port: number } | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let handlerRef: CallbackHandler | null = null;

const RESPONSE_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function onRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", `http://${NOTION_CALLBACK_HOST}`);
      if (req.method !== "GET" || url.pathname !== NOTION_CALLBACK_PATH) {
        res.writeHead(404, RESPONSE_HEADERS).end("Not found");
        return;
      }
      const handler = handlerRef;
      if (!handler) {
        res.writeHead(409, RESPONSE_HEADERS).end("No pending connection");
        return;
      }
      const outcome = await handler({
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
      });
      // System browsers do not share the desktop's authenticated session.
      // Finish on the loopback listener; the desktop refreshes its own state.
      const connected = outcome.connected;
      res.writeHead(connected ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
      }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vocatrya · Notion</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#172033;font:16px/1.7 system-ui,sans-serif}main{margin:24px;max-width:480px;padding:32px;border:1px solid #e2e8f0;border-radius:20px;background:white}small,p{color:#64748b}h1{font-size:24px}small{letter-spacing:.06em}</style>
<main><small>VOCATRYA / NOTION</small><h1>${connected ? "Notion 授权已完成" : "Notion 授权未完成"}</h1>
<p>${connected ? "请返回 Vocatrya 桌面应用查看连接状态。你可以关闭此页面。" : "请返回 Vocatrya 桌面应用检查连接状态并重试。"}</p>
<p lang="en">${connected ? "Authorization completed. Return to Vocatrya to check your connection. You can close this page." : "Authorization was not completed. Return to Vocatrya to check the connection and try again."}</p></main></html>`);
    } catch {
      res.writeHead(500, RESPONSE_HEADERS).end("Connection failed");
    }
  })();
}

function armExpiryTimer() {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    closeNotionCallbackListener();
  }, NOTION_OAUTH_PENDING_TTL_MS + 30_000);
  expiryTimer.unref?.();
}

/**
 * Bind the loopback callback listener on a pool port. Returns the bound
 * port. The listener closes itself when the pending flow's TTL elapses —
 * an abandoned OAuth attempt never leaves a port held open.
 */
export async function ensureNotionCallbackListener(
  ports: readonly number[],
  handler: CallbackHandler,
): Promise<number> {
  if (activeServer) {
    handlerRef = handler;
    // A restarted flow reuses the listener: re-arm the expiry so the previous
    // flow's older timer cannot close it while the new flow is still pending.
    armExpiryTimer();
    return activeServer.port;
  }
  handlerRef = handler;
  for (const port of ports) {
    const server = createServer(onRequest);
    const bound = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, NOTION_CALLBACK_HOST, () => resolve(true));
    });
    if (!bound) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      continue;
    }
    const address = server.address();
    const boundPort = address && typeof address !== "string" ? address.port : port;
    activeServer = { server, port: boundPort };
    armExpiryTimer();
    return boundPort;
  }
  throw new Error("NOTION_CALLBACK_UNAVAILABLE");
}

export function closeNotionCallbackListener() {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const active = activeServer;
  activeServer = null;
  handlerRef = null;
  if (active) {
    try {
      active.server.close();
    } catch {
      // Already closed.
    }
  }
}

export function notionCallbackListenerPort(): number | null {
  return activeServer?.port ?? null;
}
