import { getPrismaClient } from "@/lib/db/prisma";

export interface ManualAliasEntry {
  key: string;
  canonicalKey: string;
  createdAt: string;
  updatedAt: string;
}

function getRequiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required for manual alias updates.");
  }

  return prisma;
}

function normalizeAliasKey(raw: string): string {
  return raw.trim();
}

function normalizeCanonicalKey(raw: string): string {
  return raw.trim();
}

export async function listManualAliases(limit = 600): Promise<ManualAliasEntry[]> {
  const prisma = getRequiredPrisma();
  const safeLimit = Math.max(1, Math.min(1200, Math.trunc(limit)));

  const rows = await prisma.playerManualAlias.findMany({
    take: safeLimit,
    orderBy: [{ updatedAt: "desc" }, { key: "asc" }],
  });

  return rows.map((row) => ({
    key: row.key,
    canonicalKey: row.canonicalKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function upsertManualAlias(
  key: string,
  canonicalKey: string,
): Promise<ManualAliasEntry> {
  const prisma = getRequiredPrisma();
  const normalizedKey = normalizeAliasKey(key);
  const normalizedCanonicalKey = normalizeCanonicalKey(canonicalKey);
  if (!normalizedKey) {
    throw new Error("Alias key is required.");
  }
  if (!normalizedCanonicalKey) {
    throw new Error("Canonical key is required.");
  }

  const row = await prisma.playerManualAlias.upsert({
    where: { key: normalizedKey },
    create: {
      key: normalizedKey,
      canonicalKey: normalizedCanonicalKey,
    },
    update: {
      canonicalKey: normalizedCanonicalKey,
    },
  });

  return {
    key: row.key,
    canonicalKey: row.canonicalKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function deleteManualAlias(key: string): Promise<void> {
  const prisma = getRequiredPrisma();
  const normalizedKey = normalizeAliasKey(key);
  if (!normalizedKey) {
    throw new Error("Alias key is required.");
  }

  await prisma.playerManualAlias.delete({
    where: { key: normalizedKey },
  });
}
