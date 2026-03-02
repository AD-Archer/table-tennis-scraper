import { NextResponse } from "next/server";
import {
  getActionJob,
  getLatestActionJob,
  startActionJob,
} from "@/lib/jobs/action-job";

export async function POST() {
  try {
    const { alreadyRunning, status } = startActionJob("destroy-data", {});

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
    const status = jobId ? getActionJob(jobId) : getLatestActionJob("destroy-data");

    return NextResponse.json({
      ok: true,
      status: status ?? null,
      message: status
        ? undefined
        : jobId
          ? `No destroy-data job found for jobId=${jobId}`
          : "No destroy-data job has been started yet.",
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
