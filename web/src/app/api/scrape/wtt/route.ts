import { NextResponse } from "next/server";
import {
  getActionJob,
  getLatestActionJob,
  startActionJob,
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

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      years?: number[] | string;
      pageSize?: number;
      maxPages?: number;
      delayMs?: number;
    };

    const years = parseYears(body.years);
    const { alreadyRunning, status } = startActionJob("wtt", {
      years,
      pageSize: body.pageSize,
      maxPages: body.maxPages,
      delayMs: body.delayMs,
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
    const status = jobId ? getActionJob(jobId) : getLatestActionJob("wtt");

    return NextResponse.json({
      ok: true,
      status: status ?? null,
      message: status
        ? undefined
        : jobId
          ? `No WTT scrape job found for jobId=${jobId}`
          : "No WTT scrape job has been started yet.",
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
