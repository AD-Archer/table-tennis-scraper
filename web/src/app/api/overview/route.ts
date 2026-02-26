import { NextResponse } from "next/server";
import { getDashboardOverview } from "@/lib/overview";

export async function GET() {
  try {
    const overview = await getDashboardOverview();
    return NextResponse.json({ ok: true, overview });
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
