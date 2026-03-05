import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";
import { cancelScheduledFollowups } from "@/lib/jobs/action-job";

/**
 * POST /api/admin/scrape/cancel-scheduled
 * Cancels all scheduled followup scraping jobs
 */
export async function POST(request: Request) {
  const auth = assertAdminConsoleAccess(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status ?? 401 },
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      target?: "ttbl" | "wtt" | "all";
    };
    const target = body.target ?? "all";

    const result = cancelScheduledFollowups(target);

    return NextResponse.json({
      ok: true,
      message: `Cancelled scheduled followups for: ${target}`,
      cancelledTimers: result.cancelledTimers,
      ttblStatus: result.ttbl,
      wttStatus: result.wtt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
