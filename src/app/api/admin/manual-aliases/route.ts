import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";
import {
  deleteManualAlias,
  listManualAliases,
  upsertManualAlias,
} from "@/lib/admin/manual-aliases";
import { startActionJob } from "@/lib/jobs/action-job";

export const dynamic = "force-dynamic";

function parseLimit(raw: string | null, fallback = 600): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(1200, parsed));
}

export async function GET(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status ?? 401 });
  }

  try {
    const url = new URL(request.url);
    const aliases = await listManualAliases(parseLimit(url.searchParams.get("limit"), 600));
    return NextResponse.json({
      ok: true,
      aliases,
      count: aliases.length,
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
      key?: string;
      canonicalKey?: string;
      rebuildRegistry?: boolean;
      strict?: boolean;
    };

    const key = body.key?.trim() ?? "";
    const canonicalKey = body.canonicalKey?.trim() ?? "";
    if (!key || !canonicalKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide key and canonicalKey.",
        },
        { status: 400 },
      );
    }
    if (key === canonicalKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "Alias key and canonical key must differ.",
        },
        { status: 400 },
      );
    }

    const alias = await upsertManualAlias(key, canonicalKey);
    const shouldRebuild = body.rebuildRegistry !== false;
    const rebuild = shouldRebuild
      ? startActionJob("players-registry", {
          failOnUnresolvedCandidates: body.strict === true,
          backgroundReason: "admin-manual-alias-update",
        })
      : null;

    return NextResponse.json({
      ok: true,
      alias,
      rebuild: rebuild
        ? {
            alreadyRunning: rebuild.alreadyRunning,
            jobId: rebuild.status.jobId,
            status: rebuild.status.state,
          }
        : null,
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
    const body = (await request.json().catch(() => ({}))) as {
      key?: string;
      rebuildRegistry?: boolean;
    };
    const key = body.key?.trim() ?? "";
    if (!key) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide key.",
        },
        { status: 400 },
      );
    }

    await deleteManualAlias(key);

    const shouldRebuild = body.rebuildRegistry !== false;
    const rebuild = shouldRebuild
      ? startActionJob("players-registry", {
          failOnUnresolvedCandidates: false,
          backgroundReason: "admin-manual-alias-delete",
        })
      : null;

    return NextResponse.json({
      ok: true,
      key,
      deletedAt: new Date().toISOString(),
      rebuild: rebuild
        ? {
            alreadyRunning: rebuild.alreadyRunning,
            jobId: rebuild.status.jobId,
            status: rebuild.status.state,
          }
        : null,
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
