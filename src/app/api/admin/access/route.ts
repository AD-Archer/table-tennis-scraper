import { NextResponse } from "next/server";
import { assertAdminConsoleAccess } from "@/lib/admin/access";

export async function GET(request: Request): Promise<NextResponse> {
  const access = assertAdminConsoleAccess(request);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error },
      { status: access.status ?? 403 },
    );
  }

  return NextResponse.json({ ok: true });
}
