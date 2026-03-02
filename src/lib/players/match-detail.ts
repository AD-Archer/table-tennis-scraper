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
const TTBL_LIVE_MATCH_ENDPOINT = "https://www.ttbl.de/api/internal/match";

interface ParsedTTBLMatchRef {
  matchId: string;
  gameIndex: number | null;
}

interface TTBLLiveGamePayload {
  index?: number;
  gameState?: string;
  winnerSide?: "Home" | "Away" | null;
  homeDouble?: { id?: string } | null;
  awayDouble?: { id?: string } | null;
  homeSets?: number | null;
  awaySets?: number | null;
  set1HomeScore?: number | null;
  set1AwayScore?: number | null;
  set2HomeScore?: number | null;
  set2AwayScore?: number | null;
  set3HomeScore?: number | null;
  set3AwayScore?: number | null;
  set4HomeScore?: number | null;
  set4AwayScore?: number | null;
  set5HomeScore?: number | null;
  set5AwayScore?: number | null;
}

interface TTBLLiveMatchPayload {
  id?: string;
  homeGameWins?: number | null;
  awayGameWins?: number | null;
  homeSetWins?: number | null;
  awaySetWins?: number | null;
  games?: TTBLLiveGamePayload[];
}

interface TTBLGameRowCompat {
  matchId: string;
  gameday: string;
  timestampMs: bigint;
  gameIndex: number;
  format: string | null;
  isYouth: boolean;
  gameState: string;
  winnerSide: string | null;
  homeSets?: number | null;
  awaySets?: number | null;
  set1HomeScore?: number | null;
  set1AwayScore?: number | null;
  set2HomeScore?: number | null;
  set2AwayScore?: number | null;
  set3HomeScore?: number | null;
  set3AwayScore?: number | null;
  set4HomeScore?: number | null;
  set4AwayScore?: number | null;
  set5HomeScore?: number | null;
  set5AwayScore?: number | null;
  homePlayerId: string | null;
  homePlayerName: string | null;
  awayPlayerId: string | null;
  awayPlayerName: string | null;
}

interface TTBLMatchRowCompat {
  id: string;
  season: string;
  gameday: string;
  timestampMs: bigint;
  matchState: string;
  isYouth: boolean;
  homeTeamId: string | null;
  homeTeamName: string | null;
  homeTeamRank: number | null;
  homeGameWins: number | null;
  homeSetWins: number | null;
  awayTeamId: string | null;
  awayTeamName: string | null;
  awayTeamRank: number | null;
  awayGameWins: number | null;
  awaySetWins: number | null;
  gamesCount: number;
  venue: string | null;
  games: TTBLGameRowCompat[];
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

function toNullableInt(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value as number);
}

function buildTTBLSetScoresFromDbGame(game: {
  set1HomeScore?: number | null;
  set1AwayScore?: number | null;
  set2HomeScore?: number | null;
  set2AwayScore?: number | null;
  set3HomeScore?: number | null;
  set3AwayScore?: number | null;
  set4HomeScore?: number | null;
  set4AwayScore?: number | null;
  set5HomeScore?: number | null;
  set5AwayScore?: number | null;
}): TTBLGameSetScore[] {
  const rows: TTBLGameSetScore[] = [];

  const values: Array<[number, number | null | undefined, number | null | undefined]> = [
    [1, game.set1HomeScore, game.set1AwayScore],
    [2, game.set2HomeScore, game.set2AwayScore],
    [3, game.set3HomeScore, game.set3AwayScore],
    [4, game.set4HomeScore, game.set4AwayScore],
    [5, game.set5HomeScore, game.set5AwayScore],
  ];

  for (const [setNumber, homeScore, awayScore] of values) {
    const normalizedHome = toNullableInt(homeScore);
    const normalizedAway = toNullableInt(awayScore);
    if (normalizedHome === null && normalizedAway === null) {
      continue;
    }

    rows.push({
      setNumber,
      homeScore: normalizedHome,
      awayScore: normalizedAway,
    });
  }

  return rows;
}

