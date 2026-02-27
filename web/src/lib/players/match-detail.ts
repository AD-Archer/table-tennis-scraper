import path from "node:path";
import { promises as fs } from "node:fs";
import { assertDataPath, fileExists, readJson } from "@/lib/fs";
import { TTBL_SEASONS_DIR, WTT_OUTPUT_DIR, getTTBLReadDir } from "@/lib/paths";
import {
  TTBLGameRecord,
  TTBLMatchSummary,
  TTBLMetadata,
  WTTMatch,
} from "@/lib/types";

export type MatchSource = "ttbl" | "wtt";

interface TTBLSeasonEntry {
  season: string;
  dir: string;
}

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
  selectedGameAwayPlayer: string | null;
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
  playerAAssociation: string | null;
  playerXName: string | null;
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

function parseSeasonStart(value: string | null | undefined): number {
  const match = value?.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (!match?.[1]) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

function toIsoFromUnixSeconds(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function toIsoFromYear(value: string | null): string | null {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(Date.UTC(parsed, 0, 1)).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toNullableName(value: unknown): string | null {
  const direct = toNullableString(value);
  if (direct) {
    return direct;
  }

  const row = asRecord(value);
  return toNullableString(row?.name);
}

function pickPreferredScore(...values: Array<number | null | undefined>): number | null {
  let sawZero = false;

  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }

    const numeric = Number(value);
    if (numeric > 0) {
      return numeric;
    }

    if (numeric === 0) {
      sawZero = true;
    }
  }

  return sawZero ? 0 : null;
}

function parseWinnerSide(value: unknown): "Home" | "Away" | null {
  if (value === "Home" || value === "Away") {
    return value;
  }

  return null;
}

function buildSetScores(game: Record<string, unknown> | null): TTBLGameSetScore[] {
  if (!game) {
    return [];
  }

  const rows: TTBLGameSetScore[] = [];
  for (let setNumber = 1; setNumber <= 5; setNumber += 1) {
    const homeScore = toNullableNumber(game[`set${setNumber}HomeScore`]);
    const awayScore = toNullableNumber(game[`set${setNumber}AwayScore`]);
    if (homeScore === null && awayScore === null) {
      continue;
    }

    rows.push({
      setNumber,
      homeScore,
      awayScore,
    });
  }

  return rows;
}

function selectTTBLGame(
  matchPayload: Record<string, unknown> | null,
  gameIndex: number | null,
): Record<string, unknown> | null {
  if (!matchPayload || gameIndex === null) {
    return null;
  }

  const games = Array.isArray(matchPayload.games) ? matchPayload.games : [];
  for (const row of games) {
    const game = asRecord(row);
    if (!game) {
      continue;
    }

    if (toNullableNumber(game.index) === gameIndex) {
      return game;
    }
  }

  const fallback = games[gameIndex - 1];
  return asRecord(fallback);
}

function deriveTTBLTotalsFromGames(matchPayload: Record<string, unknown> | null): {
  homeGames: number | null;
  awayGames: number | null;
  homeSets: number | null;
  awaySets: number | null;
} {
  if (!matchPayload) {
    return {
      homeGames: null,
      awayGames: null,
      homeSets: null,
      awaySets: null,
    };
  }

  const games = Array.isArray(matchPayload.games) ? matchPayload.games : [];
  let homeGames = 0;
  let awayGames = 0;
  let homeSets = 0;
  let awaySets = 0;
  let hasWinner = false;
  let hasSetTotals = false;

  for (const row of games) {
    const game = asRecord(row);
    if (!game) {
      continue;
    }

    const gameHomeSets = toNullableNumber(game.homeSets);
    const gameAwaySets = toNullableNumber(game.awaySets);
    if (gameHomeSets !== null) {
      homeSets += gameHomeSets;
      hasSetTotals = true;
    }
    if (gameAwaySets !== null) {
      awaySets += gameAwaySets;
      hasSetTotals = true;
    }

    let winner = parseWinnerSide(game.winnerSide);
    if (!winner && gameHomeSets !== null && gameAwaySets !== null && gameHomeSets !== gameAwaySets) {
      winner = gameHomeSets > gameAwaySets ? "Home" : "Away";
    }

    if (winner === "Home") {
      homeGames += 1;
      hasWinner = true;
    } else if (winner === "Away") {
      awayGames += 1;
      hasWinner = true;
    }
  }

  return {
    homeGames: hasWinner ? homeGames : null,
    awayGames: hasWinner ? awayGames : null,
    homeSets: hasSetTotals ? homeSets : null,
    awaySets: hasSetTotals ? awaySets : null,
  };
}

function byMostRecentSeason(entries: TTBLSeasonEntry[]): TTBLSeasonEntry[] {
  return [...entries].sort((a, b) => parseSeasonStart(b.season) - parseSeasonStart(a.season));
}

async function listTTBLSeasonEntries(): Promise<TTBLSeasonEntry[]> {
  const entries = new Map<string, string>();

  if (await fileExists(TTBL_SEASONS_DIR)) {
    assertDataPath(TTBL_SEASONS_DIR);
    const rows = await fs.readdir(TTBL_SEASONS_DIR, { withFileTypes: true });
    for (const row of rows) {
      if (!row.isDirectory()) {
        continue;
      }

      const seasonDir = path.join(TTBL_SEASONS_DIR, row.name);
      const metadata = await readJson<TTBLMetadata>(
        path.join(seasonDir, "metadata.json"),
        null,
      );
      const season = metadata?.season ?? row.name;
      if (season.trim()) {
        entries.set(season, seasonDir);
      }
    }
  }

  const readDir = getTTBLReadDir();
  const currentMeta = await readJson<TTBLMetadata>(path.join(readDir, "metadata.json"), null);
  if (currentMeta?.season?.trim()) {
    entries.set(currentMeta.season, readDir);
  }

  return byMostRecentSeason(
    [...entries.entries()].map(([season, dir]) => ({ season, dir })),
  );
}

async function getTTBLMatchDetail(requestedMatchId: string): Promise<TTBLMatchDetail> {
  const parsed = parseTTBLMatchReference(requestedMatchId);
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
    selectedGameAwayPlayer: null,
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

  const seasonEntries = await listTTBLSeasonEntries();

  for (const entry of seasonEntries) {
    const matchPath = path.join(entry.dir, "matches", `match_${parsed.matchId}.json`);
    if (!(await fileExists(matchPath))) {
      continue;
    }

    const [metadata, summaryRows, matchPayload, gameRows] = await Promise.all([
      readJson<TTBLMetadata>(path.join(entry.dir, "metadata.json"), null),
      readJson<TTBLMatchSummary[]>(path.join(entry.dir, "matches_summary.json"), []),
      readJson<Record<string, unknown>>(matchPath, null),
      readJson<TTBLGameRecord[]>(path.join(entry.dir, "stats", "games_data.json"), []),
    ]);

    const summary = (summaryRows ?? []).find((row) => row.matchId === parsed.matchId) ?? null;
    const gameStats =
      (gameRows ?? []).find(
        (row) =>
          row.matchId === parsed.matchId &&
          (parsed.gameIndex === null || row.gameIndex === parsed.gameIndex),
      ) ?? null;
    const selectedGame = selectTTBLGame(matchPayload, parsed.gameIndex);
    const selectedGameRow = selectedGame ? asRecord(selectedGame) : null;
    const selectedGameHomePlayer = asRecord(selectedGameRow?.homePlayer);
    const selectedGameAwayPlayer = asRecord(selectedGameRow?.awayPlayer);
    const homeTeam = asRecord(matchPayload?.homeTeam);
    const awayTeam = asRecord(matchPayload?.awayTeam);
    const derivedTotals = deriveTTBLTotalsFromGames(matchPayload);

    const occurredAt =
      toIsoFromUnixSeconds(summary?.timestamp) ??
      toIsoFromUnixSeconds(toNullableNumber(matchPayload?.timeStamp)) ??
      toIsoFromUnixSeconds(gameStats?.timestamp);

    return {
      source: "ttbl",
      requestedMatchId,
      matchId: parsed.matchId,
      gameIndex: parsed.gameIndex,
      found: true,
      season: metadata?.season ?? entry.season,
      occurredAt,
      gameday: summary?.gameday ?? toNullableName(matchPayload?.gameday) ?? gameStats?.gameday ?? null,
      venue: summary?.venue ?? toNullableName(matchPayload?.venue),
      matchState: toNullableString(matchPayload?.matchState) ?? summary?.matchState ?? null,
      homeTeamName: summary?.homeTeam?.name ?? toNullableString(homeTeam?.name),
      awayTeamName: summary?.awayTeam?.name ?? toNullableString(awayTeam?.name),
      homeTeamGames: pickPreferredScore(
        toNullableNumber(matchPayload?.homeGames),
        summary?.homeTeam?.gameWins ?? null,
        derivedTotals.homeGames,
      ),
      awayTeamGames: pickPreferredScore(
        toNullableNumber(matchPayload?.awayGames),
        summary?.awayTeam?.gameWins ?? null,
        derivedTotals.awayGames,
      ),
      homeTeamSets: pickPreferredScore(
        toNullableNumber(matchPayload?.homeSets),
        summary?.homeTeam?.setWins ?? null,
        derivedTotals.homeSets,
      ),
      awayTeamSets: pickPreferredScore(
        toNullableNumber(matchPayload?.awaySets),
        summary?.awayTeam?.setWins ?? null,
        derivedTotals.awaySets,
      ),
      selectedGameIndex:
        toNullableNumber(selectedGameRow?.index) ?? gameStats?.gameIndex ?? parsed.gameIndex,
      selectedGameState:
        toNullableString(selectedGameRow?.gameState) ?? gameStats?.gameState ?? null,
      selectedGameWinnerSide:
        parseWinnerSide(selectedGameRow?.winnerSide) ?? gameStats?.winnerSide ?? null,
      selectedGameHomePlayer:
        toNullableString(selectedGameHomePlayer?.name) ?? gameStats?.homePlayer?.name ?? null,
      selectedGameAwayPlayer:
        toNullableString(selectedGameAwayPlayer?.name) ?? gameStats?.awayPlayer?.name ?? null,
      selectedGameHomeSets: toNullableNumber(selectedGameRow?.homeSets),
      selectedGameAwaySets: toNullableNumber(selectedGameRow?.awaySets),
      selectedGameSetScores: buildSetScores(selectedGameRow),
      summary,
      gameStats,
      match: matchPayload,
      selectedGame,
    };
  }

  return baseDetail;
}

async function getWTTMatchDetail(requestedMatchId: string): Promise<WTTMatchDetail> {
  const matchId = requestedMatchId.trim();
  const matches =
    (await readJson<WTTMatch[]>(path.join(WTT_OUTPUT_DIR, "matches.json"), [])) ?? [];
  const match = matches.find((row) => row.match_id === matchId) ?? null;

  return {
    source: "wtt",
    requestedMatchId,
    matchId,
    found: Boolean(match),
    year: match?.year ?? null,
    occurredAt: toIsoFromYear(match?.year ?? null),
    tournament: match?.tournament ?? null,
    event: match?.event ?? null,
    stage: match?.stage ?? null,
    round: match?.round ?? null,
    walkover: typeof match?.walkover === "boolean" ? match.walkover : null,
    winnerInferred: match?.winner_inferred ?? null,
    playerAName: match?.players.a.name ?? match?.players.a.ittf_id ?? null,
    playerAAssociation: match?.players.a.association ?? null,
    playerXName: match?.players.x.name ?? match?.players.x.ittf_id ?? null,
    playerXAssociation: match?.players.x.association ?? null,
    finalSetsA:
      typeof match?.final_sets.a === "number" && Number.isFinite(match.final_sets.a)
        ? match.final_sets.a
        : null,
    finalSetsX:
      typeof match?.final_sets.x === "number" && Number.isFinite(match.final_sets.x)
        ? match.final_sets.x
        : null,
    games:
      match?.games.map((row) => ({
        gameNumber: row.game_number,
        aPoints: row.a_points,
        xPoints: row.x_points,
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
