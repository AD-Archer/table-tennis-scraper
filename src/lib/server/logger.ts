type ServerLogLevel = "debug" | "info" | "warn" | "error";

interface ServerLogEvent {
  level?: ServerLogLevel;
  scope: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
  error?: unknown;
}

const LEVEL_RANK: Record<ServerLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const STACK_FRAME_LIMIT = 12;

function readLogLevel(): ServerLogLevel {
  const raw = (process.env.SERVER_LOG_LEVEL ?? "info").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }

  return "info";
}

function shouldLog(level: ServerLogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[readLogLevel()];
}

function shouldPrettyPrint(): boolean {
  const raw = (process.env.SERVER_LOG_PRETTY ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

function truncateString(value: string, max = 2000): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)} ...[truncated ${value.length - max} chars]`;
}

function compactStackTrace(stack: string): string {
  const lines = stack
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const header = lines[0] ?? "Error";
  const frames = lines.slice(1);
  const appFrames = frames.filter((frame) => {
    const normalized = frame.toLowerCase();
    return (
      !normalized.includes("node_modules") &&
      !normalized.includes("next/dist") &&
      !normalized.includes("internal/process/task_queues")
    );
  });

  const preferred = (appFrames.length > 0 ? appFrames : frames).slice(0, STACK_FRAME_LIMIT);
  const omitted = Math.max(0, frames.length - preferred.length);

  return [
    header,
    ...preferred,
    omitted > 0 ? `... ${omitted} additional stack frames hidden` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function serializeError(error: unknown): Record<string, unknown> | null {
  if (!error) {
    return null;
  }

  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message,
      stack: error.stack ? truncateString(compactStackTrace(error.stack), 4000) : null,
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: truncateString(error, 2000),
      stack: null,
    };
  }

  if (typeof error === "object") {
    try {
      return {
        name: "Error",
        message: truncateString(JSON.stringify(error), 2000),
        stack: null,
      };
    } catch {
      return {
        name: "Error",
        message: "Unable to serialize unknown object error",
        stack: null,
      };
    }
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
  };
}

function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string") {
      out[key] = truncateString(value, 1000);
      continue;
    }

    if (Array.isArray(value)) {
      const trimmed = value.slice(0, 50).map((item) =>
        typeof item === "string" ? truncateString(item, 300) : item,
      );
      out[key] = value.length > 50 ? [...trimmed, `...+${value.length - 50} more`] : trimmed;
      continue;
    }

    out[key] = value;
  }

  return out;
}

export function logServerEvent(event: ServerLogEvent): void {
  const level = event.level ?? "info";
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    scope: event.scope,
    event: event.event,
    message: event.message,
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    context: sanitizeContext(event.context),
    error: serializeError(event.error),
  };

  const serialized = shouldPrettyPrint()
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  if (level === "debug") {
    console.debug(serialized);
    return;
  }

  console.info(serialized);
}
