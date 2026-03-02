import { NextResponse } from "next/server";
import { checkPlayersAgainstSpindex, SpindexCheckOptions } from "@/lib/spindex/client";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as SpindexCheckOptions;
    const report = await checkPlayersAgainstSpindex(body);

    return NextResponse.json({
      ok: true,
      report,
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
