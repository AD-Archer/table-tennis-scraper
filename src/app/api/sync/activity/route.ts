import { NextResponse } from "next/server";
import { listSyncActivityEntries } from "@/lib/sync/activity-log";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "400", 10);
    const entries = await listSyncActivityEntries(
      Number.isFinite(limit) ? limit : 400,
    );

    return NextResponse.json({
      ok: true,
      entries,
      count: entries.length,
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