async function fetchTTBLLiveMatchPayload(matchId: string): Promise<TTBLLiveMatchPayload | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(`${TTBL_LIVE_MATCH_ENDPOINT}/${encodeURIComponent(matchId)}`, {
      headers: {
        "user-agent": "TTBL-NextJS-Scraper/1.0",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as TTBLLiveMatchPayload;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
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

  const gameSelectWithScores = {
    matchId: true,
    gameday: true,
    timestampMs: true,
    gameIndex: true,
    format: true,
    isYouth: true,
    gameState: true,
    winnerSide: true,
    homeSets: true,
    awaySets: true,
    set1HomeScore: true,
    set1AwayScore: true,
    set2HomeScore: true,
    set2AwayScore: true,
    set3HomeScore: true,
    set3AwayScore: true,
    set4HomeScore: true,
    set4AwayScore: true,
    set5HomeScore: true,
    set5AwayScore: true,
    homePlayerId: true,
    homePlayerName: true,
    awayPlayerId: true,
    awayPlayerName: true,
  } as const;

  const gameSelectLegacy = {
    matchId: true,
    gameday: true,
    timestampMs: true,
    gameIndex: true,
    format: true,
    isYouth: true,
    gameState: true,
    winnerSide: true,
    homePlayerId: true,
    homePlayerName: true,
    awayPlayerId: true,
    awayPlayerName: true,
  } as const;

  let match: TTBLMatchRowCompat | null = null;

  try {
    match = (await prisma.ttblMatch.findUnique({
      where: { id: parsed.matchId },
      include: {
        games: {
          orderBy: { gameIndex: "asc" },
          select: gameSelectWithScores,
        },
      },
    })) as TTBLMatchRowCompat | null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/set\d(home|away)score|homesets|awaysets|column/i.test(message)) {
      throw error;
    }

    match = (await prisma.ttblMatch.findUnique({
      where: { id: parsed.matchId },
      include: {
        games: {
          orderBy: { gameIndex: "asc" },
          select: gameSelectLegacy,
        },
      },
    })) as TTBLMatchRowCompat | null;
  }

  if (!match) {
    return baseDetail;
  }

  const matchGames = match.games ?? [];

  const selectedGame =
    parsed.gameIndex !== null
      ? matchGames.find((row) => row.gameIndex === parsed.gameIndex) ?? null
      : matchGames[0] ?? null;
  const liveMatch = await fetchTTBLLiveMatchPayload(parsed.matchId);
  const liveGames = liveMatch?.games ?? [];
  const liveSelectedGame =
    parsed.gameIndex !== null
      ? liveGames.find((row) => (toNullableInt(row.index) ?? 0) === parsed.gameIndex) ?? null
      : liveGames[0] ?? null;

  const finishedSinglesGames = matchGames.filter(
    (row) =>
      (row.format === null || row.format === "singles") && row.gameState === "Finished",
  );
  const derivedHomeGameWins = finishedSinglesGames.filter((row) => row.winnerSide === "Home").length;
  const derivedAwayGameWins = finishedSinglesGames.filter((row) => row.winnerSide === "Away").length;
  const derivedHomeSetWins = finishedSinglesGames.reduce(
    (sum, row) => sum + (toNullableInt(row.homeSets) ?? 0),
    0,
  );
  const derivedAwaySetWins = finishedSinglesGames.reduce(
    (sum, row) => sum + (toNullableInt(row.awaySets) ?? 0),
    0,
  );

  const liveFinishedSinglesGames = liveGames.filter(
    (row) => !row.homeDouble && !row.awayDouble && row.gameState === "Finished",
  );
  const derivedLiveHomeGameWins = liveFinishedSinglesGames.filter(
    (row) => row.winnerSide === "Home",
  ).length;
  const derivedLiveAwayGameWins = liveFinishedSinglesGames.filter(
    (row) => row.winnerSide === "Away",
  ).length;
  const derivedLiveHomeSetWins = liveFinishedSinglesGames.reduce(
    (sum, row) => sum + (toNullableInt(row.homeSets) ?? 0),
    0,
  );
  const derivedLiveAwaySetWins = liveFinishedSinglesGames.reduce(
    (sum, row) => sum + (toNullableInt(row.awaySets) ?? 0),
    0,
  );

  const liveHomeGameWins = toNullableInt(liveMatch?.homeGameWins);
  const liveAwayGameWins = toNullableInt(liveMatch?.awayGameWins);
  const liveHomeSetWins = toNullableInt(liveMatch?.homeSetWins);
  const liveAwaySetWins = toNullableInt(liveMatch?.awaySetWins);

  const homeTeamGames = toNullableInt(match.homeGameWins) ?? derivedHomeGameWins;
  const awayTeamGames = toNullableInt(match.awayGameWins) ?? derivedAwayGameWins;
  const homeTeamSets =
    toNullableInt(match.homeSetWins) ??
    (derivedHomeSetWins > 0
      ? derivedHomeSetWins
      : liveHomeSetWins ?? derivedLiveHomeSetWins);
  const awayTeamSets =
    toNullableInt(match.awaySetWins) ??
    (derivedAwaySetWins > 0
      ? derivedAwaySetWins
      : liveAwaySetWins ?? derivedLiveAwaySetWins);
  const resolvedHomeTeamGames =
    homeTeamGames > 0 ? homeTeamGames : liveHomeGameWins ?? derivedLiveHomeGameWins;
  const resolvedAwayTeamGames =
    awayTeamGames > 0 ? awayTeamGames : liveAwayGameWins ?? derivedLiveAwayGameWins;

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
      gameWins: resolvedHomeTeamGames,
      setWins: homeTeamSets,
    },
    awayTeam: {
      id: match.awayTeamId ?? "",
      name: match.awayTeamName ?? "Unknown",
      rank: match.awayTeamRank ?? 0,
      gameWins: resolvedAwayTeamGames,
      setWins: awayTeamSets,
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
        homeSets: toNullableInt(selectedGame.homeSets),
        awaySets: toNullableInt(selectedGame.awaySets),
        set1HomeScore: toNullableInt(selectedGame.set1HomeScore),
        set1AwayScore: toNullableInt(selectedGame.set1AwayScore),
        set2HomeScore: toNullableInt(selectedGame.set2HomeScore),
        set2AwayScore: toNullableInt(selectedGame.set2AwayScore),
        set3HomeScore: toNullableInt(selectedGame.set3HomeScore),
        set3AwayScore: toNullableInt(selectedGame.set3AwayScore),
        set4HomeScore: toNullableInt(selectedGame.set4HomeScore),
        set4AwayScore: toNullableInt(selectedGame.set4AwayScore),
        set5HomeScore: toNullableInt(selectedGame.set5HomeScore),
        set5AwayScore: toNullableInt(selectedGame.set5AwayScore),
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
    homeTeamGames: resolvedHomeTeamGames,
    awayTeamGames: resolvedAwayTeamGames,
    homeTeamSets,
    awayTeamSets,
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
    selectedGameHomeSets:
      (selectedGame ? toNullableInt(selectedGame.homeSets) : null) ??
      (liveSelectedGame ? toNullableInt(liveSelectedGame.homeSets) : null),
    selectedGameAwaySets:
      (selectedGame ? toNullableInt(selectedGame.awaySets) : null) ??
      (liveSelectedGame ? toNullableInt(liveSelectedGame.awaySets) : null),
    selectedGameSetScores:
      selectedGame && buildTTBLSetScoresFromDbGame(selectedGame).length > 0
        ? buildTTBLSetScoresFromDbGame(selectedGame)
        : liveSelectedGame
          ? buildTTBLSetScoresFromDbGame(liveSelectedGame)
          : [],
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
      homeGameWins: resolvedHomeTeamGames,
      awayGameWins: resolvedAwayTeamGames,
      homeSetWins: homeTeamSets,
      awaySetWins: awayTeamSets,
    },
    selectedGame: selectedGame
      ? {
          index: selectedGame.gameIndex,
          gameState: selectedGame.gameState,
          winnerSide: selectedGame.winnerSide,
          homeSets: toNullableInt(selectedGame.homeSets),
          awaySets: toNullableInt(selectedGame.awaySets),
          set1HomeScore: toNullableInt(selectedGame.set1HomeScore),
          set1AwayScore: toNullableInt(selectedGame.set1AwayScore),
          set2HomeScore: toNullableInt(selectedGame.set2HomeScore),
          set2AwayScore: toNullableInt(selectedGame.set2AwayScore),
          set3HomeScore: toNullableInt(selectedGame.set3HomeScore),
          set3AwayScore: toNullableInt(selectedGame.set3AwayScore),
          set4HomeScore: toNullableInt(selectedGame.set4HomeScore),
          set4AwayScore: toNullableInt(selectedGame.set4AwayScore),
          set5HomeScore: toNullableInt(selectedGame.set5HomeScore),
          set5AwayScore: toNullableInt(selectedGame.set5AwayScore),
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
