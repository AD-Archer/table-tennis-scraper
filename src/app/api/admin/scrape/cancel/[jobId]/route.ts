import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";
import { cancelActionJob } from "@/lib/jobs/action-job";

/**
 * POST /api/admin/scrape/cancel/[jobId]
 * Cancels an active scraping job
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status ?? 401 },
    );
  }

  const { jobId } = await params;
  const reason = "Cancelled by admin console user action";

  const result = cancelActionJob(jobId, reason);

  if (!result.found) {
    return NextResponse.json(
      { ok: false, error: `Job not found: ${jobId}` },
      { status: 404 },
    );
  }

  if (result.alreadyTerminal) {
    return NextResponse.json(
      { ok: false, error: "Job is already completed or failed" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: `Job ${jobId} cancelled`,
    jobState: result.status?.state,
  });
}
