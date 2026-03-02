import { NextResponse } from "next/server";
import {
  getActionJob,
  getLatestActionJob,
  startActionJob,
} from "@/lib/jobs/action-job";
import {
  getManualMergeFilePath,
  getPlayerRegistrySnapshot,
} from "@/lib/players/registry";
import { toProjectRelative } from "@/lib/paths";

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

    const [registry, manualPath] = await Promise.all([
      getPlayerRegistrySnapshot(),
      getManualMergeFilePath(),
    ]);

    return NextResponse.json({
      ok: true,
      registry,
      manualMergeFile: toProjectRelative(manualPath),
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

export async function POST() {
  try {
    const { alreadyRunning, status } = startActionJob("players-registry", {});

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
