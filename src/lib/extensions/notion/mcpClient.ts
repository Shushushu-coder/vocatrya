import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NOTION_MCP_URL, NOTION_REMOTE_CALL_TIMEOUT_MS } from "./constants";
import { NOTION_ERROR, NotionError } from "./errors";

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
};

export type NotionMcpClientFactory = (
  accessToken: string,
) => Promise<NotionMcpClientLike>;

async function sdkClientFactory(
  accessToken: string,
): Promise<NotionMcpClientLike> {
  const transport = new StreamableHTTPClientTransport(new URL(NOTION_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "vocatrya", version: "0.1.0" });
  await client.connect(transport);
  return client as unknown as NotionMcpClientLike;
}

let clientFactory: NotionMcpClientFactory = sdkClientFactory;

/** Test seam — production never replaces the factory. */
export function setNotionMcpClientFactory(factory: NotionMcpClientFactory) {
  clientFactory = factory;
}

export function mapNotionRemoteError(error: unknown): NotionError {
  if (error instanceof NotionError) return error;
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) {
      return new NotionError(NOTION_ERROR.REAUTH_REQUIRED);
    }
    if (error.code === 403) {
      return new NotionError(NOTION_ERROR.PERMISSION_DENIED);
    }
    if (error.code === 429) {
      return new NotionError(NOTION_ERROR.RATE_LIMITED, { retryable: true });
    }
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
    throw mapNotionRemoteError(error);
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
