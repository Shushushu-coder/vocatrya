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
}) => Promise<{ redirectUrl: string | null }>;

let activeServer: { server: Server; port: number } | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let handlerRef: CallbackHandler | null = null;

const RESPONSE_HEADERS = { "content-type": "text/plain; charset=utf-8" };

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
      if (outcome.redirectUrl) {
        res.writeHead(302, { location: outcome.redirectUrl }).end();
      } else {
        res
          .writeHead(400, RESPONSE_HEADERS)
          .end("Authorization failed or expired — return to Vocatrya.");
      }
    } catch {
      res.writeHead(500, RESPONSE_HEADERS).end("Connection failed");
    }
  })();
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
    activeServer = { server, port };
    expiryTimer = setTimeout(() => {
      closeNotionCallbackListener();
    }, NOTION_OAUTH_PENDING_TTL_MS + 30_000);
    expiryTimer.unref?.();
    return port;
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
