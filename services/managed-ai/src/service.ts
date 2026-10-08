import { MANAGED_ADAPTER_REVISION, ManagedError, type ManagedInvocation } from "../../../src/lib/ai/managed-contract";
import { ModelCatalog } from "./catalog";
import { ManagedGatewayRuntime } from "./gateway";
import { HostedStore, provenance } from "./store";

function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new ManagedError("GATEWAY_RESPONSE");
  return raw as Record<string, unknown>;
}
function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ManagedError("GATEWAY_RESPONSE");
  return value;
}
export class HostedManagedService {
  constructor(private readonly store: HostedStore, private readonly catalog: ModelCatalog, private readonly gateway: ManagedGatewayRuntime) {}
  async handle(request: Request): Promise<Response> {
    try {
      const user = this.store.authenticate(request.headers.get("authorization"));
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/session") return Response.json({ hostedUserId: user });
      if (request.method === "GET" && path === "/v1/catalog") return Response.json(this.catalog.dto());
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const body = await boundedBody(request);
      if (path === "/v1/bindings") {
        const data = record(body, ["modelKey", "business", "resourceKey"]);
        const model = this.catalog.resolve(string(data.modelKey));
        return Response.json(provenance(this.store.createBinding(user, string(data.business), string(data.resourceKey), model)));
      }
      if (path !== "/v1/text" && path !== "/v1/stream" && path !== "/v1/structured") return new Response(null, { status: 404 });
      const data = record(body, ["bindingId", "modelKey", "prompt", "structuredOutput"]);
      const input: ManagedInvocation = { bindingId: string(data.bindingId), modelKey: string(data.modelKey), prompt: string(data.prompt, 256 * 1024) };
      if (Buffer.byteLength(input.prompt) > 256 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
      if (data.structuredOutput !== undefined) {
        const structured = record(data.structuredOutput, ["schema", "schemaName"]);
        if (!structured.schema || typeof structured.schema !== "object" || Array.isArray(structured.schema) || Buffer.byteLength(JSON.stringify(structured.schema)) > 64 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
        input.structuredOutput = { schema: structured.schema as Record<string, unknown>, schemaName: string(structured.schemaName, 128) };
      }
      if ((path === "/v1/structured") !== !!input.structuredOutput || (path === "/v1/stream" && input.structuredOutput)) throw new ManagedError("GATEWAY_RESPONSE");
      const binding = this.store.binding(input.bindingId, user);
      if (binding.modelKey !== input.modelKey || binding.adapterContractRevision !== MANAGED_ADAPTER_REVISION) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
      const model = this.catalog.resolve(binding.modelKey, path === "/v1/stream" ? "streaming" : path === "/v1/structured" ? "structuredOutput" : "text");
      // Conservative UTF-8 byte ceiling: no tokenizer-dependent underestimation.
      if (Buffer.byteLength(input.prompt) > Math.min(binding.maxInputTokens, model.maxInputTokens)) throw new ManagedError("GATEWAY_RESPONSE");
      if (path === "/v1/stream") {
        const controller = new AbortController();
        const iterator = this.gateway.streamText(binding, input, AbortSignal.any([request.signal, controller.signal]));
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const event = await iterator.next();
              if (event.done) { stream.close(); return; }
              stream.enqueue(encoder.encode(`${JSON.stringify(event.value)}\n`));
            } catch (error) {
              stream.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: error instanceof ManagedError ? error.code : "GATEWAY_RESPONSE" })}\n`)); stream.close();
            }
          },
          async cancel() { controller.abort(); await iterator.return(undefined); },
        }), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      }
      const result = path === "/v1/structured"
        ? await this.gateway.generateStructured(binding, input, request.signal)
        : await this.gateway.generateText(binding, input, request.signal);
      return Response.json(result);
    } catch (error) {
      const code = error instanceof ManagedError ? error.code : "GATEWAY_RESPONSE";
      return Response.json({ code, message: code }, { status: code === "MANAGED_AUTH_REQUIRED" ? 401 : 400 });
    }
  }
}
async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new ManagedError("GATEWAY_RESPONSE");
  const reader = request.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 384 * 1024) throw new ManagedError("GATEWAY_RESPONSE"); chunks.push(chunk.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
