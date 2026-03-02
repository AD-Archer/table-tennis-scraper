import { getPrismaClient } from "@/lib/db/prisma";
import { TTBL_OUTPUT_DIR } from "@/lib/paths";

export interface TTBLSeasonEntry {
  season: string;
  dir: string;
}

export function parseTTBLSeasonStart(value: string | null | undefined): number {
  const match = value?.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (!match?.[1]) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortSeasonEntries(rows: TTBLSeasonEntry[]): TTBLSeasonEntry[] {
  return [...rows].sort(
    (a, b) =>
      parseTTBLSeasonStart(b.season) - parseTTBLSeasonStart(a.season) ||
      b.season.localeCompare(a.season),
  );
}

export async function listTTBLSeasonEntries(): Promise<TTBLSeasonEntry[]> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return [];
  }

  const seasonsFromSummary = await prisma.ttblSeasonSummary.findMany({
    select: { season: true },
  });

  const seasonSet = new Set(
    seasonsFromSummary
      .map((row) => row.season.trim())
      .filter((season) => parseTTBLSeasonStart(season) > 0),
  );

  if (seasonSet.size === 0) {
    const seasonsFromMatches = await prisma.ttblMatch.findMany({
      distinct: ["season"],
      select: { season: true },
    });
    for (const row of seasonsFromMatches) {
      const season = row.season.trim();
      if (parseTTBLSeasonStart(season) > 0) {
        seasonSet.add(season);
      }
    }
  }

  return sortSeasonEntries([...seasonSet].map((season) => ({ season, dir: TTBL_OUTPUT_DIR })));
}

export async function getTTBLReadDirResolved(): Promise<string> {
  return TTBL_OUTPUT_DIR;
}
