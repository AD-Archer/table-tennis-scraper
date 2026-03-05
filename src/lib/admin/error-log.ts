import {
  AdminErrorCategory as DbAdminErrorCategory,
  AdminErrorStatus as DbAdminErrorStatus,
} from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
import { logServerEvent, serializeError } from "@/lib/server/logger";

export type AdminErrorCategory = "scrape" | "merge" | "system";
export type AdminErrorStatus = "open" | "resolved";

export interface AdminErrorLogEntry {
  id: string;
  timestamp: string;
  category: AdminErrorCategory;
  status: AdminErrorStatus;
  source: string;
  operation: string;
  jobId: string | null;
  jobType: string | null;
  message: string;
  errorName: string | null;
  errorStack: string | null;
  details: Record<string, unknown> | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

interface LogAdminErrorInput {
  category: AdminErrorCategory;
  source: string;
  operation: string;
  message: string;
  jobId?: string | null;
  jobType?: string | null;
  details?: Record<string, unknown> | null;
  error?: unknown;
}

interface ListAdminErrorLogOptions {
  limit?: number;
  status?: AdminErrorStatus | "all";
  category?: AdminErrorCategory | "all";
  query?: string;
}

interface UpdateAdminErrorLogInput {
  status?: AdminErrorStatus;
  resolutionNote?: string | null;
}

function getRequiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required for admin error log storage.");
  }

  return prisma;
}

function toDbCategory(category: AdminErrorCategory): DbAdminErrorCategory {
  if (category === "merge") {
    return DbAdminErrorCategory.merge;
  }
  if (category === "system") {
    return DbAdminErrorCategory.system;
  }
  return DbAdminErrorCategory.scrape;
}

function toDbStatus(status: AdminErrorStatus): DbAdminErrorStatus {
  return status === "resolved" ? DbAdminErrorStatus.resolved : DbAdminErrorStatus.open;
}

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) {
    return null;
  }

  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeCategory(raw: string | null): AdminErrorCategory | "all" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "scrape" || value === "merge" || value === "system") {
    return value;
  }

  return "all";
}

function normalizeStatus(raw: string | null): AdminErrorStatus | "all" {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "open" || value === "resolved") {
    return value;
  }

  return "all";
}

function toSerializedDetails(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) {
    return null;
  }

  return JSON.stringify(details);
}

export function parseAdminErrorCategory(raw: string | null): AdminErrorCategory | "all" {
  return normalizeCategory(raw);
}

export function parseAdminErrorStatus(raw: string | null): AdminErrorStatus | "all" {
  return normalizeStatus(raw);
}

export async function logAdminError(input: LogAdminErrorInput): Promise<AdminErrorLogEntry> {
  const prisma = getRequiredPrisma();
  const serializedError = serializeError(input.error);
  const row = await prisma.adminErrorLog.create({
    data: {
      category: toDbCategory(input.category),
      source: input.source,
      operation: input.operation,
      jobId: input.jobId ?? null,
      jobType: input.jobType ?? null,
      message: input.message,
      errorName:
        typeof serializedError?.name === "string" ? serializedError.name : null,
      errorStack:
        typeof serializedError?.stack === "string" ? serializedError.stack : null,
      details: toSerializedDetails(input.details),
      status: DbAdminErrorStatus.open,
      resolutionNote: null,
      resolvedAt: null,
    },
  });

  logServerEvent({
    level: "error",
    scope: "admin-error-log",
    event: "captured",
    message: input.message,
    context: {
      category: input.category,
      source: input.source,
      operation: input.operation,
      jobId: input.jobId ?? null,
      jobType: input.jobType ?? null,
      adminErrorLogId: row.id,
    },
    error: input.error,
  });

  return {
    id: row.id,
    timestamp: row.occurredAt.toISOString(),
    category: row.category,
    status: row.status,
    source: row.source,
    operation: row.operation,
    jobId: row.jobId,
    jobType: row.jobType,
    message: row.message,
    errorName: row.errorName,
    errorStack: row.errorStack,
    details: parseDetails(row.details),
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

export async function listAdminErrorLogs(
  options: ListAdminErrorLogOptions = {},
): Promise<AdminErrorLogEntry[]> {
  const prisma = getRequiredPrisma();
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 120)));
  const query = options.query?.trim();

  const rows = await prisma.adminErrorLog.findMany({
    take: limit,
    where: {
      category:
        options.category && options.category !== "all"
          ? toDbCategory(options.category)
          : undefined,
      status:
        options.status && options.status !== "all"
          ? toDbStatus(options.status)
          : undefined,
      OR: query
        ? [
            { message: { contains: query, mode: "insensitive" } },
            { source: { contains: query, mode: "insensitive" } },
            { operation: { contains: query, mode: "insensitive" } },
            { jobId: { contains: query, mode: "insensitive" } },
            { jobType: { contains: query, mode: "insensitive" } },
          ]
        : undefined,
    },
    orderBy: { occurredAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.occurredAt.toISOString(),
    category: row.category,
    status: row.status,
    source: row.source,
    operation: row.operation,
    jobId: row.jobId,
    jobType: row.jobType,
    message: row.message,
    errorName: row.errorName,
    errorStack: row.errorStack,
    details: parseDetails(row.details),
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  }));
}

export async function updateAdminErrorLog(
  id: string,
  patch: UpdateAdminErrorLogInput,
): Promise<AdminErrorLogEntry> {
  const prisma = getRequiredPrisma();
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Admin error log id is required.");
  }

  const nextStatus = patch.status;
  const row = await prisma.adminErrorLog.update({
    where: { id: normalizedId },
    data: {
      status: nextStatus ? toDbStatus(nextStatus) : undefined,
      resolutionNote:
        patch.resolutionNote === undefined ? undefined : patch.resolutionNote,
      resolvedAt:
        nextStatus === "resolved"
          ? new Date()
          : nextStatus === "open"
            ? null
            : undefined,
    },
  });

  return {
    id: row.id,
    timestamp: row.occurredAt.toISOString(),
    category: row.category,
    status: row.status,
    source: row.source,
    operation: row.operation,
    jobId: row.jobId,
    jobType: row.jobType,
    message: row.message,
    errorName: row.errorName,
    errorStack: row.errorStack,
    details: parseDetails(row.details),
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

export async function deleteAdminErrorLog(id: string): Promise<void> {
  const prisma = getRequiredPrisma();
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Admin error log id is required.");
  }

  await prisma.adminErrorLog.delete({
    where: { id: normalizedId },
  });
}

export async function clearResolvedAdminErrorLogs(): Promise<number> {
  const prisma = getRequiredPrisma();
  const result = await prisma.adminErrorLog.deleteMany({
    where: { status: DbAdminErrorStatus.resolved },
  });
  return result.count;
}
