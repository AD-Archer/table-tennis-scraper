import { NextResponse } from "next/server";
import {
  getCleanScrapeJob,
  getLatestCleanScrapeJob,
  startCleanScrapeJob,
} from "@/lib/scrapers/clean-job";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim();

    const status = jobId ? getCleanScrapeJob(jobId) : getLatestCleanScrapeJob();
    return NextResponse.json({
      ok: true,
      status: status ?? null,
      message: status
        ? undefined
        : jobId
          ? `No clean scrape job found for jobId=${jobId}`
          : "No clean scrape job has been started yet.",
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

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ttblStartYear?: number;
      ttblEndYear?: number;
      ttblNumGamedays?: number;
      wttStartYear?: number;
      wttEndYear?: number;
      wttPageSize?: number;
      wttMaxPages?: number;
      delayMs?: number;
    };

    const options = {
      ttblStartYear: body.ttblStartYear,
      ttblEndYear: body.ttblEndYear,
      ttblNumGamedays: body.ttblNumGamedays,
      wttStartYear: body.wttStartYear,
      wttEndYear: body.wttEndYear,
      wttPageSize: body.wttPageSize,
      wttMaxPages: body.wttMaxPages,
      delayMs: body.delayMs,
    };

    const { alreadyRunning, status } = startCleanScrapeJob(options);

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
