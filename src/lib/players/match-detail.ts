import { getPrismaClient } from "@/lib/db/prisma";
import { getPlayerSlugOverview } from "@/lib/players/slugs";
import {
  TTBLGameRecord,
  TTBLMatchSummary,
  WTTMatch,
} from "@/lib/types";

export type MatchSource = "ttbl" | "wtt";

export interface TTBLGameSetScore {
  setNumber: number;
  homeScore: number | null;
  awayScore: number | null;
}

export interface TTBLMatchDetail {
  source: "ttbl";
  requestedMatchId: string;
  matchId: string;
  gameIndex: number | null;
  found: boolean;
  season: string | null;
  occurredAt: string | null;
  gameday: string | null;
  venue: string | null;
  matchState: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  homeTeamGames: number | null;
  awayTeamGames: number | null;
  homeTeamSets: number | null;
  awayTeamSets: number | null;
  selectedGameIndex: number | null;
  selectedGameState: string | null;
  selectedGameWinnerSide: "Home" | "Away" | null;
  selectedGameHomePlayer: string | null;
  selectedGameHomePlayerSlug: string | null;
  selectedGameAwayPlayer: string | null;
  selectedGameAwayPlayerSlug: string | null;
  selectedGameHomeSets: number | null;
  selectedGameAwaySets: number | null;
  selectedGameSetScores: TTBLGameSetScore[];
  summary: TTBLMatchSummary | null;
  gameStats: TTBLGameRecord | null;
  match: Record<string, unknown> | null;
  selectedGame: Record<string, unknown> | null;
}

export interface WTTMatchDetail {
  source: "wtt";
  requestedMatchId: string;
  matchId: string;
  found: boolean;
  year: string | null;
  occurredAt: string | null;
  tournament: string | null;
  event: string | null;
  stage: string | null;
  round: string | null;
  walkover: boolean | null;
  winnerInferred: "A" | "X" | null;
  playerAName: string | null;
  playerASlug: string | null;
  playerAAssociation: string | null;
  playerXName: string | null;
  playerXSlug: string | null;
  playerXAssociation: string | null;
  finalSetsA: number | null;
  finalSetsX: number | null;
  games: Array<{ gameNumber: number; aPoints: number; xPoints: number }>;
  match: WTTMatch | null;
}

export type PlayerMatchDetail = TTBLMatchDetail | WTTMatchDetail;

interface ParsedTTBLMatchRef {
  matchId: string;
  gameIndex: number | null;
}

function parseTTBLMatchReference(value: string): ParsedTTBLMatchRef {
  const trimmed = value.trim();
  const match = trimmed.match(/^([^:]+)(?::(\d+))?$/);
  if (!match?.[1]) {
    return { matchId: "", gameIndex: null };
  }

  const gameIndex = Number.parseInt(match[2] ?? "", 10);
  return {
    matchId: match[1].trim(),
    gameIndex: Number.isFinite(gameIndex) && gameIndex > 0 ? gameIndex : null,
  };
}

function parseSourceToken(token: string): { source: MatchSource; sourceId: string } | null {
  const trimmed = token.trim();
  const delimiter = trimmed.indexOf(":");
  if (delimiter <= 0) {
    return null;
  }

  const source = trimmed.slice(0, delimiter);
  const sourceId = trimmed.slice(delimiter + 1).trim();
  if ((source !== "ttbl" && source !== "wtt") || !sourceId) {
    return null;
  }

  return { source, sourceId };
}

async function buildSlugBySourceKey(): Promise<Map<string, string>> {
  const overview = await getPlayerSlugOverview(Number.MAX_SAFE_INTEGER);
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const row of overview.players) {
    for (const sourceToken of row.sourceIds) {
      const parsed = parseSourceToken(sourceToken);
      if (!parsed) {
        continue;
      }

      const key = `${parsed.source}:${parsed.sourceId}`;
      const existing = map.get(key);
      if (existing && existing !== row.slug) {
        map.delete(key);
        ambiguous.add(key);
        continue;
      }

      if (!ambiguous.has(key)) {
        map.set(key, row.slug);
      }
    }
  }

  return map;
}

function toIsoFromUnixSeconds(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  return new Date((value as number) * 1000).toISOString();
}

