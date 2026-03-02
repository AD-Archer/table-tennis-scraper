import { NextResponse } from "next/server";
import { SpindexUpdateOptions, syncPlayersToSpindex } from "@/lib/spindex/client";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as SpindexUpdateOptions;
    const report = await syncPlayersToSpindex(body);
    const ok = report.failedBatches === 0;

    return NextResponse.json(
      {
        ok,
        report,
      },
      { status: ok ? 200 : 502 },
    );
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
