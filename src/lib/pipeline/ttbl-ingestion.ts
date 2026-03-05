import { getPrismaClient } from "@/lib/db/prisma";
import { getDataStoreMode, shouldUsePostgres } from "@/lib/db/config";
import { fetchMatchInternal } from "./ttbl-resolver";

// ---------------------------------------------------------------------------
// API response shapes (subset relevant to ingestion)
// ---------------------------------------------------------------------------

interface TTBLApiPlayer {
  id: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
}

interface TTBLApiGame {
  id: string;
  index: number;
  gameState: string;
  winnerSide: "Home" | "Away" | null;
  homeSets: number | null;
  awaySets: number | null;
  set1HomeScore: number | null;
  set1AwayScore: number | null;
  set2HomeScore: number | null;
  set2AwayScore: number | null;
  set3HomeScore: number | null;
  set3AwayScore: number | null;
  set4HomeScore: number | null;
  set4AwayScore: number | null;
  set5HomeScore: number | null;
  set5AwayScore: number | null;
  homePlayer: TTBLApiPlayer | null;
  awayPlayer: TTBLApiPlayer | null;
  homeDouble: { id: string } | null;
  awayDouble: { id: string } | null;
}

interface TTBLApiTeam {
  id: string;
  name: string;
  rank?: number;
}

interface TTBLApiMatch {
  id: string;
  matchState: string;
  timeStamp: number;
  homeGames: number;
  awayGames: number;
  homeSets: number;
  awaySets: number;
  homeTeam: TTBLApiTeam;
  awayTeam: TTBLApiTeam;
  games: TTBLApiGame[];
  venue?: { name?: string };
  updateCount?: number;
  gameday?: { name?: string; index?: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toIntOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function toBigIntMs(value: number | null | undefined): bigint {
  if (!Number.isFinite(value)) return BigInt(0);
  return BigInt(Math.trunc(value as number));
}

function isDoubles(game: TTBLApiGame): boolean {
  return game.homeDouble !== null || game.awayDouble !== null;
}

/**
 * Parse season string from gameday.name, e.g. "17. Spieltag (2025/2026)" → "2025-2026"
 * Falls back to the provided season string if parsing fails.
 */
function parseSeasonFromGameday(
  gamedayName: string | undefined,
  fallback: string,
): string {
  if (!gamedayName) return fallback;
  const match = gamedayName.match(/\((\d{4})\/(\d{4})\)/);
  if (match) return `${match[1]}-${match[2]}`;
  return fallback;
}

function parseGamedayLabel(gamedayName: string | undefined): string {
  if (!gamedayName) return "unknown";
  // "17. Spieltag (2025/2026)" → "17"
  const match = gamedayName.match(/^(\d+)\./);
  return match ? match[1] : gamedayName;
}

function playerName(player: TTBLApiPlayer | null): string | null {
  if (!player) return null;
  return [player.firstName, player.lastName].filter(Boolean).join(" ") || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IngestionResult {
  matchId: string;
  ingested: boolean;
  gamesIngested: number;
  reason?: string;
}

/**
 * Fetch a single match from the TTBL internal API and upsert it into the
 * TtblMatch + TtblGame tables. Skips doubles games.
 *
 * @param matchId  UUID of the match
 * @param season   Season string (e.g. "2025-2026") used as fallback if the
 *                 API response doesn't contain one
 * @param gameday  Gameday label (e.g. "17") used as fallback
 */
export async function ingestMatch(
  matchId: string,
  season: string,
  gameday: string,
): Promise<IngestionResult> {
  const data = await fetchMatchInternal<TTBLApiMatch>(matchId);
  if (!data) {
    return { matchId, ingested: false, gamesIngested: 0, reason: "fetch_failed" };
  }

  if (data.matchState !== "Finished") {
    return { matchId, ingested: false, gamesIngested: 0, reason: `state_${data.matchState}` };
  }

  const prisma = resolveClient();
  if (!prisma) {
    return { matchId, ingested: false, gamesIngested: 0, reason: "no_db" };
  }

  const resolvedSeason = parseSeasonFromGameday(data.gameday?.name, season);
  const resolvedGameday = parseGamedayLabel(data.gameday?.name) || gameday;

  // Upsert match
  await prisma.ttblMatch.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      season: resolvedSeason,
      gameday: resolvedGameday,
      timestampMs: toBigIntMs(data.timeStamp),
      matchState: data.matchState,
      isYouth: false,
      homeTeamId: data.homeTeam?.id ?? null,
      homeTeamName: data.homeTeam?.name ?? null,
      homeTeamRank: toIntOrNull(data.homeTeam?.rank),
      homeGameWins: toIntOrNull(data.homeGames),
      homeSetWins: toIntOrNull(data.homeSets),
      awayTeamId: data.awayTeam?.id ?? null,
      awayTeamName: data.awayTeam?.name ?? null,
      awayTeamRank: toIntOrNull(data.awayTeam?.rank),
      awayGameWins: toIntOrNull(data.awayGames),
      awaySetWins: toIntOrNull(data.awaySets),
      gamesCount: data.games?.length ?? 0,
      venue: data.venue?.name ?? null,
    },
    update: {
      matchState: data.matchState,
      homeGameWins: toIntOrNull(data.homeGames),
      homeSetWins: toIntOrNull(data.homeSets),
      awayGameWins: toIntOrNull(data.awayGames),
      awaySetWins: toIntOrNull(data.awaySets),
      gamesCount: data.games?.length ?? 0,
    },
  });

