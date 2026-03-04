import { ensureDir, removeDir } from "@/lib/fs";
import { getPrismaClient } from "@/lib/db/prisma";
import {
  scheduleTTBLFollowupInBackground,
  scheduleWTTFollowupInBackground,
} from "@/lib/jobs/action-job";
import { DATA_ROOT } from "@/lib/paths";
import { rebuildPlayerRegistry } from "@/lib/players/registry";
import { scrapeTTBLAllTime } from "@/lib/scrapers/ttbl";
import { scrapeWTTAllTime } from "@/lib/scrapers/wtt";
import {
  listSyncActivityEntries,
  replaceSyncActivityEntries,
} from "@/lib/sync/activity-log";

export interface CleanScrapeOptions {
  ttblStartYear?: number;
  ttblEndYear?: number;
  ttblNumGamedays?: number;
  wttStartYear?: number;
  wttEndYear?: number;
  wttPageSize?: number;
  wttMaxPages?: number;
  delayMs?: number;
}

export type CleanScrapeLogFn = (message: string) => void;

export interface CleanScrapeResult {
  generatedAt: string;
  dataRoot: string;
  ttbl: {
    seasons: number;
    matches: number;
    latestSeason: string | null;
  };
  wtt: {
    years: number;
    matches: number;
    players: number;
  };
  players: {
    canonicalPlayers: number;
    mergedPlayers: number;
    candidates: number;
  };
}

function emit(log: CleanScrapeLogFn | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] ${message}`);
}

export async function runCleanScrape(
  options: CleanScrapeOptions = {},
  onLog?: CleanScrapeLogFn,
): Promise<CleanScrapeResult> {
  const nowYear = new Date().getUTCFullYear();
  const resolved = {
    ttblStartYear: options.ttblStartYear ?? 1995,
    ttblEndYear: options.ttblEndYear ?? nowYear + 1,
    ttblNumGamedays: options.ttblNumGamedays,
    wttStartYear: options.wttStartYear ?? 2017,
    wttEndYear: options.wttEndYear ?? nowYear,
    wttPageSize: options.wttPageSize ?? 500,
    wttMaxPages: options.wttMaxPages ?? 1200,
    delayMs: options.delayMs,
  };

  emit(onLog, "Starting clean scrape workflow.");
  emit(
    onLog,
    `Master sync ranges: TTBL start years ${resolved.ttblStartYear}-${resolved.ttblEndYear}, WTT years ${resolved.wttStartYear}-${resolved.wttEndYear}.`,
  );
  const preservedSyncEntries = await listSyncActivityEntries(5000);
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required for clean scrape.");
  }
  emit(onLog, "Deleting existing relational dataset rows.");
  await prisma.$transaction(async (tx) => {
    await tx.playerMergeCandidate.deleteMany({});
    await tx.playerCanonicalMember.deleteMany({});
    await tx.playerCanonical.deleteMany({});
    await tx.playerRegistryState.deleteMany({});
    await tx.ttblGame.deleteMany({});
    await tx.ttblMatch.deleteMany({});
    await tx.ttblPlayerSeasonStat.deleteMany({});
    await tx.ttblSeasonSummary.deleteMany({});
    await tx.ttblPlayerProfile.deleteMany({});
    await tx.ttblPlayer.deleteMany({});
    await tx.wttMatchGame.deleteMany({});
    await tx.wttMatch.deleteMany({});
    await tx.wttPlayer.deleteMany({});
  });
  emit(onLog, `Deleting existing local data root: ${DATA_ROOT}`);
  await removeDir(DATA_ROOT);
  await ensureDir(DATA_ROOT);
  if (preservedSyncEntries.length > 0) {
    await replaceSyncActivityEntries(preservedSyncEntries);
    emit(
      onLog,
      `Restored ${preservedSyncEntries.length} persisted background sync log entries.`,
    );
  }
  emit(onLog, "Relational tables reset. Local data root cleaned.");

  const ttbl = await scrapeTTBLAllTime({
    startYear: resolved.ttblStartYear,
    endYear: resolved.ttblEndYear,
    numGamedays: resolved.ttblNumGamedays,
    delayMs: resolved.delayMs,
    includeYouth: false,
    onLog,
  });
  emit(
    onLog,
    `TTBL scrape complete. Seasons=${ttbl.discoveredSeasons.length}, latest=${ttbl.discoveredSeasons[0] ?? "none"}.`,
  );
  if (
    ttbl.current &&
    ((ttbl.current.ongoingMatches ?? 0) > 0 || (ttbl.current.notFinishedMatches ?? 0) > 0)
  ) {
    const followup = scheduleTTBLFollowupInBackground({
      season: ttbl.current.metadata.season,
      delayMs: 120000,
      includeYouth: false,
      backgroundReason: "auto-after-clean-job",
      reason: "auto-after-clean-job",
    });
    emit(
      onLog,
      `TTBL background follow-up scheduled for ${followup.scheduledFor} (ongoing=${ttbl.current.ongoingMatches}, notFinished=${ttbl.current.notFinishedMatches}).`,
    );
  }

  const wtt = await scrapeWTTAllTime({
    startYear: resolved.wttStartYear,
    endYear: resolved.wttEndYear,
    pageSize: resolved.wttPageSize,
    maxPages: resolved.wttMaxPages,
    delayMs: resolved.delayMs,
    eventScope: "singles_only",
    includeYouth: true,
    profileEnrichMaxPlayers: 0,
    onLog,
  });
  emit(
    onLog,
    `WTT scrape complete. Years=${wtt.discoveredYears.length}, matches=${wtt.scrape.matches}, players=${wtt.scrape.players}.`,
  );
  if ((wtt.scrape.ongoingMatches ?? 0) > 0 || (wtt.scrape.notFinishedMatches ?? 0) > 0) {
    const followup = scheduleWTTFollowupInBackground({
      years: wtt.scrape.years,
      delayMs: 120000,
      eventScope: "singles_only",
      includeYouth: true,
      backgroundReason: "auto-after-clean-job",
      reason: "auto-after-clean-job",
    });
    emit(
      onLog,
      `WTT background follow-up scheduled for ${followup.scheduledFor} (ongoing=${wtt.scrape.ongoingMatches}, notFinished=${wtt.scrape.notFinishedMatches}).`,
    );
  }

  emit(onLog, "Rebuilding player merge registry...");
  const registry = await rebuildPlayerRegistry();
  emit(
    onLog,
    `Player registry built. Canonical=${registry.totals.canonicalPlayers}, merged=${registry.totals.mergedPlayers}.`,
  );

  const totalTTBLMatches = ttbl.legacy.results.reduce(
    (sum, row) => sum + row.metadata.totalMatches,
    0,
  );

  emit(onLog, "Clean scrape workflow complete.");

  return {
    generatedAt: new Date().toISOString(),
    dataRoot: DATA_ROOT,
    ttbl: {
      seasons: ttbl.discoveredSeasons.length,
      matches: totalTTBLMatches,
      latestSeason: ttbl.discoveredSeasons[0] ?? null,
    },
    wtt: {
      years: wtt.discoveredYears.length,
      matches: wtt.scrape.matches,
      players: wtt.scrape.players,
    },
    players: {
      canonicalPlayers: registry.totals.canonicalPlayers,
      mergedPlayers: registry.totals.mergedPlayers,
      candidates: registry.totals.candidates,
    },
  };
}
