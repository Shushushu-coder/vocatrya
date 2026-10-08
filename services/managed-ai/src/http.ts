import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { HostedManagedService } from "./service";
export function createHostedServer(service: HostedManagedService) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    req.on("aborted", () => controller.abort());
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: controller.signal };
      if (req.method !== "GET" && req.method !== "HEAD") { init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>; init.duplex = "half"; }
      // Route parsing never uses a client supplied host as an upstream destination.
      const response = await service.handle(new Request(new URL(req.url ?? "/", "http://hosted.internal"), init));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (!response.body) { res.end(); return; }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      res.on("close", cancel);
      try {
        while (!controller.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          if (!res.write(chunk.value)) await new Promise<void>(resolve => { const done = () => { res.off("drain", done); res.off("close", done); resolve(); }; res.once("drain", done); res.once("close", done); });
        }
      } finally { res.off("close", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }); res.end('{"code":"GATEWAY_RESPONSE","message":"GATEWAY_RESPONSE"}'); }
  });
}
