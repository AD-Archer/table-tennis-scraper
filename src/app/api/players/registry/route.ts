import { NextResponse } from "next/server";
import {
  getActionJob,
  getLatestActionJob,
  startActionJob,
} from "@/lib/jobs/action-job";
import {
  getPlayerRegistrySnapshot,
} from "@/lib/players/registry";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim();
    const statusMode = url.searchParams.get("status")?.trim() === "1";

    if (jobId || statusMode) {
      const status = jobId
        ? getActionJob(jobId)
        : getLatestActionJob("players-registry");
      return NextResponse.json({
        ok: true,
        status: status ?? null,
        message: status
          ? undefined
          : jobId
            ? `No player registry job found for jobId=${jobId}`
            : "No player registry job has been started yet.",
      });
    }

    const registry = await getPlayerRegistrySnapshot();

    return NextResponse.json({
      ok: true,
      registry,
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
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const failOnUnresolvedCandidates = body.strict === true || body.failOnUnresolvedCandidates === true;
    const backgroundReason =
      typeof body.backgroundReason === "string" && body.backgroundReason.trim().length > 0
        ? body.backgroundReason.trim()
        : undefined;
    const backgroundSourceJobId =
      typeof body.backgroundSourceJobId === "string" && body.backgroundSourceJobId.trim().length > 0
        ? body.backgroundSourceJobId.trim()
        : undefined;

    const { alreadyRunning, status } = startActionJob("players-registry", {
      failOnUnresolvedCandidates,
      backgroundReason,
      backgroundSourceJobId,
    });

    return NextResponse.json({
      ok: true,
      alreadyRunning,
      jobId: status.jobId,
      status,
      strict: failOnUnresolvedCandidates,
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
