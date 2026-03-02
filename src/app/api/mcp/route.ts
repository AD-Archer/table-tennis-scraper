import { NextResponse } from "next/server";
import { getMCPToolCatalog, handleMCPRequest } from "@/lib/mcp/server";
import {
  ActionJobType,
  cancelActionJob,
  cancelActiveActionJobs,
  cancelScheduledFollowups,
} from "@/lib/jobs/action-job";

export const dynamic = "force-dynamic";
const DEFAULT_MCP_SESSION_ID = "ttbl-local-dev-session";
const ACTION_JOB_TYPES: ActionJobType[] = [
  "ttbl",
  "ttbl-legacy",
  "ttbl-all-time",
  "wtt",
  "wtt-all-time",
  "players-registry",
  "destroy-data",
];

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseActionJobType(value: string | null): ActionJobType | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim() as ActionJobType;
  return ACTION_JOB_TYPES.includes(trimmed) ? trimmed : null;
}

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

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const cancel = parseBoolean(url.searchParams.get("cancel"), false);
  if (!cancel) {
    return NextResponse.json(
      {
        ok: false,
        error: "Cancellation requires explicit confirmation. Use DELETE /api/mcp?cancel=1.",
      },
      { status: 400 },
    );
  }

  const jobId = url.searchParams.get("jobId")?.trim() ?? "";
  const type = parseActionJobType(url.searchParams.get("target"));
  const includeQueued = parseBoolean(url.searchParams.get("includeQueued"), true);
  const clearFollowups = parseBoolean(url.searchParams.get("clearFollowups"), true);
  const reason = url.searchParams.get("reason")?.trim() || "Cancelled from /api/mcp DELETE.";

  const single = jobId ? cancelActionJob(jobId, reason) : null;
  const cancelled = jobId
    ? null
    : cancelActiveActionJobs({
        type: type ?? undefined,
        includeQueued,
        reason,
      });
  const followupTarget =
    type === "ttbl" || type === "ttbl-legacy" || type === "ttbl-all-time"
      ? "ttbl"
      : type === "wtt" || type === "wtt-all-time"
        ? "wtt"
        : "all";
  const followups = clearFollowups ? cancelScheduledFollowups(followupTarget) : null;

  return NextResponse.json({
    ok: true,
    cancelledAt: new Date().toISOString(),
    requested: {
      jobId: jobId || null,
      target: type ?? null,
      includeQueued,
      clearFollowups,
      reason,
    },
    single,
    cancelled,
    followups,
  });
}
