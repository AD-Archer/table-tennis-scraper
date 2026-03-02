import { NextResponse } from "next/server";
import { pingSpindex } from "@/lib/spindex/client";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const apiBaseUrl = url.searchParams.get("apiBaseUrl") ?? undefined;

    const report = await pingSpindex({ apiBaseUrl });

    return NextResponse.json(
      {
        ok: report.ok,
        report,
      },
      { status: report.ok ? 200 : 502 },
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
