import { ManagedError, type ManagedInvocation, type ManagedStreamEvent, type ManagedTextResult } from "../../../src/lib/ai/managed-contract";
import { provenance, type ManagedAiBinding } from "./store";

export const VERIFIED_GATEWAY_CAPABILITIES = { text: true, streaming: true, structuredOutput: true, tools: false };
export interface GatewayConfig { baseUrl: string; apiKey: string; timeoutMs?: number; allowLoopbackForTests?: boolean }
type GatewayPayload = { model?: unknown; choices?: { message?: { content?: unknown }; delta?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };

/**
 * Hosted-local settlement disposition. Not part of the public wire contract:
 * the admission layer uses it to decide RELEASED / COMMITTED / UNKNOWN.
 * RELEASED  — the gateway definitively rejected before generation.
 * COMMITTED — the gateway executed and the response is unusable/invalid.
 * UNKNOWN   — dispatch state cannot be confirmed (network/timeout/5xx).
 */
export type GatewayDisposition = "RELEASED" | "COMMITTED" | "UNKNOWN";
export class GatewayFailure extends ManagedError {
  constructor(code: ManagedError["code"], public readonly disposition: GatewayDisposition) { super(code); this.name = "GatewayFailure"; }
}

/** Generic HTTP statuses (400/401/403/408/409/425/429 included) do not
 * prove rejection before generation. Only adapter-controlled dispatch facts do. */
export function classifyGatewaySettlementRisk(facts: { dispatched: boolean; generated?: boolean }): GatewayDisposition {
  if (facts.generated) return "COMMITTED";
  return facts.dispatched ? "UNKNOWN" : "RELEASED";
}

export class ManagedGatewayRuntime {
  private readonly url: string;
  constructor(private readonly config: GatewayConfig, private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(config.baseUrl);
    if ((url.protocol !== "https:" && !(config.allowLoopbackForTests && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !config.apiKey.trim()) throw new Error("Invalid hosted gateway configuration");
    this.url = `${url.toString().replace(/\/$/, "")}/chat/completions`;
  }
  private actualModel(payload: GatewayPayload, binding: ManagedAiBinding): void {
    if (typeof payload.model !== "string" || ![binding.upstreamModelId, ...binding.allowedModelAliases].includes(payload.model)) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
  }
  private async request(binding: ManagedAiBinding, input: ManagedInvocation, stream: boolean, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) throw new GatewayFailure("GATEWAY_NETWORK", classifyGatewaySettlementRisk({ dispatched: false }));
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: binding.upstreamModelId, messages: [{ role: "user", content: input.prompt }], stream, max_tokens: binding.maxOutputTokens }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        if (status === 401 || status === 403) throw new GatewayFailure("GATEWAY_AUTH", classifyGatewaySettlementRisk({ dispatched: true }));
        if (status === 429) throw new GatewayFailure("GATEWAY_RATE_LIMIT", classifyGatewaySettlementRisk({ dispatched: true }));
        throw new GatewayFailure("GATEWAY_RESPONSE", classifyGatewaySettlementRisk({ dispatched: true }));
      }
      return response;
    } catch (error) { throw this.normalize(error, signal); }
  }
  private normalize(error: unknown, signal: AbortSignal): GatewayFailure {
    if (error instanceof GatewayFailure) return error;
    if (signal.aborted) return new GatewayFailure(signal.reason?.name === "TimeoutError" ? "GATEWAY_TIMEOUT" : "GATEWAY_NETWORK", "UNKNOWN");
    return new GatewayFailure("GATEWAY_NETWORK", "UNKNOWN");
  }
  async generateText(binding: ManagedAiBinding, input: ManagedInvocation, signal?: AbortSignal): Promise<ManagedTextResult> {
    const combined = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs ?? 120_000), ...(signal ? [signal] : [])]);
    try {
      const response = await this.request(binding, input, false, combined);
      const raw = await readBounded(response, 4 * 1024 * 1024);
      let payload: GatewayPayload;
      try { payload = JSON.parse(raw); } catch { throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED"); }
      if (!payload || typeof payload !== "object") throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
      this.actualModel(payload, binding);
      if (!Array.isArray(payload.choices) || payload.choices.length !== 1) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
      const choice = payload.choices?.[0];
      if (typeof choice?.message?.content !== "string" || typeof choice.finish_reason !== "string") throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
      return { text: choice.message.content, model: binding.modelKey, provenance: provenance(binding),
        structuredStrategy: input.structuredOutput ? "PROMPT_AND_VALIDATE" : null, stopReason: choice.finish_reason,
        inputTokens: usageNumber(payload.usage?.prompt_tokens), outputTokens: usageNumber(payload.usage?.completion_tokens) };
    } catch (error) { throw this.normalize(error, combined); }
  }
  generateStructured(binding: ManagedAiBinding, input: ManagedInvocation, signal?: AbortSignal): Promise<ManagedTextResult> {
    // Existing application validator owns schema prompting, parsing and one repair.
    return this.generateText(binding, input, signal);
  }
  async *streamText(binding: ManagedAiBinding, input: ManagedInvocation, signal?: AbortSignal): AsyncGenerator<ManagedStreamEvent> {
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.timeoutMs ?? 120_000), ...(signal ? [signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(binding, input, true, combined);
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "", finished = false, total = 0;
      while (true) {
        const chunk = await reader.read();
        if (combined.aborted) throw this.normalize(null, combined);
        if (chunk.done) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
        total += chunk.value.byteLength;
        if (total > 4 * 1024 * 1024) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
        try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED"); }
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          if (combined.aborted) throw this.normalize(null, combined);
          const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          if (data === "[DONE]") {
            if (!finished || buffer.trim()) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
            yield { type: "completed", model: binding.modelKey, provenance: provenance(binding) };
            return;
          }
          let payload: GatewayPayload;
          try { payload = JSON.parse(data); } catch { throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED"); }
          if (!payload || typeof payload !== "object") throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
          this.actualModel(payload, binding);
          if (!Array.isArray(payload.choices) || payload.choices.length !== 1) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
          const choice = payload.choices?.[0];
          if (!choice || !choice.delta || typeof choice.delta !== "object" || (choice.delta.content != null && typeof choice.delta.content !== "string")) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
          if (finished) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
          if (choice.delta.content) yield { type: "text-delta", delta: choice.delta.content as string };
          if (choice.finish_reason != null) {
            if (typeof choice.finish_reason !== "string") throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
            finished = true;
          }
        }
        if (buffer.length > 256 * 1024) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
      }
    } catch (error) { throw this.normalize(error, combined); }
    finally { controller.abort(); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  }
}
function usageNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED");
  const reader = response.body.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED"); chunks.push(chunk.value); }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new GatewayFailure("GATEWAY_RESPONSE", "COMMITTED"); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
