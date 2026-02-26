import { NextResponse } from "next/server";
import { syncResultsToSpindex } from "@/lib/spindex/client";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      apiBaseUrl?: string;
      apiPath?: string;
      authToken?: string;
      dryRun?: boolean;
      eventName?: string;
      batchSize?: number;
    };

    const report = await syncResultsToSpindex(body);

    return NextResponse.json({ ok: true, report });
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
