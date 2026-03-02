import { NextResponse } from "next/server";
import {
  getTTBLFollowupStatus,
  scheduleTTBLFollowupInBackground,
} from "@/lib/jobs/action-job";

function parseSeason(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const seasonMatch = raw.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (seasonMatch?.[1] && seasonMatch[2]) {
    const start = Number.parseInt(seasonMatch[1], 10);
    const end = Number.parseInt(seasonMatch[2], 10);
    if (Number.isFinite(start) && Number.isFinite(end) && end === start + 1) {
      return `${start}-${end}`;
    }
  }

  const yearMatch = raw.match(/^(\d{4})$/);
  if (yearMatch?.[1]) {
    const start = Number.parseInt(yearMatch[1], 10);
    if (Number.isFinite(start)) {
      return `${start}-${start + 1}`;
    }
  }

  return null;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    followup: getTTBLFollowupStatus(),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      season?: string;
      delayMs?: number;
      numGamedays?: number;
      includeYouth?: boolean;
      reason?: string;
    };

    const followup = scheduleTTBLFollowupInBackground({
      season: parseSeason(body.season) ?? undefined,
      delayMs: body.delayMs,
      numGamedays: body.numGamedays,
      includeYouth: body.includeYouth ?? false,
      reason: body.reason ?? "manual-api-trigger",
    });

    return NextResponse.json({
      ok: true,
      followup,
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
