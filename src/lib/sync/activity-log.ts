import { SyncActivityLevel as DbSyncActivityLevel, SyncActivitySource as DbSyncActivitySource } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";

export type SyncActivitySource = "wtt" | "ttbl";
export type SyncActivityLevel = "info" | "warn" | "error";

export interface SyncActivityEntry {
  id: string;
  timestamp: string;
  source: SyncActivitySource;
  level: SyncActivityLevel;
  message: string;
  details?: Record<string, unknown> | null;
}

const MAX_SYNC_ACTIVITY_ENTRIES = 5000;

const activityGlobal = globalThis as typeof globalThis & {
  __syncActivityWriteQueue?: Promise<void>;
};

function toDbSource(source: SyncActivitySource): DbSyncActivitySource {
  return source === "ttbl" ? DbSyncActivitySource.ttbl : DbSyncActivitySource.wtt;
}

function toDbLevel(level: SyncActivityLevel): DbSyncActivityLevel {
  if (level === "warn") {
    return DbSyncActivityLevel.warn;
  }
  if (level === "error") {
    return DbSyncActivityLevel.error;
  }
  return DbSyncActivityLevel.info;
}

function toDbDetails(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) {
    return null;
  }

  return JSON.stringify(details);
}

function fromDbDetails(details: string | null): Record<string, unknown> | null {
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

function normalizeEntries(entries: SyncActivityEntry[]): SyncActivityEntry[] {
  if (entries.length <= MAX_SYNC_ACTIVITY_ENTRIES) {
    return entries;
  }

  return entries.slice(entries.length - MAX_SYNC_ACTIVITY_ENTRIES);
}

function getRequiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required for sync activity log storage.");
  }

  return prisma;
}

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const previous = activityGlobal.__syncActivityWriteQueue ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  activityGlobal.__syncActivityWriteQueue = next.catch(() => undefined);
  return next;
}

export async function listSyncActivityEntries(limit = 400): Promise<SyncActivityEntry[]> {
  const safeLimit = Math.max(1, Math.min(5000, Math.trunc(limit)));
  const prisma = getRequiredPrisma();

  const rows = await prisma.syncActivity.findMany({
    take: safeLimit,
    orderBy: { occurredAt: "desc" },
  });

  return rows
    .reverse()
    .map((row) => ({
      id: row.id,
      timestamp: row.occurredAt.toISOString(),
      source: row.source,
      level: row.level,
      message: row.message,
      details: fromDbDetails(row.details),
    }));
}

export async function replaceSyncActivityEntries(
  entries: SyncActivityEntry[],
): Promise<void> {
  await enqueueWrite(async () => {
    const prisma = getRequiredPrisma();
    await prisma.$transaction(async (tx) => {
      await tx.syncActivity.deleteMany({});
      const normalized = normalizeEntries(entries);
      if (normalized.length > 0) {
        await tx.syncActivity.createMany({
          data: normalized.map((entry) => ({
            id: entry.id,
            occurredAt: new Date(entry.timestamp),
            source: toDbSource(entry.source),
            level: toDbLevel(entry.level),
            message: entry.message,
            details: toDbDetails(entry.details),
          })),
        });
      }
    });
  });
}

export async function appendSyncActivity(
  source: SyncActivitySource,
  message: string,
  details?: Record<string, unknown>,
  level: SyncActivityLevel = "info",
): Promise<void> {
  await enqueueWrite(async () => {
    const prisma = getRequiredPrisma();
    await prisma.syncActivity.create({
      data: {
        source: toDbSource(source),
        level: toDbLevel(level),
        message,
        details: toDbDetails(details),
      },
    });
  });
}
