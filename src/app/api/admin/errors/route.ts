import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";
import {
  clearResolvedAdminErrorLogs,
  listAdminErrorLogs,
  logAdminError,
  parseAdminErrorCategory,
  parseAdminErrorStatus,
} from "@/lib/admin/error-log";

export const dynamic = "force-dynamic";

function parseLimit(raw: string | null, fallback = 120): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(500, parsed));
}

function parseCategory(raw: unknown): "scrape" | "merge" | "system" {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "merge") {
    return "merge";
  }
  if (value === "system") {
    return "system";
  }
  return "scrape";
}

export async function GET(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const url = new URL(request.url);
    const entries = await listAdminErrorLogs({
      limit: parseLimit(url.searchParams.get("limit"), 120),
      status: parseAdminErrorStatus(url.searchParams.get("status")),
      category: parseAdminErrorCategory(url.searchParams.get("category")),
      query: url.searchParams.get("q")?.trim() ?? "",
    });

    const openCount = entries.reduce((sum, row) => sum + (row.status === "open" ? 1 : 0), 0);
    return NextResponse.json({
      ok: true,
      entries,
      count: entries.length,
      openCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      category?: string;
      source?: string;
      operation?: string;
      message?: string;
      details?: Record<string, unknown>;
    };

    const action = body.action?.trim().toLowerCase();
    if (action !== "simulate") {
      return NextResponse.json(
        {
          ok: false,
          error: "Unsupported action. Use action=simulate.",
        },
        { status: 400 },
      );
    }

    const category = parseCategory(body.category ?? "scrape");
    const source =
      typeof body.source === "string" && body.source.trim().length > 0
        ? body.source.trim()
        : category === "merge"
          ? "players-registry"
          : "scraper";
    const operation =
      typeof body.operation === "string" && body.operation.trim().length > 0
        ? body.operation.trim()
        : category === "merge"
          ? "admin-simulated-merge-failure"
          : "admin-simulated-scrape-failure";
    const message =
      typeof body.message === "string" && body.message.trim().length > 0
        ? body.message.trim()
        : category === "merge"
          ? "Simulated merge error from admin console."
          : "Simulated scrape error from admin console.";

    const entry = await logAdminError({
      category,
      source,
      operation,
      message,
      details: {
        simulated: true,
        simulatedAt: new Date().toISOString(),
        ...((body.details ?? {}) as Record<string, unknown>),
      },
      error: new Error(message),
    });

    return NextResponse.json({
      ok: true,
      entry,
      simulated: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode")?.trim().toLowerCase() ?? "resolved";
    if (mode !== "resolved") {
      return NextResponse.json(
        {
          ok: false,
          error: "Only mode=resolved is supported.",
        },
        { status: 400 },
      );
    }

    const deleted = await clearResolvedAdminErrorLogs();
    return NextResponse.json({
      ok: true,
      mode,
      deleted,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 },
    );
  }
}
