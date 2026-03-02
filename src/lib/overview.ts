import { DashboardOverview, EndpointRow } from "@/lib/dashboard-types";
import { getPrismaClient } from "@/lib/db/prisma";
import { getTTBLFollowupStatus, getWTTFollowupStatus } from "@/lib/jobs/action-job";
import { ensurePlayerRegistry } from "@/lib/players/registry";
import { listSyncActivityEntries } from "@/lib/sync/activity-log";
import { TTBLLegacyIndex, TTBLMetadata, TTBLPlayerStats, WTTMatch } from "@/lib/types";
import { isWTTGenderedSinglesEvent } from "@/lib/wtt/events";

const appEndpoints: EndpointRow[] = [
  {
    method: "POST",
    path: "/api/mcp",
    category: "MCP routes (AI + debugging)",
    description: "MCP JSON-RPC endpoint exposing scrape controls, diagnostics, matches, and places.",
  },
  {
    method: "GET",
    path: "/api/mcp",
    category: "MCP routes (AI + debugging)",
    description: "MCP endpoint metadata and tool catalog.",
  },
  {
    method: "POST",
    path: "/api/scrape/ttbl",
    category: "Internal API routes (lambda triggers)",
    description:
      "Run TTBL scraper for one or more seasons (supports 2025 or 2025-2026 style inputs).",
  },
  {
    method: "POST",
    path: "/api/scrape/ttbl/followup",
    category: "Internal API routes (lambda triggers)",
    description:
      "Schedule a background TTBL follow-up scrape (used for live/in-progress monitoring).",
  },
  {
    method: "GET",
    path: "/api/scrape/ttbl/followup",
    category: "Internal API routes (lambda triggers)",
    description: "Read current TTBL background follow-up schedule/status.",
  },
  {
    method: "POST",
    path: "/api/scrape/ttbl/all",
    category: "Internal API routes (lambda triggers)",
    description:
      "Run all-time TTBL scrape (discover seasons + scrape + rebuild players) without deleting WTT data.",
  },
  {
    method: "POST",
    path: "/api/scrape/wtt",
    category: "Internal API routes (lambda triggers)",
    description: "Run ITTF/WTT scraper for one or more years (TTU backend, singles-only by default).",
  },
  {
    method: "POST",
    path: "/api/scrape/wtt/followup",
    category: "Internal API routes (lambda triggers)",
    description:
      "Schedule a background WTT follow-up scrape (used for live/in-progress monitoring).",
  },
  {
    method: "GET",
    path: "/api/scrape/wtt/followup",
    category: "Internal API routes (lambda triggers)",
    description: "Read current WTT background follow-up schedule/status.",
  },
  {
    method: "POST",
    path: "/api/scrape/wtt/all",
    category: "Internal API routes (lambda triggers)",
    description:
      "Run all-time WTT scrape (discover years + scrape + rebuild players) without deleting TTBL data.",
  },
  {
    method: "POST",
    path: "/api/scrape/clean",
    category: "Internal API routes (lambda triggers)",
    description:
      "Delete existing database rows and run a full all-time scrape for TTBL + ITTF/WTT.",
  },
  {
    method: "POST",
    path: "/api/data/destroy",
    category: "Internal API routes (lambda triggers)",
    description: "Delete all stored relational data.",
  },
  {
    method: "POST",
    path: "/api/players/registry",
    category: "Internal API routes (lambda triggers)",
    description: "Rebuild deduped player registry from scraped data.",
  },
  {
    method: "GET",
    path: "/api/spindex/ping",
    category: "Spindex routes (compare + push)",
    description: "Ping SPINDEX public status endpoint and return upstream reachability details.",
  },
  {
    method: "POST",
    path: "/api/spindex/players/check",
    category: "Spindex routes (compare + push)",
    description: "Build local player payload, map Spindex IDs, and compare ratings against SPINDEX.",
  },
  {
    method: "POST",
    path: "/api/spindex/players/update",
    category: "Spindex routes (compare + push)",
    description: "Patch player rating updates to SPINDEX (`/api/private/players`) in batches.",
  },
  {
    method: "POST",
    path: "/api/spindex/sync",
    category: "Spindex routes (compare + push)",
    description: "Compatibility alias for player update sync route.",
  },
  {
    method: "GET",
    path: "/api/overview",
    category: "Data and utility routes",
    description: "Dashboard summary and endpoint catalog.",
  },
  {
    method: "GET",
    path: "/api/endpoints",
    category: "Data and utility routes",
    description: "List scraper, sync, MCP, and Spindex endpoint references.",
  },
  {
    method: "GET",
    path: "/api/pipeline/status",
    category: "Data and utility routes",
    description: "Read WTT pipeline detector status and recent event-level metrics.",
  },
  {
    method: "GET",
    path: "/api/players/registry",
    category: "Data and utility routes",
    description: "Read deduped player registry and merge candidates.",
  },
  {
    method: "GET",
    path: "/api/players/slugs",
    category: "Data and utility routes",
    description:
      "Read flattened canonical player rows with merge candidates, match stats, scores, and inferred gender.",
  },
  {
    method: "GET",
    path: "/api/players/source-profiles",
    category: "Data and utility routes",
    description: "Read source profile snapshots (TTBL/WTT) for a canonical player key.",
  },
  {
    method: "GET",
    path: "/api/countries/match",
    category: "Data and utility routes",
    description: "Normalize and compare country names/codes (alias-aware).",
  },
  {
    method: "GET",
    path: "/api/sync/activity",
    category: "Data and utility routes",
    description: "Read persistent TTBL/WTT background sync activity log.",
  },
];

