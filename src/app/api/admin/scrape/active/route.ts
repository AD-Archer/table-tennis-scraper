import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";
import { getActiveActionJobs } from "@/lib/jobs/action-job";
import {
  getWTTFollowupStatus,
  getTTBLFollowupStatus,
} from "@/lib/jobs/action-job";

/**
 * GET /api/admin/scrape/active
 * Returns active scraping jobs (queued and running only, not scheduled)
 */
export async function GET(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status ?? 401 },
    );
  }

  const activeJobs = getActiveActionJobs().filter((job) =>
    ["ttbl", "ttbl-legacy", "ttbl-all-time", "wtt", "wtt-all-time"].includes(
      job.type,
    ),
  );

  const ttblFollowup = getTTBLFollowupStatus();
  const wttFollowup = getWTTFollowupStatus();

  return NextResponse.json({
    ok: true,
    activeJobs: activeJobs.map((job) => ({
      jobId: job.jobId,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      progress: {
        totalLogs: job.logs.length,
        recentLogs: job.logs.slice(-5),
      },
    })),
    scheduled: {
      ttbl: ttblFollowup,
      wtt: wttFollowup,
    },
  });
}
