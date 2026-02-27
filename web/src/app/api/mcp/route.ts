import { NextResponse } from "next/server";
import { getMCPToolCatalog, handleMCPRequest } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
const DEFAULT_MCP_SESSION_ID = "ttbl-local-dev-session";

export async function GET() {
  return NextResponse.json({
    ok: true,
    transport: "json-rpc-2.0",
    protocol: "mcp",
    endpoint: "/api/mcp",
    methods: [
      "initialize",
      "ping",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/templates/list",
      "notifications/initialized",
    ],
    tools: getMCPToolCatalog(),
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const response = await handleMCPRequest(body);
    const incomingSessionId = request.headers.get("mcp-session-id");
    const sessionId =
      typeof incomingSessionId === "string" && incomingSessionId.trim().length > 0
        ? incomingSessionId
        : DEFAULT_MCP_SESSION_ID;
    const sessionHeaders = {
      "mcp-session-id": sessionId,
    };

    if (response === null) {
      return new Response(null, { status: 202, headers: sessionHeaders });
    }

    return NextResponse.json(response, { headers: sessionHeaders });
  } catch (error) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
          data: error instanceof Error ? error.message : "unknown error",
        },
      },
      { status: 400 },
    );
  }
}