export function getEndpointCatalog(): EndpointRow[] {
  return [...appEndpoints];
}

function parseSeasonStart(season: string): number {
  const parsed = Number.parseInt(season.split("-")[0] ?? "0", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface SeasonSummaryRow {
  season: string;
  scrapeDate: Date;
  totalMatches: number;
  totalGamedays: number;
  youthFilteredMatches: number;
  youthIncludedMatches: number;
  notFinishedMatches: number;
  ongoingMatches: number;
  uniquePlayers: number;
  playersWithStats: number;
  totalGamesProcessed: number;
  source: string;
  version: string;
}

async function readSeasonRowsCompat(
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>,
): Promise<SeasonSummaryRow[]> {
  const prismaAny = prisma as unknown as {
    ttblSeasonSummary?: { findMany: (args: unknown) => Promise<SeasonSummaryRow[]> };
  };

  if (prismaAny.ttblSeasonSummary?.findMany) {
    return await prismaAny.ttblSeasonSummary.findMany({ orderBy: { season: "desc" } });
  }

  const seasons = await prisma.ttblMatch.findMany({
    distinct: ["season"],
    select: { season: true },
  });

  const rows: SeasonSummaryRow[] = [];
  for (const seasonRow of seasons) {
    const season = seasonRow.season;
    const [totalMatches, youthIncludedMatches, totalGamesProcessed, playersWithStats, latestMatch] =
      await Promise.all([
        prisma.ttblMatch.count({ where: { season } }),
        prisma.ttblMatch.count({ where: { season, isYouth: true } }),
        prisma.ttblGame.count({ where: { season } }),
        prisma.ttblPlayerSeasonStat.count({ where: { season } }),
        prisma.ttblMatch.findFirst({
          where: { season },
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        }),
      ]);

    rows.push({
      season,
      scrapeDate: latestMatch?.updatedAt ?? new Date(),
      totalMatches,
      totalGamedays: 0,
      youthFilteredMatches: 0,
      youthIncludedMatches,
      notFinishedMatches: 0,
      ongoingMatches: 0,
      uniquePlayers: playersWithStats,
      playersWithStats,
      totalGamesProcessed,
      source: "postgres",
      version: "compat",
    });
  }

  return rows.sort((a, b) => parseSeasonStart(b.season) - parseSeasonStart(a.season));
}

function toWTTMatch(row: {
  id: string;
  sourceMatchId: string | null;
  eventId: string | null;
  subEventCode: string | null;
  year: number | null;
  lastUpdatedAt: Date | null;
  tournament: string | null;
  event: string | null;
  stage: string | null;
  round: string | null;
  resultStatus: string | null;
  notFinished: boolean;
  ongoing: boolean;
  isYouth: boolean;
  walkover: boolean;
  winnerRaw: number | null;
  winnerInferred: string | null;
  finalSetsA: number;
  finalSetsX: number;
  playerAId: string | null;
  playerAName: string | null;
  playerAAssoc: string | null;
  playerXId: string | null;
  playerXName: string | null;
  playerXAssoc: string | null;
  sourceType: string | null;
  sourceBaseUrl: string | null;
  sourceListId: string | null;
}): WTTMatch {
  return {
    match_id: row.id,
    source_match_id: row.sourceMatchId,
    event_id: row.eventId,
    sub_event_code: row.subEventCode,
    year: row.year ? String(row.year) : null,
    last_updated_at: row.lastUpdatedAt ? row.lastUpdatedAt.toISOString() : null,
    tournament: row.tournament,
    event: row.event,
    stage: row.stage,
    round: row.round,
    result_status: row.resultStatus,
    not_finished: row.notFinished,
    ongoing: row.ongoing,
    is_youth: row.isYouth,
    walkover: row.walkover,
    winner_raw: row.winnerRaw,
    winner_inferred: row.winnerInferred === "A" || row.winnerInferred === "X" ? row.winnerInferred : null,
    final_sets: {
      a: row.finalSetsA,
      x: row.finalSetsX,
    },
    games: [],
    players: {
      a: {
        ittf_id: row.playerAId,
        name: row.playerAName,
        association: row.playerAAssoc,
      },
      x: {
        ittf_id: row.playerXId,
        name: row.playerXName,
        association: row.playerXAssoc,
      },
    },
    source: {
      type: row.sourceType ?? "db",
      base_url: row.sourceBaseUrl ?? "",
      list_id: row.sourceListId ?? "",
    },
  };
}

export async function getDashboardOverview(): Promise<DashboardOverview> {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required in Postgres mode.");
  }

  const [seasonRows, wttRows, wttPlayerCount, registrySettled, syncActivity] = await Promise.all([
    readSeasonRowsCompat(prisma),
    prisma.wttMatch.findMany({
      select: {
        id: true,
        sourceMatchId: true,
        eventId: true,
        subEventCode: true,
        year: true,
        lastUpdatedAt: true,
        tournament: true,
        event: true,
        stage: true,
        round: true,
        resultStatus: true,
        notFinished: true,
        ongoing: true,
        isYouth: true,
        walkover: true,
        winnerRaw: true,
        winnerInferred: true,
        finalSetsA: true,
        finalSetsX: true,
        playerAId: true,
        playerAName: true,
        playerAAssoc: true,
        playerXId: true,
        playerXName: true,
        playerXAssoc: true,
        sourceType: true,
        sourceBaseUrl: true,
        sourceListId: true,
      },
      orderBy: [{ year: "desc" }, { updatedAt: "desc" }],
    }),
    prisma.wttPlayer.count(),
    ensurePlayerRegistry().catch(() => null),
    listSyncActivityEntries(400),
  ]);
  const registry = registrySettled ?? null;

  const latestSeason = [...seasonRows].sort(
    (a, b) => parseSeasonStart(b.season) - parseSeasonStart(a.season),
  )[0] ?? null;

  const [topPlayersRows, totalGames, validFinishedGames] = latestSeason
    ? await Promise.all([
        prisma.ttblPlayerSeasonStat.findMany({
          where: { season: latestSeason.season },
          orderBy: [{ winRate: "desc" }, { gamesPlayed: "desc" }, { name: "asc" }],
          take: 20,
        }),
        prisma.ttblGame.count({ where: { season: latestSeason.season } }),
        prisma.ttblGame.count({
          where: {
            season: latestSeason.season,
            isYouth: false,
            gameState: "Finished",
            winnerSide: { not: null },
            homePlayerId: { not: null },
            awayPlayerId: { not: null },
          },
        }),
      ])
    : [[], 0, 0];

  const ttblMetadata: TTBLMetadata | null = latestSeason
    ? {
        scrapeDate: latestSeason.scrapeDate.toISOString(),
        season: latestSeason.season,
        totalMatches: latestSeason.totalMatches,
        totalGamedays: latestSeason.totalGamedays,
        youthFilteredMatches: latestSeason.youthFilteredMatches,
        youthIncludedMatches: latestSeason.youthIncludedMatches,
        notFinishedMatches: latestSeason.notFinishedMatches,
        ongoingMatches: latestSeason.ongoingMatches,
        uniquePlayers: latestSeason.uniquePlayers,
        playersWithStats: latestSeason.playersWithStats,
        totalGamesProcessed: latestSeason.totalGamesProcessed,
        source: latestSeason.source,
        version: latestSeason.version,
      }
    : null;

  const ttblTopPlayers: TTBLPlayerStats[] = topPlayersRows.map((row) => ({
    id: row.playerId,
    name: row.name,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    losses: row.losses,
    lastMatch: row.lastMatchId ?? "",
    winRate: row.winRate,
  }));

  const ttblLegacy: TTBLLegacyIndex = {
    generatedAt: new Date().toISOString(),
    seasons: seasonRows.map((row) => row.season).sort((a, b) => parseSeasonStart(b) - parseSeasonStart(a)),
    results: seasonRows
      .map((row) => ({
        season: row.season,
        outputDir: "postgres",
        totalMatches: row.totalMatches,
        uniquePlayers: row.uniquePlayers,
        totalGamesProcessed: row.totalGamesProcessed,
        scrapeDate: row.scrapeDate.toISOString(),
      }))
      .sort((a, b) => parseSeasonStart(b.season) - parseSeasonStart(a.season)),
  };

  const filteredWTTRows = wttRows.filter(
    (row) => !row.isYouth && isWTTGenderedSinglesEvent(row.event),
  );
  const wttYears = [...new Set(filteredWTTRows.map((row) => row.year).filter((year): year is number => Number.isFinite(year ?? null)))].sort((a, b) => b - a);
  const sampleMatches = filteredWTTRows.slice(0, 8).map((row) => toWTTMatch(row));

  const ttblFollowup = getTTBLFollowupStatus();
  const wttFollowup = getWTTFollowupStatus();

  return {
    generatedAt: new Date().toISOString(),
    ttbl: {
      metadata: ttblMetadata,
      legacy: ttblLegacy,
      topPlayers: ttblTopPlayers,
      totalGames,
      validFinishedGames,
    },
    wtt: {
      years: wttYears,
      totalMatches: filteredWTTRows.length,
      totalPlayers: wttPlayerCount,
      sampleMatches,
    },
    sync: {
      activity: syncActivity,
      ttblFollowup: {
        scheduled: ttblFollowup.scheduled,
        scheduledFor: ttblFollowup.scheduledFor,
        lastTriggeredAt: ttblFollowup.lastTriggeredAt,
        lastOutcome: ttblFollowup.lastOutcome,
        lastError: ttblFollowup.lastError,
      },
      wttFollowup: {
        scheduled: wttFollowup.scheduled,
        scheduledFor: wttFollowup.scheduledFor,
        lastTriggeredAt: wttFollowup.lastTriggeredAt,
        lastOutcome: wttFollowup.lastOutcome,
        lastError: wttFollowup.lastError,
      },
    },
    players: registry,
    endpoints: getEndpointCatalog(),
  };
}
