import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  executeNativeBusinessToolCall,
  findNativeBusinessTool,
  NATIVE_BUSINESS_MCP_SERVER_KEY,
  resolveNativeBusinessTicket,
  type NativeBusinessTicketRecord,
} from "@/lib/agent/nativeBusinessMcp.server";

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !/^Bearer\s+\S+$/i.test(header.trim())) return null;
  return header.trim().slice(7);
}

function buildServer(record: NativeBusinessTicketRecord): McpServer {
  const server = new McpServer(
    { name: NATIVE_BUSINESS_MCP_SERVER_KEY, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  for (const name of record.allowedTools) {
    const definition = findNativeBusinessTool(record, name);
    if (!definition) continue;
    server.registerTool(
      name,
      {
        description: definition.description,
        ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
      },
      async (args: unknown) => {
        const result = await executeNativeBusinessToolCall({ record, name, args });
        if (!result.ok) {
          return { isError: true, content: [{ type: "text" as const, text: result.error }] };
        }
        return { content: result.content };
      },
    );
  }
  return server;
}

/**
 * Loopback MCP bridge for the spawned Codex process. The only credential is
 * the per-turn bearer ticket — intentionally NOT gated on the desktop
 * internal token, which Codex never sees. Ticket resolution already enforces
 * the turn binding; tool calls re-check ownership and the allowlist again.
 */
async function handler(request: Request): Promise<Response> {
  const record = resolveNativeBusinessTicket(bearerToken(request));
  if (!record) {
    return new Response(JSON.stringify({ error: "invalid or expired ticket" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const server = buildServer(record);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode — ticket carries the turn binding
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}

async function getHandler(): Promise<Response> {
  return new Response("Method Not Allowed", { status: 405 });
}

export { getHandler as GET, handler as POST, handler as DELETE };
