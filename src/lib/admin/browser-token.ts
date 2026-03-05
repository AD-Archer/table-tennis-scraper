const ADMIN_CONSOLE_TOKEN_STORAGE_KEY = "admin-console-token";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface StoredAdminConsoleToken {
  token: string;
  expiresAt: number;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function readAdminConsoleToken(nowMs = Date.now()): string | null {
  if (!isBrowser()) {
    return null;
  }

  const raw = window.localStorage.getItem(ADMIN_CONSOLE_TOKEN_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredAdminConsoleToken>;
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const expiresAt = Number(parsed.expiresAt);
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      window.localStorage.removeItem(ADMIN_CONSOLE_TOKEN_STORAGE_KEY);
      return null;
    }

    return token;
  } catch {
    window.localStorage.removeItem(ADMIN_CONSOLE_TOKEN_STORAGE_KEY);
    return null;
  }
}

export function writeAdminConsoleToken(token: string, nowMs = Date.now()): void {
  if (!isBrowser()) {
    return;
  }

  const trimmed = token.trim();
  if (!trimmed) {
    window.localStorage.removeItem(ADMIN_CONSOLE_TOKEN_STORAGE_KEY);
    return;
  }

  const payload: StoredAdminConsoleToken = {
    token: trimmed,
    expiresAt: nowMs + ONE_DAY_MS,
  };
  window.localStorage.setItem(
    ADMIN_CONSOLE_TOKEN_STORAGE_KEY,
    JSON.stringify(payload),
  );
}

export function clearAdminConsoleToken(): void {
  if (!isBrowser()) {
    return;
  }
  window.localStorage.removeItem(ADMIN_CONSOLE_TOKEN_STORAGE_KEY);
}
