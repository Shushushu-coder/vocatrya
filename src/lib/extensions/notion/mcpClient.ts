import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NOTION_MCP_URL, NOTION_REMOTE_CALL_TIMEOUT_MS } from "./constants";
import { NOTION_ERROR, NotionError, type NotionErrorCode } from "./errors";

export type RemoteToolInfo = { name: string; inputSchema?: unknown };

export type NotionToolCallResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Narrowed view of the SDK client used by the extension — injectable. */
export type NotionMcpClientLike = {
  listTools(): Promise<{ tools: RemoteToolInfo[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<NotionToolCallResult>;
  close(): Promise<void>;
  /** Retry-After (ms) seen on the last 429 response, if the transport saw one. */
  retryAfterMs?(): number | undefined;
};

export type NotionMcpClientFactory = (
  accessToken: string,
) => Promise<NotionMcpClientLike>;

async function sdkClientFactory(
  accessToken: string,
): Promise<NotionMcpClientLike> {
  // The SDK's StreamableHTTPError drops response headers, so observe 429
  // Retry-After at the fetch layer (per client — no shared state).
  let retryAfterMs: number | undefined;
  const observingFetch: FetchLike = async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 429) {
      retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    }
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL(NOTION_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    fetch: observingFetch,
  });
  const client = new Client({ name: "vocatrya", version: "0.1.0" });
  await client.connect(transport);
  return Object.assign(client as unknown as NotionMcpClientLike, {
    retryAfterMs: () => retryAfterMs,
  });
}

/** Retry-After as delta-seconds or an HTTP-date → ms; undefined if unusable. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const NOT_FOUND_OR_UNSHARED = new Set(["object_not_found", "restricted_resource"]);

/**
 * Classify a tool-level `isError` result. Notion reports a missing page and a
 * page not shared with the integration as tool errors carrying the Notion
 * error code (JSON `{code}` / `{error:{code}}` or plain text). Anything else
 * stays `fallback` (callers keep their previous code).
 */
export function classifyNotionToolError(
  result: NotionToolCallResult,
  fallback: NotionErrorCode,
): NotionErrorCode {
  const text = remoteToolText(result);
  const candidates: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const body = parsed as { code?: unknown; error?: unknown };
      candidates.push(body.code);
      if (body.error && typeof body.error === "object") {
        candidates.push((body.error as { code?: unknown }).code);
      }
    }
  } catch {
    // plain text — handled below
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === "object") {
    candidates.push((structured as { code?: unknown }).code);
  }
  if (
    candidates.some((c) => typeof c === "string" && NOT_FOUND_OR_UNSHARED.has(c)) ||
    /\b(object_not_found|restricted_resource)\b/.test(text)
  ) {
    return NOTION_ERROR.OBJECT_NOT_FOUND;
  }
  return fallback;
}

let clientFactory: NotionMcpClientFactory = sdkClientFactory;

/** Test seam — production never replaces the factory. */
export function setNotionMcpClientFactory(factory: NotionMcpClientFactory) {
  clientFactory = factory;
}

export function mapNotionRemoteError(
  error: unknown,
  hints?: { retryAfterMs?: number },
): NotionError {
  if (error instanceof NotionError) return error;
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) {
      return new NotionError(NOTION_ERROR.REAUTH_REQUIRED);
    }
    if (error.code === 403) {
      return new NotionError(NOTION_ERROR.PERMISSION_DENIED);
    }
    if (error.code === 429) {
      return new NotionError(NOTION_ERROR.RATE_LIMITED, {
        retryable: true,
        retryAfterMs: hints?.retryAfterMs,
      });
    }
    // HTTP 404 from the MCP endpoint means an expired session or wrong
    // endpoint (Streamable HTTP), not a missing page: keep it REMOTE_FAILED.
    // Missing/unshared pages arrive as tool-level errors (classifyNotionToolError).
    if (error.code !== undefined && error.code >= 500) {
      return new NotionError(NOTION_ERROR.OUTCOME_UNKNOWN, {
        retryable: true,
      });
    }
    return new NotionError(NOTION_ERROR.REMOTE_FAILED);
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return new NotionError(NOTION_ERROR.OUTCOME_UNKNOWN, {
        retryable: true,
      });
    }
    // DNS/TLS/refused reachability — the request never provably landed, so
    // for writes the outcome is unknown rather than a clean failure.
    return new NotionError(NOTION_ERROR.NETWORK, {
      message: "network failure",
      retryable: true,
    });
  }
  return new NotionError(NOTION_ERROR.REMOTE_FAILED);
}

export async function withNotionClient<T>(
  accessToken: string,
  run: (client: NotionMcpClientLike) => Promise<T>,
): Promise<T> {
  let client: NotionMcpClientLike;
  try {
    client = await clientFactory(accessToken);
  } catch (error) {
    throw mapNotionRemoteError(error);
  }
  try {
    return await run(client);
  } catch (error) {
    throw mapNotionRemoteError(error, { retryAfterMs: client.retryAfterMs?.() });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listNotionRemoteTools(
  accessToken: string,
): Promise<RemoteToolInfo[]> {
  return withNotionClient(accessToken, async (client) => {
    const listed = await client.listTools();
    return listed.tools;
  });
}

export async function callNotionRemoteTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<NotionToolCallResult> {
  return withNotionClient(accessToken, async (client) => {
    const signal =
      options?.signal !== undefined
        ? AbortSignal.any([
            options.signal,
            AbortSignal.timeout(NOTION_REMOTE_CALL_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(NOTION_REMOTE_CALL_TIMEOUT_MS);
    return client.callTool(
      { name, arguments: args },
      undefined,
      { signal, timeout: NOTION_REMOTE_CALL_TIMEOUT_MS },
    );
  });
}

/** Plain-text extraction from a CallToolResult's content blocks. */
export function remoteToolText(result: NotionToolCallResult): string {
  return result.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}
