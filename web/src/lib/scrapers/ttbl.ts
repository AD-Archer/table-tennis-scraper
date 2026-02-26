import path from "node:path";
import { ensureDir, sleep, writeJson, writeText } from "@/lib/fs";
import { TTBL_LEGACY_INDEX_FILE, TTBL_OUTPUT_DIR, TTBL_SEASONS_DIR } from "@/lib/paths";
import {
  TTBLLegacyIndex,
  TTBLLegacyIndexRow,
  TTBLGameRecord,
  TTBLMatchSummary,
  TTBLMetadata,
  TTBLPlayerStats,
} from "@/lib/types";

const TTBL_BASE_URL = "https://www.ttbl.de";
const TTBL_MATCH_ENDPOINT = `${TTBL_BASE_URL}/api/internal/match`;

const GAME_LINK_REGEX = /\/bundesliga\/gameday\/(\d{4}-\d{4})\/(\d{1,3})\/([a-f0-9-]{36})/gi;

const DEFAULT_SEASON = "2024-2025";
const DEFAULT_DELAY_MS = 300;
const AUTO_GAMEDAY_SCAN_MAX = 80;
const AUTO_GAMEDAY_EMPTY_STREAK = 4;
const AUTO_GAMEDAY_MIN_SCAN = 10;

export interface TTBLScrapeOptions {
  season?: string;
  numGamedays?: number;
  delayMs?: number;
  outputDir?: string;
  onLog?: (message: string) => void;
}

export interface TTBLScrapeResult {
  metadata: TTBLMetadata;
  discoveredMatchIds: number;
  writtenRawMatches: number;
  outputDir: string;
  failedGamedays: Array<{ gameday: number; reason: string }>;
}

export interface TTBLLegacyScrapeOptions {
  seasons: string[];
  numGamedays?: number;
  delayMs?: number;
  onLog?: (message: string) => void;
}

export interface TTBLLegacyScrapeResult {
  generatedAt: string;
  seasons: string[];
  results: TTBLScrapeResult[];
}

export interface TTBLDiscoverOptions {
  startYear?: number;
  endYear?: number;
  delayMs?: number;
  onLog?: (message: string) => void;
}

export interface TTBLAllTimeScrapeOptions {
  startYear?: number;
  endYear?: number;
  numGamedays?: number;
  delayMs?: number;
  onLog?: (message: string) => void;
}

export interface TTBLAllTimeScrapeResult {
  generatedAt: string;
  discoveredSeasons: string[];
  legacy: TTBLLegacyScrapeResult;
  current: TTBLScrapeResult | null;
}

interface TTBLRawPlayer {
  id?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
}

interface TTBLRawGame {
  index?: number;
  gameState?: string;
  winnerSide?: "Home" | "Away" | null;
  homePlayer?: TTBLRawPlayer | null;
  awayPlayer?: TTBLRawPlayer | null;
  homeLeaguePlayer?: TTBLRawPlayer | null;
  awayLeaguePlayer?: TTBLRawPlayer | null;
}

interface TTBLRawMatch {
  id?: string;
  matchState?: string;
  timeStamp?: number;
  gameday?: { name?: string };
  homeTeam?: { id?: string; name?: string; rank?: number };
  awayTeam?: { id?: string; name?: string; rank?: number };
  homeGameWins?: number;
  awayGameWins?: number;
  homeSetWins?: number;
  awaySetWins?: number;
  venue?: { name?: string };
  games?: TTBLRawGame[];
  homePlayerOne?: TTBLRawPlayer | null;
  homePlayerTwo?: TTBLRawPlayer | null;
  homePlayerThree?: TTBLRawPlayer | null;
  guestPlayerOne?: TTBLRawPlayer | null;
  guestPlayerTwo?: TTBLRawPlayer | null;
  guestPlayerThree?: TTBLRawPlayer | null;
}

interface TTBLGamedayLink {
  season: string;
  gameday: number;
  matchId: string;
}

