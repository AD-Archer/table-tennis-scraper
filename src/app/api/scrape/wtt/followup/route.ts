import { NextResponse } from "next/server";
import {
  getWTTFollowupStatus,
  scheduleWTTFollowupInBackground,
} from "@/lib/jobs/action-job";

function parseYears(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((year) => Number.parseInt(String(year), 10))
      .filter((year) => Number.isFinite(year));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((year) => Number.parseInt(year.trim(), 10))
      .filter((year) => Number.isFinite(year));
  }

  return [];
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    followup: getWTTFollowupStatus(),
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      years?: number[] | string;
      delayMs?: number;
      pageSize?: number;
      maxPages?: number;
      maxEventsPerYear?: number;
      eventScope?: "singles_only" | "all";
      includeYouth?: boolean;
      reason?: string;
    };

    const years = parseYears(body.years);
    const followup = scheduleWTTFollowupInBackground({
      years: years.length > 0 ? years : undefined,
      delayMs: body.delayMs,
      pageSize: body.pageSize,
      maxPages: body.maxPages,
      maxEventsPerYear: body.maxEventsPerYear,
      eventScope: body.eventScope ?? "singles_only",
      includeYouth: body.includeYouth ?? true,
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
