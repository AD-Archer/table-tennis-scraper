import { ensureDir, removeDir } from "@/lib/fs";
import { DATA_ROOT } from "@/lib/paths";
import { rebuildPlayerRegistry } from "@/lib/players/registry";
import { scrapeTTBLAllTime } from "@/lib/scrapers/ttbl";
import { scrapeWTTAllTime } from "@/lib/scrapers/wtt";

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
  emit(onLog, `Deleting existing local data root: ${DATA_ROOT}`);
  await removeDir(DATA_ROOT);
  await ensureDir(DATA_ROOT);
  emit(onLog, "Local data root recreated.");

  const ttbl = await scrapeTTBLAllTime({
    startYear: resolved.ttblStartYear,
    endYear: resolved.ttblEndYear,
    numGamedays: resolved.ttblNumGamedays,
    delayMs: resolved.delayMs,
    onLog,
  });
  emit(
    onLog,
    `TTBL scrape complete. Seasons=${ttbl.discoveredSeasons.length}, latest=${ttbl.discoveredSeasons[0] ?? "none"}.`,
  );

  const wtt = await scrapeWTTAllTime({
    startYear: resolved.wttStartYear,
    endYear: resolved.wttEndYear,
    pageSize: resolved.wttPageSize,
    maxPages: resolved.wttMaxPages,
    delayMs: resolved.delayMs,
    tournamentScope: "all",
    eventScope: "singles_only",
    includeYouth: true,
    profileEnrichMaxPlayers: 0,
    onLog,
  });
  emit(
    onLog,
    `WTT scrape complete. Years=${wtt.discoveredYears.length}, matches=${wtt.scrape.matches}, players=${wtt.scrape.players}.`,
  );

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
