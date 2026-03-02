import { NextResponse } from "next/server";
import {
  getActionJob,
  getLatestActionJob,
  startActionJob,
} from "@/lib/jobs/action-job";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      startYear?: number;
      endYear?: number;
      pageSize?: number;
      maxPages?: number;
      delayMs?: number;
      tournamentScope?: "wtt_only" | "all";
      eventScope?: "singles_only" | "all";
      includeYouth?: boolean;
      profileEnrichMaxPlayers?: number;
      profileEnrichMinMatches?: number;
    };

    const { alreadyRunning, status } = startActionJob("wtt-all-time", {
      startYear: body.startYear,
      endYear: body.endYear,
      pageSize: body.pageSize,
      maxPages: body.maxPages,
      delayMs: body.delayMs,
      tournamentScope: body.tournamentScope ?? "all",
      eventScope: body.eventScope ?? "singles_only",
      includeYouth: body.includeYouth ?? false,
      profileEnrichMaxPlayers: body.profileEnrichMaxPlayers ?? 0,
      profileEnrichMinMatches: body.profileEnrichMinMatches ?? 3,
    });

    return NextResponse.json({
      ok: true,
      alreadyRunning,
      jobId: status.jobId,
      status,
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim();
    const status = jobId ? getActionJob(jobId) : getLatestActionJob("wtt-all-time");

    return NextResponse.json({
      ok: true,
      status: status ?? null,
      message: status
        ? undefined
        : jobId
          ? `No WTT all-time scrape job found for jobId=${jobId}`
          : "No WTT all-time scrape job has been started yet.",
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