function toIsoFromYear(value: string | null): string | null {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(Date.UTC(parsed, 0, 1)).toISOString();
}

async function getTTBLMatchDetail(requestedMatchId: string): Promise<TTBLMatchDetail> {
  const parsed = parseTTBLMatchReference(requestedMatchId);
  const slugBySourceKey = await buildSlugBySourceKey();
  const baseDetail: TTBLMatchDetail = {
    source: "ttbl",
    requestedMatchId,
    matchId: parsed.matchId,
    gameIndex: parsed.gameIndex,
    found: false,
    season: null,
    occurredAt: null,
    gameday: null,
    venue: null,
    matchState: null,
    homeTeamName: null,
    awayTeamName: null,
    homeTeamGames: null,
    awayTeamGames: null,
    homeTeamSets: null,
    awayTeamSets: null,
    selectedGameIndex: parsed.gameIndex,
    selectedGameState: null,
    selectedGameWinnerSide: null,
    selectedGameHomePlayer: null,
    selectedGameHomePlayerSlug: null,
    selectedGameAwayPlayer: null,
    selectedGameAwayPlayerSlug: null,
    selectedGameHomeSets: null,
    selectedGameAwaySets: null,
    selectedGameSetScores: [],
    summary: null,
    gameStats: null,
    match: null,
    selectedGame: null,
  };

  if (!parsed.matchId) {
    return baseDetail;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required in Postgres mode.");
  }

  const match = await prisma.ttblMatch.findUnique({
    where: { id: parsed.matchId },
    include: {
      games: {
        orderBy: { gameIndex: "asc" },
      },
    },
  });

  if (!match) {
    return baseDetail;
  }

  const selectedGame =
    parsed.gameIndex !== null
      ? match.games.find((row) => row.gameIndex === parsed.gameIndex) ?? null
      : match.games[0] ?? null;

  const summary: TTBLMatchSummary = {
    matchId: match.id,
    matchState: match.matchState,
    gameday: match.gameday,
    timestamp: Number(match.timestampMs),
    isYouth: match.isYouth,
    homeTeam: {
      id: match.homeTeamId ?? "",
      name: match.homeTeamName ?? "Unknown",
      rank: match.homeTeamRank ?? 0,
      gameWins: match.homeGameWins ?? 0,
      setWins: match.homeSetWins ?? 0,
    },
    awayTeam: {
      id: match.awayTeamId ?? "",
      name: match.awayTeamName ?? "Unknown",
      rank: match.awayTeamRank ?? 0,
      gameWins: match.awayGameWins ?? 0,
      setWins: match.awaySetWins ?? 0,
    },
    gamesCount: match.gamesCount,
    venue: match.venue ?? "Unknown",
  };

  const gameStats: TTBLGameRecord | null = selectedGame
    ? {
        matchId: match.id,
        gameday: match.gameday,
        timestamp: Number(selectedGame.timestampMs),
        gameIndex: selectedGame.gameIndex,
        format: selectedGame.format === "doubles" ? "doubles" : "singles",
        isYouth: selectedGame.isYouth,
        gameState: selectedGame.gameState,
        winnerSide: selectedGame.winnerSide === "Home" || selectedGame.winnerSide === "Away" ? selectedGame.winnerSide : null,
        homePlayer: {
          id: selectedGame.homePlayerId,
          name: selectedGame.homePlayerName ?? "Unknown",
        },
        awayPlayer: {
          id: selectedGame.awayPlayerId,
          name: selectedGame.awayPlayerName ?? "Unknown",
        },
      }
    : null;

  return {
    source: "ttbl",
    requestedMatchId,
    matchId: parsed.matchId,
    gameIndex: parsed.gameIndex,
    found: true,
    season: match.season,
    occurredAt: toIsoFromUnixSeconds(Number(match.timestampMs)),
    gameday: match.gameday,
    venue: match.venue,
    matchState: match.matchState,
    homeTeamName: match.homeTeamName,
    awayTeamName: match.awayTeamName,
    homeTeamGames: match.homeGameWins,
    awayTeamGames: match.awayGameWins,
    homeTeamSets: match.homeSetWins,
    awayTeamSets: match.awaySetWins,
    selectedGameIndex: selectedGame?.gameIndex ?? parsed.gameIndex,
    selectedGameState: selectedGame?.gameState ?? null,
    selectedGameWinnerSide:
      selectedGame?.winnerSide === "Home" || selectedGame?.winnerSide === "Away"
        ? selectedGame.winnerSide
        : null,
    selectedGameHomePlayer: selectedGame?.homePlayerName ?? null,
    selectedGameHomePlayerSlug: selectedGame?.homePlayerId
      ? slugBySourceKey.get(`ttbl:${selectedGame.homePlayerId}`) ?? null
      : null,
    selectedGameAwayPlayer: selectedGame?.awayPlayerName ?? null,
    selectedGameAwayPlayerSlug: selectedGame?.awayPlayerId
      ? slugBySourceKey.get(`ttbl:${selectedGame.awayPlayerId}`) ?? null
      : null,
    selectedGameHomeSets: null,
    selectedGameAwaySets: null,
    selectedGameSetScores: [],
    summary,
    gameStats,
    match: {
      id: match.id,
      matchState: match.matchState,
      season: match.season,
      gameday: match.gameday,
      venue: match.venue,
      timestamp: Number(match.timestampMs),
      homeTeam: match.homeTeamName,
      awayTeam: match.awayTeamName,
    },
    selectedGame: selectedGame
      ? {
          index: selectedGame.gameIndex,
          gameState: selectedGame.gameState,
          winnerSide: selectedGame.winnerSide,
          homePlayer: selectedGame.homePlayerName,
          awayPlayer: selectedGame.awayPlayerName,
        }
      : null,
  };
}

