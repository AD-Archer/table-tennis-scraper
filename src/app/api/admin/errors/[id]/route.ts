import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";
import {
  deleteAdminErrorLog,
  updateAdminErrorLog,
} from "@/lib/admin/error-log";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

function parseStatus(raw: unknown): "open" | "resolved" | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "open" || value === "resolved") {
    return value;
  }
  return null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      status?: string;
      resolutionNote?: string | null;
    };
    const params = await context.params;
    const status = parseStatus(body.status);
    const resolutionNote =
      body.resolutionNote === null
        ? null
        : typeof body.resolutionNote === "string"
          ? body.resolutionNote.trim()
          : undefined;

    if (!status && resolutionNote === undefined) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide status and/or resolutionNote.",
        },
        { status: 400 },
      );
    }

    const entry = await updateAdminErrorLog(params.id, {
      status: status ?? undefined,
      resolutionNote,
    });

    return NextResponse.json({
      ok: true,
      entry,
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

export async function DELETE(request: Request, context: RouteContext) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const params = await context.params;
    await deleteAdminErrorLog(params.id);
    return NextResponse.json({
      ok: true,
      id: params.id,
      deletedAt: new Date().toISOString(),
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
