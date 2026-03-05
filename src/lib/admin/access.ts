import { timingSafeEqual } from "node:crypto";

export interface AdminAccessCheckResult {
  ok: boolean;
  status?: number;
  error?: string;
}

function getConfiguredAdminPassword(): string {
  return (
    process.env.ADMIN_CONSOLE_PASSWORD?.trim() ??
    process.env.MASTER_SYNC_PASSWORD?.trim() ??
    ""
  );
}

function secureCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function assertAdminConsoleAccess(request: Request): AdminAccessCheckResult {
  const configured = getConfiguredAdminPassword();
  if (!configured) {
    return {
      ok: false,
      status: 503,
      error: "Admin console is not configured. Set ADMIN_CONSOLE_PASSWORD.",
    };
  }

  const provided = request.headers.get("x-admin-console-password")?.trim() ?? "";
  if (!provided) {
    return {
      ok: false,
      status: 401,
      error: "Admin console password missing (x-admin-console-password).",
    };
  }

  if (!secureCompare(provided, configured)) {
    return {
      ok: false,
      status: 403,
      error: "Invalid admin console password.",
    };
  }

  return { ok: true };
}