async function getWTTMatchDetail(requestedMatchId: string): Promise<WTTMatchDetail> {
  const matchId = requestedMatchId.trim();
  const slugBySourceKey = await buildSlugBySourceKey();
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required in Postgres mode.");
  }

  const row = await prisma.wttMatch.findUnique({
    where: { id: matchId },
    include: {
      games: {
        orderBy: { gameNumber: "asc" },
      },
    },
  });

  const year = row?.year ? String(row.year) : null;
  const match: WTTMatch | null = row
    ? {
        match_id: row.id,
        source_match_id: row.sourceMatchId,
        event_id: row.eventId,
        sub_event_code: row.subEventCode,
        year,
        last_updated_at: row.lastUpdatedAt?.toISOString() ?? null,
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
        games: row.games.map((game) => ({
          game_number: game.gameNumber,
          a_points: game.aPoints,
          x_points: game.xPoints,
        })),
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
      }
    : null;

  return {
    source: "wtt",
    requestedMatchId,
    matchId,
    found: Boolean(match),
    year,
    occurredAt: row?.lastUpdatedAt?.toISOString() ?? toIsoFromYear(year),
    tournament: row?.tournament ?? null,
    event: row?.event ?? null,
    stage: row?.stage ?? null,
    round: row?.round ?? null,
    walkover: typeof row?.walkover === "boolean" ? row.walkover : null,
    winnerInferred:
      row?.winnerInferred === "A" || row?.winnerInferred === "X"
        ? row.winnerInferred
        : null,
    playerAName: row?.playerAName ?? row?.playerAId ?? null,
    playerASlug: row?.playerAId
      ? slugBySourceKey.get(`wtt:${row.playerAId}`) ?? null
      : null,
    playerAAssociation: row?.playerAAssoc ?? null,
    playerXName: row?.playerXName ?? row?.playerXId ?? null,
    playerXSlug: row?.playerXId
      ? slugBySourceKey.get(`wtt:${row.playerXId}`) ?? null
      : null,
    playerXAssociation: row?.playerXAssoc ?? null,
    finalSetsA: row?.finalSetsA ?? null,
    finalSetsX: row?.finalSetsX ?? null,
    games:
      row?.games.map((game) => ({
        gameNumber: game.gameNumber,
        aPoints: game.aPoints,
        xPoints: game.xPoints,
      })) ?? [],
    match,
  };
}

export async function getPlayerMatchDetail(
  source: MatchSource,
  matchId: string,
): Promise<PlayerMatchDetail> {
  if (source === "ttbl") {
    return await getTTBLMatchDetail(matchId);
  }

  return await getWTTMatchDetail(matchId);
}
