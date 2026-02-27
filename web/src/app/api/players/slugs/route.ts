import { NextResponse } from "next/server";
import { getPlayerSlugOverview } from "@/lib/players/slugs";

export async function GET() {
  try {
    const overview = await getPlayerSlugOverview();
    return NextResponse.json({
      ok: true,
      overview,
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
