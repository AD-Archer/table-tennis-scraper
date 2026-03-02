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
      numGamedays?: number;
      delayMs?: number;
    };

    const nowYear = new Date().getUTCFullYear();
    const { alreadyRunning, status } = startActionJob("ttbl-all-time", {
      startYear: body.startYear ?? 1995,
      endYear: body.endYear ?? nowYear + 1,
      numGamedays: body.numGamedays,
      delayMs: body.delayMs ?? 120,
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
    const status = jobId ? getActionJob(jobId) : getLatestActionJob("ttbl-all-time");

    return NextResponse.json({
      ok: true,
      status: status ?? null,
      message: status
        ? undefined
        : jobId
          ? `No TTBL all-time scrape job found for jobId=${jobId}`
          : "No TTBL all-time scrape job has been started yet.",
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