function emit(log: ((message: string) => void) | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] [TTBL] ${message}`);
}

function nameFromRawPlayer(player?: TTBLRawPlayer | null): string {
  if (!player) {
    return "Unknown";
  }

  const full = `${player.firstName ?? ""} ${player.lastName ?? ""}`.trim();
  return full || "Unknown";
}

function getScheduleUrl(season: string, gameday: number): string {
  return `${TTBL_BASE_URL}/bundesliga/gameschedule/${season}/${gameday}/all`;
}

function parseGamedayLinksFromHtml(html: string): TTBLGamedayLink[] {
  const out = new Map<string, TTBLGamedayLink>();

  for (const match of html.matchAll(GAME_LINK_REGEX)) {
    const season = match[1];
    const gamedayRaw = match[2];
    const matchId = match[3];

    if (!season || !gamedayRaw || !matchId) {
      continue;
    }

    const gameday = Number.parseInt(gamedayRaw, 10);
    if (!Number.isFinite(gameday)) {
      continue;
    }

    const key = `${season}-${gameday}-${matchId}`;
    out.set(key, { season, gameday, matchId });
  }

  return [...out.values()];
}

function parseMatchIdsFromHtml(html: string, season: string, gameday: number): string[] {
  return parseGamedayLinksFromHtml(html)
    .filter((link) => link.season === season && link.gameday === gameday)
    .map((link) => link.matchId);
}

function extractSeasonFromGamedayName(gamedayName?: string): string | null {
  if (!gamedayName) {
    return null;
  }

  const match = gamedayName.match(/(\d{4})\s*[/-]\s*(\d{4})/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return `${match[1]}-${match[2]}`;
}

function matchBelongsToSeason(rawMatch: TTBLRawMatch, expectedSeason: string): boolean {
  const actualSeason = extractSeasonFromGamedayName(rawMatch.gameday?.name);
  return actualSeason === expectedSeason;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "TTBL-NextJS-Scraper/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "TTBL-NextJS-Scraper/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return (await response.json()) as T;
}

async function discoverSeasonGamedayCount(
  season: string,
  delayMs: number,
  onLog?: (message: string) => void,
): Promise<number> {
  emit(
    onLog,
    `Auto-detecting TTBL gameday count for ${season} (scan up to ${AUTO_GAMEDAY_SCAN_MAX}).`,
  );

  let lastWithMatches = 0;
  let emptyStreak = 0;

  for (let gameday = 1; gameday <= AUTO_GAMEDAY_SCAN_MAX; gameday += 1) {
    const url = getScheduleUrl(season, gameday);

    try {
      const html = await fetchText(url);
      const allLinks = parseGamedayLinksFromHtml(html);
      const ids = parseMatchIdsFromHtml(html, season, gameday);

      if (ids.length > 0) {
        lastWithMatches = gameday;
        emptyStreak = 0;
      } else {
        emptyStreak += 1;
      }

      if (
        ids.length === 0 &&
        allLinks.length > 0 &&
        (gameday === 1 || gameday % 10 === 0)
      ) {
        emit(
          onLog,
          `Auto-detect ${season}: gameday ${gameday} had fallback links from other seasons (${allLinks.length}).`,
        );
      }
    } catch (error) {
      emptyStreak += 1;
      const reason = error instanceof Error ? error.message : "unknown error";
      emit(onLog, `Auto-detect ${season}: gameday ${gameday} fetch failed: ${reason}`);
    }

    if (
      gameday >= AUTO_GAMEDAY_MIN_SCAN &&
      lastWithMatches > 0 &&
      gameday > lastWithMatches &&
      emptyStreak >= AUTO_GAMEDAY_EMPTY_STREAK
    ) {
      break;
    }

    if (gameday === 1 || gameday % 5 === 0) {
      emit(
        onLog,
        `Auto-detect ${season}: scanned gameday ${gameday}/${AUTO_GAMEDAY_SCAN_MAX} (latest with matches=${lastWithMatches})`,
      );
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const resolved = lastWithMatches;
  emit(onLog, `Auto-detect ${season}: resolved max gameday=${resolved}.`);
  return resolved;
}

export async function scrapeTTBLSeason(
  options: TTBLScrapeOptions = {},
): Promise<TTBLScrapeResult> {
  const season = options.season ?? DEFAULT_SEASON;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const requestedGamedays =
    options.numGamedays && options.numGamedays > 0 ? options.numGamedays : null;
  const numGamedays =
    requestedGamedays ??
    (await discoverSeasonGamedayCount(
      season,
      Math.min(delayMs, 120),
      options.onLog,
    ));

  const outputDir = options.outputDir ?? TTBL_OUTPUT_DIR;
  const matchesDir = path.join(outputDir, "matches");
  const playersDir = path.join(outputDir, "players");
  const statsDir = path.join(outputDir, "stats");

  await Promise.all([
    ensureDir(outputDir),
    ensureDir(matchesDir),
    ensureDir(playersDir),
    ensureDir(statsDir),
  ]);

  emit(
    options.onLog,
    `Scraping season ${season} (gamedays=1..${numGamedays}) into ${outputDir}${requestedGamedays ? "" : " [auto-detected]"}`,
  );

  const discoveredMatchIds = new Set<string>();
  const failedGamedays: Array<{ gameday: number; reason: string }> = [];

  for (let gameday = 1; gameday <= numGamedays; gameday += 1) {
    const url = getScheduleUrl(season, gameday);

    try {
      const html = await fetchText(url);
      const allLinks = parseGamedayLinksFromHtml(html);
      const ids = parseMatchIdsFromHtml(html, season, gameday);
      if (ids.length === 0) {
        const reason = allLinks.length > 0 ? "no season-matching matches" : "no matches";
        failedGamedays.push({ gameday, reason });
        if (allLinks.length > 0 && (gameday === 1 || gameday === numGamedays || gameday % 10 === 0)) {
          emit(
            options.onLog,
            `Season ${season} gameday ${gameday}: ignored ${allLinks.length} fallback links from other seasons`,
          );
        }
      }

      ids.forEach((id) => discoveredMatchIds.add(id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      failedGamedays.push({ gameday, reason });
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (gameday === 1 || gameday === numGamedays || gameday % 5 === 0) {
      emit(
        options.onLog,
        `Season ${season}: scanned gameday ${gameday}/${numGamedays} (matches discovered=${discoveredMatchIds.size})`,
      );
    }
  }

  const allMatchIds = [...discoveredMatchIds].sort();

  const playerStatsMap = new Map<string, Omit<TTBLPlayerStats, "winRate">>();
  const gamesData: TTBLGameRecord[] = [];
  const allPlayers: Array<{
    id?: string;
    firstName?: string;
    lastName?: string;
    imageUrl?: string;
    matchId: string;
  }> = [];
  const matchSummaries: TTBLMatchSummary[] = [];

  let writtenRawMatches = 0;
  let processedMatchPayloads = 0;
  let rejectedOutOfSeason = 0;
  const acceptedMatchIds: string[] = [];

  for (const matchId of allMatchIds) {
    try {
      const rawMatch = await fetchJson<TTBLRawMatch>(
        `${TTBL_MATCH_ENDPOINT}/${matchId}`,
      );

      if (!matchBelongsToSeason(rawMatch, season)) {
        rejectedOutOfSeason += 1;
        if (rejectedOutOfSeason <= 5 || rejectedOutOfSeason % 25 === 0) {
          emit(
            options.onLog,
            `Season ${season}: skipped out-of-season match ${matchId} (${rawMatch.gameday?.name ?? "unknown gameday"})`,
          );
        }
        continue;
      }

      await writeJson(path.join(matchesDir, `match_${matchId}.json`), rawMatch);
      writtenRawMatches += 1;
      acceptedMatchIds.push(matchId);

      const gameday = rawMatch.gameday?.name ?? "Unknown";
      const timestamp = rawMatch.timeStamp ?? 0;
      const games = rawMatch.games ?? [];

      for (const game of games) {
        const homePlayer = game.homePlayer ?? game.homeLeaguePlayer ?? null;
        const awayPlayer = game.awayPlayer ?? game.awayLeaguePlayer ?? null;

        const homePlayerId = homePlayer?.id ?? null;
        const awayPlayerId = awayPlayer?.id ?? null;

        const homePlayerName = nameFromRawPlayer(homePlayer);
        const awayPlayerName = nameFromRawPlayer(awayPlayer);

        gamesData.push({
          matchId,
          gameday,
          timestamp,
          gameIndex: game.index ?? 0,
          gameState: game.gameState ?? "Unknown",
          winnerSide: game.winnerSide ?? null,
          homePlayer: { id: homePlayerId, name: homePlayerName },
          awayPlayer: { id: awayPlayerId, name: awayPlayerName },
        });

        if (game.gameState !== "Finished") {
          continue;
        }

        if (homePlayerId && homePlayerId !== "null") {
          const existing =
            playerStatsMap.get(homePlayerId) ?? {
              id: homePlayerId,
              name: homePlayerName,
              gamesPlayed: 0,
              wins: 0,
              losses: 0,
              lastMatch: matchId,
            };

          existing.gamesPlayed += 1;
          existing.lastMatch = matchId;
          if (game.winnerSide === "Home") {
            existing.wins += 1;
          } else {
            existing.losses += 1;
          }

          playerStatsMap.set(homePlayerId, existing);
        }

        if (awayPlayerId && awayPlayerId !== "null") {
          const existing =
            playerStatsMap.get(awayPlayerId) ?? {
              id: awayPlayerId,
              name: awayPlayerName,
              gamesPlayed: 0,
              wins: 0,
              losses: 0,
              lastMatch: matchId,
            };

          existing.gamesPlayed += 1;
          existing.lastMatch = matchId;
          if (game.winnerSide === "Away") {
            existing.wins += 1;
          } else {
            existing.losses += 1;
          }

          playerStatsMap.set(awayPlayerId, existing);
        }
      }

      const playersFromLineup = [
        rawMatch.homePlayerOne,
        rawMatch.homePlayerTwo,
        rawMatch.homePlayerThree,
        rawMatch.guestPlayerOne,
        rawMatch.guestPlayerTwo,
        rawMatch.guestPlayerThree,
      ];

      for (const player of playersFromLineup) {
        if (!player) {
          continue;
        }

        allPlayers.push({
          id: player.id,
          firstName: player.firstName,
          lastName: player.lastName,
          imageUrl: player.imageUrl,
          matchId,
        });
      }

      matchSummaries.push({
        matchId: rawMatch.id ?? matchId,
        matchState: rawMatch.matchState ?? "Unknown",
        gameday,
        timestamp,
        homeTeam: {
          id: rawMatch.homeTeam?.id ?? "",
          name: rawMatch.homeTeam?.name ?? "Unknown",
          rank: rawMatch.homeTeam?.rank ?? 0,
          gameWins: rawMatch.homeGameWins ?? 0,
          setWins: rawMatch.homeSetWins ?? 0,
        },
        awayTeam: {
          id: rawMatch.awayTeam?.id ?? "",
          name: rawMatch.awayTeam?.name ?? "Unknown",
          rank: rawMatch.awayTeam?.rank ?? 0,
          gameWins: rawMatch.awayGameWins ?? 0,
          setWins: rawMatch.awaySetWins ?? 0,
        },
        gamesCount: games.length,
        venue: rawMatch.venue?.name ?? "Unknown",
      });
    } catch {
      // Keep scraping if one match payload fails.
    } finally {
      processedMatchPayloads += 1;

      if (delayMs > 0) {
        await sleep(delayMs);
      }

      if (
        processedMatchPayloads === 1 ||
        processedMatchPayloads === allMatchIds.length ||
        processedMatchPayloads % 25 === 0
      ) {
        emit(
          options.onLog,
          `Season ${season}: processed ${processedMatchPayloads}/${allMatchIds.length} match payloads (accepted=${writtenRawMatches}, rejectedOutOfSeason=${rejectedOutOfSeason})`,
        );
      }
    }
  }

  const matchIdsPayload = acceptedMatchIds.length > 0 ? `${acceptedMatchIds.join("\n")}\n` : "";
  await writeText(path.join(outputDir, "match_ids.txt"), matchIdsPayload);

  const playerStatsFinal: TTBLPlayerStats[] = [...playerStatsMap.values()]
    .map((stats) => ({
      ...stats,
      winRate:
        stats.gamesPlayed > 0
          ? Math.floor((stats.wins / stats.gamesPlayed) * 100)
          : 0,
    }))
    .sort((a, b) => b.winRate - a.winRate || a.name.localeCompare(b.name));

  const uniquePlayers = Array.from(
    new Map(
      allPlayers
        .filter((player) => Boolean(player.id))
        .map((player) => [player.id as string, player]),
    ).values(),
  );

  const topPlayers = playerStatsFinal.filter((player) => player.gamesPlayed >= 5).slice(0, 20);

  const stateCount = new Map<string, number>();
  for (const match of matchSummaries) {
    stateCount.set(match.matchState, (stateCount.get(match.matchState) ?? 0) + 1);
  }

  const matchStates = [...stateCount.entries()].map(([state, count]) => ({
    state,
    count,
  }));

  const metadata: TTBLMetadata = {
    scrapeDate: new Date().toISOString(),
    season,
    totalMatches: writtenRawMatches,
    totalGamedays: numGamedays,
    uniquePlayers: uniquePlayers.length,
    playersWithStats: playerStatsFinal.length,
    totalGamesProcessed: gamesData.length,
    source: TTBL_BASE_URL,
    version: "nextjs-1.0",
  };

  await Promise.all([
    writeJson(path.join(outputDir, "metadata.json"), metadata),
    writeJson(path.join(outputDir, "players", "all_players.json"), allPlayers),
    writeJson(path.join(outputDir, "players", "unique_players.json"), uniquePlayers),
    writeJson(path.join(outputDir, "stats", "player_stats_final.json"), playerStatsFinal),
    writeJson(path.join(outputDir, "stats", "games_data.json"), gamesData),
    writeJson(path.join(outputDir, "stats", "top_players.json"), topPlayers),
    writeJson(path.join(outputDir, "stats", "match_states.json"), matchStates),
    writeJson(path.join(outputDir, "matches_summary.json"), matchSummaries),
  ]);

  emit(
    options.onLog,
    `Season ${season} complete: matches=${metadata.totalMatches}, uniquePlayers=${metadata.uniquePlayers}, games=${metadata.totalGamesProcessed}`,
  );
  if (rejectedOutOfSeason > 0) {
    emit(options.onLog, `Season ${season}: rejected ${rejectedOutOfSeason} out-of-season payloads.`);
  }

  return {
    metadata,
    discoveredMatchIds: allMatchIds.length,
    writtenRawMatches,
    outputDir,
    failedGamedays,
  };
}

async function writeLegacyIndex(rows: TTBLLegacyIndexRow[]): Promise<void> {
  const index: TTBLLegacyIndex = {
    generatedAt: new Date().toISOString(),
    seasons: rows.map((row) => row.season),
    results: rows,
  };

  await writeJson(TTBL_LEGACY_INDEX_FILE, index);
}

function parseSeasonStart(season: string): number {
  return Number.parseInt(season.split("-")[0] ?? "0", 10) || 0;
}

export async function discoverTTBLSeasons(
  options: TTBLDiscoverOptions = {},
): Promise<string[]> {
  const nowYear = new Date().getUTCFullYear();
  const startYear = options.startYear ?? 1995;
  const endYear = options.endYear ?? nowYear + 1;
  const delayMs = options.delayMs ?? 100;

  const found: string[] = [];

  emit(
    options.onLog,
    `Discovering seasons from ${startYear}-${startYear + 1} to ${endYear}-${endYear + 1}`,
  );

  for (let year = endYear; year >= startYear; year -= 1) {
    const season = `${year}-${year + 1}`;
    const url = getScheduleUrl(season, 1);

    try {
      const html = await fetchText(url);
      const ids = parseMatchIdsFromHtml(html, season, 1);
      if (ids.length > 0) {
        const sampleMatch = await fetchJson<TTBLRawMatch>(`${TTBL_MATCH_ENDPOINT}/${ids[0]}`);
        if (!matchBelongsToSeason(sampleMatch, season)) {
          emit(
            options.onLog,
            `Rejected season ${season}: sample match payload belongs to ${sampleMatch.gameday?.name ?? "unknown gameday"}`,
          );
        } else {
          found.push(season);
          emit(options.onLog, `Discovered season ${season} (${ids.length} matches on gameday 1)`);
        }
      }
    } catch {
      continue;
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return found.sort((a, b) => parseSeasonStart(b) - parseSeasonStart(a));
}

export async function scrapeTTBLLegacySeasons(
  options: TTBLLegacyScrapeOptions,
): Promise<TTBLLegacyScrapeResult> {
  const uniqueSeasons = [...new Set(options.seasons.map((value) => value.trim()))].filter(
    (value) => value.length > 0,
  );

  if (uniqueSeasons.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      seasons: [],
      results: [],
    };
  }

  await ensureDir(TTBL_SEASONS_DIR);
  emit(
    options.onLog,
    `Multi-season TTBL scrape starting for ${uniqueSeasons.length} seasons.`,
  );

  const results: TTBLScrapeResult[] = [];

  for (const season of uniqueSeasons) {
    const seasonDir = path.join(TTBL_SEASONS_DIR, season);
    const result = await scrapeTTBLSeason({
      season,
      numGamedays: options.numGamedays,
      delayMs: options.delayMs,
      outputDir: seasonDir,
      onLog: options.onLog,
    });
    results.push(result);
  }

  await writeLegacyIndex(
    results.map((row) => ({
      season: row.metadata.season,
      outputDir: row.outputDir,
      totalMatches: row.metadata.totalMatches,
      uniquePlayers: row.metadata.uniquePlayers,
      totalGamesProcessed: row.metadata.totalGamesProcessed,
      scrapeDate: row.metadata.scrapeDate,
    })),
  );

  return {
    generatedAt: new Date().toISOString(),
    seasons: uniqueSeasons,
    results,
  };
}

export async function scrapeTTBLAllTime(
  options: TTBLAllTimeScrapeOptions = {},
): Promise<TTBLAllTimeScrapeResult> {
  emit(options.onLog, "Starting all-time TTBL scrape.");
  const discoveredSeasons = await discoverTTBLSeasons({
    startYear: options.startYear,
    endYear: options.endYear,
    delayMs: options.delayMs,
    onLog: options.onLog,
  });
  emit(options.onLog, `TTBL season discovery complete: ${discoveredSeasons.length} seasons.`);

  const legacy = await scrapeTTBLLegacySeasons({
    seasons: discoveredSeasons,
    numGamedays: options.numGamedays,
    delayMs: options.delayMs,
    onLog: options.onLog,
  });
  const current = legacy.results[0] ?? null;

  emit(options.onLog, "All-time TTBL scrape complete.");

  return {
    generatedAt: new Date().toISOString(),
    discoveredSeasons,
    legacy,
    current,
  };
}