  // Upsert individual games (skip doubles)
  const singlesGames = (data.games ?? []).filter((g) => !isDoubles(g));
  for (const game of singlesGames) {
    // Upsert players
    if (game.homePlayer?.id) {
      await upsertPlayer(prisma, game.homePlayer);
    }
    if (game.awayPlayer?.id) {
      await upsertPlayer(prisma, game.awayPlayer);
    }

    await prisma.ttblGame.upsert({
      where: {
        matchId_gameIndex: {
          matchId: data.id,
          gameIndex: game.index,
        },
      },
      create: {
        matchId: data.id,
        season: resolvedSeason,
        gameday: resolvedGameday,
        timestampMs: toBigIntMs(data.timeStamp),
        gameIndex: game.index,
        format: "singles",
        isYouth: false,
        gameState: game.gameState,
        winnerSide: game.winnerSide ?? null,
        homeSets: toIntOrNull(game.homeSets),
        awaySets: toIntOrNull(game.awaySets),
        set1HomeScore: toIntOrNull(game.set1HomeScore),
        set1AwayScore: toIntOrNull(game.set1AwayScore),
        set2HomeScore: toIntOrNull(game.set2HomeScore),
        set2AwayScore: toIntOrNull(game.set2AwayScore),
        set3HomeScore: toIntOrNull(game.set3HomeScore),
        set3AwayScore: toIntOrNull(game.set3AwayScore),
        set4HomeScore: toIntOrNull(game.set4HomeScore),
        set4AwayScore: toIntOrNull(game.set4AwayScore),
        set5HomeScore: toIntOrNull(game.set5HomeScore),
        set5AwayScore: toIntOrNull(game.set5AwayScore),
        homePlayerId: game.homePlayer?.id ?? null,
        homePlayerName: playerName(game.homePlayer),
        awayPlayerId: game.awayPlayer?.id ?? null,
        awayPlayerName: playerName(game.awayPlayer),
      },
      update: {
        gameState: game.gameState,
        winnerSide: game.winnerSide ?? null,
        homeSets: toIntOrNull(game.homeSets),
        awaySets: toIntOrNull(game.awaySets),
        set1HomeScore: toIntOrNull(game.set1HomeScore),
        set1AwayScore: toIntOrNull(game.set1AwayScore),
        set2HomeScore: toIntOrNull(game.set2HomeScore),
        set2AwayScore: toIntOrNull(game.set2AwayScore),
        set3HomeScore: toIntOrNull(game.set3HomeScore),
        set3AwayScore: toIntOrNull(game.set3AwayScore),
        set4HomeScore: toIntOrNull(game.set4HomeScore),
        set4AwayScore: toIntOrNull(game.set4AwayScore),
        set5HomeScore: toIntOrNull(game.set5HomeScore),
        set5AwayScore: toIntOrNull(game.set5AwayScore),
        homePlayerId: game.homePlayer?.id ?? null,
        homePlayerName: playerName(game.homePlayer),
        awayPlayerId: game.awayPlayer?.id ?? null,
        awayPlayerName: playerName(game.awayPlayer),
      },
    });
  }

  return {
    matchId: data.id,
    ingested: true,
    gamesIngested: singlesGames.length,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveClient() {
  const mode = getDataStoreMode();
  if (!shouldUsePostgres(mode)) return null;
  return getPrismaClient();
}

async function upsertPlayer(
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>,
  player: TTBLApiPlayer,
): Promise<void> {
  const id = player.id?.trim();
  if (!id) return;

  const firstName = player.firstName?.trim() || null;
  const lastName = player.lastName?.trim() || null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;

  await prisma.ttblPlayer.upsert({
    where: { id },
    create: {
      id,
      firstName,
      lastName,
      fullName,
      imageUrl: player.imageUrl?.trim() || null,
    },
    update: {
      firstName,
      lastName,
      fullName,
      imageUrl: player.imageUrl?.trim() || null,
    },
  });
}
