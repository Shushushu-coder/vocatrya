import { ManagedError, type ManagedInvocation, type ManagedStreamEvent, type ManagedTextResult } from "../../../src/lib/ai/managed-contract";
import { provenance, type ManagedAiBinding } from "./store";

export const VERIFIED_GATEWAY_CAPABILITIES = { text: true, streaming: true, structuredOutput: true, tools: false };
export interface GatewayConfig { baseUrl: string; apiKey: string; timeoutMs?: number; allowLoopbackForTests?: boolean }
type GatewayPayload = { model?: unknown; choices?: { message?: { content?: unknown }; delta?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
export class ManagedGatewayRuntime {
  private readonly url: string;
  constructor(private readonly config: GatewayConfig, private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(config.baseUrl);
    if ((url.protocol !== "https:" && !(config.allowLoopbackForTests && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !config.apiKey.trim()) throw new Error("Invalid hosted gateway configuration");
    this.url = `${url.toString().replace(/\/$/, "")}/chat/completions`;
  }
  private actualModel(payload: GatewayPayload, binding: ManagedAiBinding): void {
    if (typeof payload.model !== "string" || ![binding.upstreamModelId, ...binding.allowedModelAliases].includes(payload.model)) throw new ManagedError("GATEWAY_RESPONSE");
  }
  private async request(binding: ManagedAiBinding, input: ManagedInvocation, stream: boolean, signal: AbortSignal): Promise<Response> {
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: binding.upstreamModelId, messages: [{ role: "user", content: input.prompt }], stream, max_tokens: binding.maxOutputTokens }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ManagedError(response.status === 401 || response.status === 403 ? "GATEWAY_AUTH" : response.status === 429 ? "GATEWAY_RATE_LIMIT" : "GATEWAY_RESPONSE");
      }
      return response;
    } catch (error) { throw this.normalize(error, signal); }
  }
  private normalize(error: unknown, signal: AbortSignal): ManagedError {
    if (error instanceof ManagedError) return error;
    if (signal.aborted) return new ManagedError(signal.reason?.name === "TimeoutError" ? "GATEWAY_TIMEOUT" : "GATEWAY_NETWORK");
    return new ManagedError("GATEWAY_NETWORK");
  }
  async generateText(binding: ManagedAiBinding, input: ManagedInvocation, signal?: AbortSignal): Promise<ManagedTextResult> {
    const combined = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs ?? 120_000), ...(signal ? [signal] : [])]);
    try {
      const response = await this.request(binding, input, false, combined);
      const raw = await readBounded(response, 4 * 1024 * 1024);
      let payload: GatewayPayload;
      try { payload = JSON.parse(raw); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
      if (!payload || typeof payload !== "object") throw new ManagedError("GATEWAY_RESPONSE");
      this.actualModel(payload, binding);
      if (!Array.isArray(payload.choices) || payload.choices.length !== 1) throw new ManagedError("GATEWAY_RESPONSE");
      const choice = payload.choices?.[0];
      if (typeof choice?.message?.content !== "string" || typeof choice.finish_reason !== "string") throw new ManagedError("GATEWAY_RESPONSE");
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
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) throw new ManagedError("GATEWAY_RESPONSE");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "", finished = false, total = 0;
      while (true) {
        const chunk = await reader.read();
        if (combined.aborted) throw this.normalize(null, combined);
        if (chunk.done) throw new ManagedError("GATEWAY_RESPONSE");
        total += chunk.value.byteLength;
        if (total > 4 * 1024 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
        try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          if (combined.aborted) throw this.normalize(null, combined);
          const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          if (data === "[DONE]") {
            if (!finished || buffer.trim()) throw new ManagedError("GATEWAY_RESPONSE");
            yield { type: "completed", model: binding.modelKey, provenance: provenance(binding) };
            return;
          }
          let payload: GatewayPayload;
          try { payload = JSON.parse(data); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
          if (!payload || typeof payload !== "object") throw new ManagedError("GATEWAY_RESPONSE");
          this.actualModel(payload, binding);
          if (!Array.isArray(payload.choices) || payload.choices.length !== 1) throw new ManagedError("GATEWAY_RESPONSE");
          const choice = payload.choices?.[0];
          if (!choice || !choice.delta || typeof choice.delta !== "object" || (choice.delta.content != null && typeof choice.delta.content !== "string")) throw new ManagedError("GATEWAY_RESPONSE");
          if (finished) throw new ManagedError("GATEWAY_RESPONSE");
          if (choice.delta.content) yield { type: "text-delta", delta: choice.delta.content as string };
          if (choice.finish_reason != null) {
            if (typeof choice.finish_reason !== "string") throw new ManagedError("GATEWAY_RESPONSE");
            finished = true;
          }
        }
        if (buffer.length > 256 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
      }
    } catch (error) { throw this.normalize(error, combined); }
    finally { controller.abort(); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  }
}
function usageNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new ManagedError("GATEWAY_RESPONSE");
  const reader = response.body.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) throw new ManagedError("GATEWAY_RESPONSE"); chunks.push(chunk.value); }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
