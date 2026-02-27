import path from "node:path";
import { ensureDir, readJson, sleep, writeJson } from "@/lib/fs";
import { WTT_OUTPUT_DIR } from "@/lib/paths";
import { WTTMatch, WTTPlayer } from "@/lib/types";
import {
  isWTTGenderedSinglesEvent,
  isWTTTournamentName,
  isWTTYouthEvent,
  isWTTYouthTournamentName,
} from "@/lib/wtt/events";
import { fetchWTTPublicProfile, mergeWTTPublicProfile } from "@/lib/wtt/public-profile";

const FABRIK_BASE_URL = "https://results.ittf.link/index.php";
const DEFAULT_LIST_ID = "31";
export const WTT_FIRST_KNOWN_YEAR = 2017;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 120;
const DEFAULT_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 25000;
const REQUEST_RETRIES = 3;
const DISCOVERY_MISS_STREAK_TO_STOP = 4;
const DEFAULT_PROFILE_ENRICH_MAX_PLAYERS = 600;
const DEFAULT_PROFILE_ENRICH_MIN_MATCHES = 2;
const PROFILE_ENRICH_CONCURRENCY = 8;

export type WTTTournamentScope = "wtt_only" | "all";
export type WTTEventScope = "singles_only" | "all";

export interface WTTScrapeOptions {
  years?: number[];
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  listId?: string;
  tournamentScope?: WTTTournamentScope;
  eventScope?: WTTEventScope;
  includeYouth?: boolean;
  profileEnrichMaxPlayers?: number;
  profileEnrichMinMatches?: number;
  onLog?: (message: string) => void;
}

export interface WTTScrapeResult {
  years: number[];
  matches: number;
  players: number;
  outputDir: string;
}

export interface WTTDiscoverOptions {
  startYear?: number;
  endYear?: number;
  delayMs?: number;
  listId?: string;
  onLog?: (message: string) => void;
}

export interface WTTAllTimeScrapeOptions {
  startYear?: number;
  endYear?: number;
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  listId?: string;
  tournamentScope?: WTTTournamentScope;
  eventScope?: WTTEventScope;
  includeYouth?: boolean;
  profileEnrichMaxPlayers?: number;
  profileEnrichMinMatches?: number;
  onLog?: (message: string) => void;
}

export interface WTTAllTimeScrapeResult {
  generatedAt: string;
  discoveredYears: number[];
  scrape: WTTScrapeResult;
}

type WTTEventFetchCode = "MS" | "WS";

interface FabrikPlayerRow {
  vw_matches___id?: number | string;
  vw_matches___player_a_id?: number | string;
  vw_matches___player_x_id?: number | string;
  vw_matches___name_a?: string;
  vw_matches___name_x?: string;
  vw_matches___assoc_a?: string;
  vw_matches___assoc_x?: string;
  vw_matches___games_raw?: string;
  vw_matches___wo?: number | string | boolean;
  vw_matches___winner?: number | string;
  vw_matches___yr_raw?: number | string;
  vw_matches___yr?: number | string;
  vw_matches___tournament_id?: string;
  vw_matches___event?: string;
  vw_matches___stage?: string;
  vw_matches___round?: string;
}

function emit(log: ((message: string) => void) | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] [WTT] ${message}`);
}

function safeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractRowYear(row: FabrikPlayerRow): number | null {
  return safeInt(row.vw_matches___yr_raw ?? row.vw_matches___yr);
}

function rowMatchesRequestedYear(row: FabrikPlayerRow, year: number): boolean {
  return extractRowYear(row) === year;
}

function rowTournament(row: FabrikPlayerRow): string | null {
  const value = row.vw_matches___tournament_id;
  return typeof value === "string" ? value.trim() || null : null;
}

function rowEvent(row: FabrikPlayerRow): string | null {
  const value = row.vw_matches___event;
  return typeof value === "string" ? value.trim() || null : null;
}

function shouldKeepRowByScope(
  row: FabrikPlayerRow,
  options: {
    tournamentScope: WTTTournamentScope;
    eventScope: WTTEventScope;
    includeYouth: boolean;
  },
): "ok" | "tournament" | "event" | "youth" {
  const tournament = rowTournament(row);
  if (options.tournamentScope === "wtt_only" && !isWTTTournamentName(tournament)) {
    return "tournament";
  }

  const event = rowEvent(row);
  if (
    !options.includeYouth &&
    (isWTTYouthEvent(event) || isWTTYouthTournamentName(tournament))
  ) {
    return "youth";
  }

  if (!isWTTGenderedSinglesEvent(event)) {
    return "event";
  }

  return "ok";
}

function normalizeName(fullName: string): {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
} {
  const normalized = fullName.trim();
  if (!normalized) {
    return { first_name: null, last_name: null, full_name: null };
  }

  const parts = normalized.split(/\s+/);
  if (parts.length === 1) {
    return {
      first_name: null,
      last_name: parts[0] ?? null,
      full_name: normalized,
    };
  }

  const caps = parts.filter((part) => part === part.toUpperCase());
  if (caps.length > 0) {
    const last = caps[0];
    const first = parts.filter((part) => part !== last).join(" ");
    return {
      first_name: first || null,
      last_name: last || null,
      full_name: normalized,
    };
  }

  return {
    first_name: parts.slice(0, -1).join(" ") || null,
    last_name: parts.at(-1) ?? null,
    full_name: normalized,
  };
}

function parseGames(gamesRaw: string): Array<{ game_number: number; a_points: number; x_points: number }> {
  const trimmed = gamesRaw.trim();
  if (!trimmed) {
    return [];
  }

  const out: Array<{ game_number: number; a_points: number; x_points: number }> = [];

  trimmed.split(/\s+/).forEach((token, index) => {
    const [aRaw, xRaw] = token.split(":");
    if (!aRaw || !xRaw) {
      return;
    }

    const a = safeInt(aRaw);
    const x = safeInt(xRaw);
    if (a === null || x === null) {
      return;
    }

    out.push({ game_number: index + 1, a_points: a, x_points: x });
  });

  return out;
}

function computeSetScore(
  games: Array<{ game_number: number; a_points: number; x_points: number }>,
): { a: number; x: number } {
  let aSets = 0;
  let xSets = 0;

  for (const game of games) {
    if (game.a_points > game.x_points) {
      aSets += 1;
    } else if (game.x_points > game.a_points) {
      xSets += 1;
    }
  }

  return { a: aSets, x: xSets };
}

function getDefaultYears(): number[] {
  const year = new Date().getUTCFullYear();
  return [year];
}

function toRows(payload: unknown): FabrikPlayerRow[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  if (payload.length === 1 && Array.isArray(payload[0])) {
    return payload[0] as FabrikPlayerRow[];
  }

  return payload as FabrikPlayerRow[];
}

function rowToMatch(row: FabrikPlayerRow, listId: string): WTTMatch | null {
  const matchId = String(row.vw_matches___id ?? "").trim();
  if (!matchId) {
    return null;
  }

  const games = parseGames(row.vw_matches___games_raw ?? "");
  const finalSets = computeSetScore(games);

  let winnerInferred: "A" | "X" | null = null;
  if (finalSets.a !== finalSets.x) {
    winnerInferred = finalSets.a > finalSets.x ? "A" : "X";
  }

  return {
    match_id: matchId,
    year: String(row.vw_matches___yr_raw ?? row.vw_matches___yr ?? "").trim() || null,
    tournament: row.vw_matches___tournament_id ?? null,
    event: row.vw_matches___event ?? null,
    stage: row.vw_matches___stage ?? null,
    round: row.vw_matches___round ?? null,
    walkover: Boolean(row.vw_matches___wo),
    winner_raw: safeInt(row.vw_matches___winner),
    winner_inferred: winnerInferred,
    final_sets: finalSets,
    games,
    players: {
      a: {
        ittf_id: String(row.vw_matches___player_a_id ?? "").trim() || null,
        name: (row.vw_matches___name_a ?? "").trim() || null,
        association: (row.vw_matches___assoc_a ?? "").trim() || null,
      },
      x: {
        ittf_id: String(row.vw_matches___player_x_id ?? "").trim() || null,
        name: (row.vw_matches___name_x ?? "").trim() || null,
        association: (row.vw_matches___assoc_x ?? "").trim() || null,
      },
    },
    source: {
      type: "fabrik_list",
      base_url: FABRIK_BASE_URL,
      list_id: listId,
    },
  };
}

function upsertPlayer(
  players: Map<string, WTTPlayer>,
  ittfId: string | null,
  name: string | null,
  association: string | null,
  seed: WTTPlayer | null = null,
): void {
  if (!ittfId) {
    return;
  }

  const existing = players.get(ittfId);
  if (!existing) {
    const names = normalizeName(name ?? "");

    players.set(ittfId, {
      ittf_id: ittfId,
      first_name: names.first_name ?? seed?.first_name ?? null,
      last_name: names.last_name ?? seed?.last_name ?? null,
      full_name: names.full_name ?? seed?.full_name ?? null,
      dob: seed?.dob ?? null,
      nationality: association ?? seed?.nationality ?? null,
      team: seed?.team ?? null,
      country_name: seed?.country_name ?? null,
      organization_name: seed?.organization_name ?? null,
      gender: seed?.gender ?? null,
      age: seed?.age ?? null,
      handedness: seed?.handedness ?? null,
      style: seed?.style ?? null,
      world_ranking: seed?.world_ranking ?? null,
      world_ranking_points: seed?.world_ranking_points ?? null,
      headshot_url: seed?.headshot_url ?? null,
      stats: {
        matches_played: 0,
        wins: 0,
        losses: 0,
      },
      sources: [...new Set([...(seed?.sources ?? []), "fabrik_matches"])],
      last_seen: new Date().toISOString(),
    });
    return;
  }

  if (!existing.full_name && name) {
    const names = normalizeName(name);
    existing.first_name = names.first_name;
    existing.last_name = names.last_name;
    existing.full_name = names.full_name;
  }

  if (!existing.nationality && association) {
    existing.nationality = association;
  }

  if (!existing.sources.includes("fabrik_matches")) {
    existing.sources.push("fabrik_matches");
  }

  existing.last_seen = new Date().toISOString();
}

async function fetchFabrikPage(
  year: number,
  listId: string,
  limit: number,
  offset: number,
  eventCode: WTTEventFetchCode | null,
  onLog?: (message: string) => void,
): Promise<FabrikPlayerRow[]> {
  const url = new URL(FABRIK_BASE_URL);
  url.searchParams.set("option", "com_fabrik");
  url.searchParams.set("view", "list");
  url.searchParams.set("listid", listId);
  url.searchParams.set("format", "json");
  url.searchParams.set("vw_matches___yr[value]", String(year));
  if (eventCode) {
    // Source-level filter so we only page through men's/women's singles streams.
    url.searchParams.set("vw_matches___event[value]", eventCode);
  }
  url.searchParams.set("limit", String(limit));
  url.searchParams.set(`limitstart${listId}`, String(offset));

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "ITTF-WTT-NextJS-Scraper/1.0",
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      return toRows(payload);
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        const reason =
          error instanceof Error ? error.message : "unknown request failure";
        emit(
          onLog,
          `Year ${year}${eventCode ? ` ${eventCode}` : ""}: request retry ${attempt}/${REQUEST_RETRIES - 1} at offset ${offset} after error: ${reason}`,
        );
        await sleep(250 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        `Failed to fetch WTT page for year=${year}, offset=${offset}${eventCode ? `, event=${eventCode}` : ""}`,
      );
}

async function yearHasData(
  year: number,
  listId: string,
  onLog?: (message: string) => void,
): Promise<boolean> {
  const rows = await fetchFabrikPage(year, listId, 200, 0, null, onLog);
  const matchingRows = rows.filter((row) => rowMatchesRequestedYear(row, year));
  if (rows.length > 0 && matchingRows.length === 0) {
    emit(
      onLog,
      `Year ${year}: received rows but none matched requested year (skipping).`,
    );
  }
  return matchingRows.length > 0;
}

function needsProfileEnrichment(player: WTTPlayer): boolean {
  if (player.sources.includes("wtt_player_profile")) {
    return false;
  }

  return (
    !player.dob ||
    !player.gender ||
    player.age === null ||
    !player.handedness ||
    player.world_ranking === null ||
    !player.country_name ||
    !player.organization_name
  );
}

async function enrichPlayersWithPublicProfiles(
  players: Map<string, WTTPlayer>,
  options: {
    maxPlayers: number;
    minMatches: number;
    onLog?: (message: string) => void;
  },
): Promise<number> {
  const candidates = [...players.values()]
    .filter((player) => player.stats.matches_played >= options.minMatches)
    .filter((player) => needsProfileEnrichment(player))
    .sort(
      (a, b) =>
        b.stats.matches_played - a.stats.matches_played ||
        a.ittf_id.localeCompare(b.ittf_id),
    )
    .slice(0, options.maxPlayers);

  if (candidates.length === 0) {
    return 0;
  }

  emit(
    options.onLog,
    `Enriching WTT player profiles from public CMS API (candidates=${candidates.length}, minMatches=${options.minMatches}).`,
  );

  let nextIndex = 0;
  let updated = 0;

  const workerCount = Math.min(PROFILE_ENRICH_CONCURRENCY, candidates.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= candidates.length) {
        return;
      }

      const player = candidates[index];
      if (!player) {
        continue;
      }

      const profile = await fetchWTTPublicProfile(player.ittf_id);
      if (profile && mergeWTTPublicProfile(player, profile)) {
        updated += 1;
      }

      if ((index + 1) % 100 === 0 || index + 1 === candidates.length) {
        emit(
          options.onLog,
          `Profile enrichment progress: ${index + 1}/${candidates.length} processed (updated=${updated}).`,
        );
      }

      await sleep(40);
    }
  });

  await Promise.all(workers);
  emit(options.onLog, `Profile enrichment complete. Players updated=${updated}.`);
  return updated;
}

export async function discoverWTTYears(
  options: WTTDiscoverOptions = {},
): Promise<number[]> {
  const nowYear = new Date().getUTCFullYear();
  const startYear = options.startYear ?? WTT_FIRST_KNOWN_YEAR;
  const endYear = options.endYear ?? nowYear;
  const delayMs = options.delayMs ?? 75;
  const listId = options.listId ?? DEFAULT_LIST_ID;

  const years: number[] = [];
  let discoveredAny = false;
  let consecutiveMissesAfterDiscovery = 0;
  emit(options.onLog, `Discovering WTT years from ${startYear} to ${endYear}`);

  for (let year = endYear; year >= startYear; year -= 1) {
    try {
      const hasRows = await yearHasData(year, listId, options.onLog);
      if (hasRows) {
        years.push(year);
        discoveredAny = true;
        consecutiveMissesAfterDiscovery = 0;
        emit(options.onLog, `Discovered year ${year}`);
      } else if (discoveredAny) {
        consecutiveMissesAfterDiscovery += 1;
        if (consecutiveMissesAfterDiscovery >= DISCOVERY_MISS_STREAK_TO_STOP) {
          emit(
            options.onLog,
            `Stopping WTT year discovery after ${consecutiveMissesAfterDiscovery} consecutive misses.`,
          );
          break;
        }
      }
    } catch {
      continue;
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return years.sort((a, b) => b - a);
}

export async function scrapeWTTMatches(
  options: WTTScrapeOptions = {},
): Promise<WTTScrapeResult> {
  const nowYear = new Date().getUTCFullYear();
  const years = (options.years && options.years.length > 0
    ? [...new Set(options.years)]
    : getDefaultYears())
    .map((year) => Number.parseInt(String(year), 10))
    .filter(
      (year) =>
        Number.isFinite(year) && year >= WTT_FIRST_KNOWN_YEAR && year <= nowYear + 1,
    )
    .sort((a, b) => b - a);

  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const listId = options.listId ?? DEFAULT_LIST_ID;
  const tournamentScope = options.tournamentScope ?? "wtt_only";
  const requestedEventScope = options.eventScope ?? "singles_only";
  const eventScope: WTTEventScope = "singles_only";
  const includeYouth = options.includeYouth ?? false;
  const profileEnrichMaxPlayers = Math.max(
    0,
    options.profileEnrichMaxPlayers ?? DEFAULT_PROFILE_ENRICH_MAX_PLAYERS,
  );
  const profileEnrichMinMatches = Math.max(
    1,
    options.profileEnrichMinMatches ?? DEFAULT_PROFILE_ENRICH_MIN_MATCHES,
  );

  const existingPlayers =
    (await readJson<Record<string, WTTPlayer>>(path.join(WTT_OUTPUT_DIR, "players.json"), {})) ??
    {};
  const players = new Map<string, WTTPlayer>();
  const matches: WTTMatch[] = [];
  const playerMatchIndex = new Map<string, string[]>();
  const globalSeenMatchIds = new Set<string>();
  emit(
    options.onLog,
    `Scraping WTT years: ${years.join(", ") || "none"} (pageSize=${pageSize}, maxPages=${maxPages}, tournamentScope=${tournamentScope}, requestedEventScope=${requestedEventScope}, effectiveEventScope=${eventScope}, includeYouth=${includeYouth})`,
  );
  if (requestedEventScope === "all") {
    emit(
      options.onLog,
      "Requested eventScope=all, but WTT ingestion is hard-filtered to men's/women's singles only (MS/WS).",
    );
  }

  for (const year of years) {
    const seenMatchIds = new Set<string>();
    let filteredOutOfYear = 0;
    let filteredTournament = 0;
    let filteredEvent = 0;
    let filteredYouth = 0;
    let duplicateAcrossYears = 0;
    emit(options.onLog, `Year ${year}: starting paginated scrape`);
    const eventStreams: Array<WTTEventFetchCode | null> =
      eventScope === "singles_only" ? ["MS", "WS"] : [null];

    for (const eventCode of eventStreams) {
      let stagnantPages = 0;
      let offset = 0;
      const streamLabel = eventCode ?? "ALL";

      emit(
        options.onLog,
        `Year ${year}: starting stream ${streamLabel} (pageSize=${pageSize}, maxPages=${maxPages}).`,
      );

      for (let page = 0; page < maxPages; page += 1) {
        const rows = await fetchFabrikPage(
          year,
          listId,
          pageSize,
          offset,
          eventCode,
          options.onLog,
        );

        if (rows.length === 0) {
          emit(
            options.onLog,
            `Year ${year}: stream ${streamLabel} page ${page + 1} returned no rows, stopping stream.`,
          );
          break;
        }

        let newRows = 0;

        for (const row of rows) {
          if (!rowMatchesRequestedYear(row, year)) {
            filteredOutOfYear += 1;
            continue;
          }

          const keepReason = shouldKeepRowByScope(row, {
            tournamentScope,
            eventScope,
            includeYouth,
          });
          if (keepReason === "tournament") {
            filteredTournament += 1;
            continue;
          }
          if (keepReason === "event") {
            filteredEvent += 1;
            continue;
          }
          if (keepReason === "youth") {
            filteredYouth += 1;
            continue;
          }

          const normalized = rowToMatch(row, listId);
          if (!normalized) {
            continue;
          }

          if (globalSeenMatchIds.has(normalized.match_id)) {
            duplicateAcrossYears += 1;
            continue;
          }

          if (seenMatchIds.has(normalized.match_id)) {
            continue;
          }

          seenMatchIds.add(normalized.match_id);
          globalSeenMatchIds.add(normalized.match_id);
          newRows += 1;
          matches.push(normalized);

          const a = normalized.players.a;
          const x = normalized.players.x;

          upsertPlayer(
            players,
            a.ittf_id,
            a.name,
            a.association,
            a.ittf_id ? existingPlayers[a.ittf_id] ?? null : null,
          );
          upsertPlayer(
            players,
            x.ittf_id,
            x.name,
            x.association,
            x.ittf_id ? existingPlayers[x.ittf_id] ?? null : null,
          );

          if (normalized.match_id && a.ittf_id) {
            const aIndex = playerMatchIndex.get(a.ittf_id) ?? [];
            aIndex.push(normalized.match_id);
            playerMatchIndex.set(a.ittf_id, aIndex);

            const aPlayer = players.get(a.ittf_id);
            if (aPlayer) {
              aPlayer.stats.matches_played += 1;
            }
          }

          if (normalized.match_id && x.ittf_id) {
            const xIndex = playerMatchIndex.get(x.ittf_id) ?? [];
            xIndex.push(normalized.match_id);
            playerMatchIndex.set(x.ittf_id, xIndex);

            const xPlayer = players.get(x.ittf_id);
            if (xPlayer) {
              xPlayer.stats.matches_played += 1;
            }
          }

          if (normalized.winner_inferred === "A" && a.ittf_id && x.ittf_id) {
            const aPlayer = players.get(a.ittf_id);
            const xPlayer = players.get(x.ittf_id);
            if (aPlayer && xPlayer) {
              aPlayer.stats.wins += 1;
              xPlayer.stats.losses += 1;
            }
          }

          if (normalized.winner_inferred === "X" && a.ittf_id && x.ittf_id) {
            const aPlayer = players.get(a.ittf_id);
            const xPlayer = players.get(x.ittf_id);
            if (aPlayer && xPlayer) {
              xPlayer.stats.wins += 1;
              aPlayer.stats.losses += 1;
            }
          }
        }

        offset += rows.length;

        if (newRows === 0) {
          stagnantPages += 1;
        } else {
          stagnantPages = 0;
        }

        if (stagnantPages >= 2) {
          emit(
            options.onLog,
            `Year ${year}: stream ${streamLabel} page ${page + 1} produced no new matches twice in a row, stopping stream.`,
          );
          break;
        }

        if (delayMs > 0) {
          await sleep(delayMs);
        }

        emit(
          options.onLog,
          `Year ${year}: stream ${streamLabel} page ${page + 1} processed (rows=${rows.length}, new=${newRows}, offset=${offset}, filteredOutOfYear=${filteredOutOfYear}, filteredTournament=${filteredTournament}, filteredEvent=${filteredEvent}, filteredYouth=${filteredYouth}, duplicateAcrossYears=${duplicateAcrossYears}, matches so far=${seenMatchIds.size})`,
        );

        if (rows.length < pageSize) {
          emit(
            options.onLog,
            `Year ${year}: stream ${streamLabel} page ${page + 1} returned short page (${rows.length}<${pageSize}), stopping stream.`,
          );
          break;
        }
      }
    }

    emit(
      options.onLog,
      `Year ${year}: complete, matches=${seenMatchIds.size}, filteredOutOfYear=${filteredOutOfYear}, filteredTournament=${filteredTournament}, filteredEvent=${filteredEvent}, filteredYouth=${filteredYouth}, duplicateAcrossYears=${duplicateAcrossYears}`,
    );
  }

  if (profileEnrichMaxPlayers > 0 && players.size > 0) {
    await enrichPlayersWithPublicProfiles(players, {
      maxPlayers: profileEnrichMaxPlayers,
      minMatches: profileEnrichMinMatches,
      onLog: options.onLog,
    });
  }

  const serializedPlayers = Object.fromEntries(
    [...players.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const serializedIndex = Object.fromEntries(
    [...playerMatchIndex.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );

  const dataset = {
    metadata: {
      scraped_at: new Date().toISOString(),
      years,
      players: players.size,
      matches: matches.length,
      filters: {
        tournamentScope,
        eventScope,
        requestedEventScope,
        includeYouth,
      },
      sources: [
        {
          type: "fabrik_list",
          base_url: FABRIK_BASE_URL,
          list_id: listId,
        },
      ],
      notes: [
        "Rows are hard-filtered to men's/women's singles events only (MS/WS).",
        "Player profile fields may be enriched from WTT public CMS player endpoint.",
        "Winner inferred from per-game points where possible.",
      ],
    },
    players: serializedPlayers,
    matches,
    player_match_index: serializedIndex,
  };

  await ensureDir(WTT_OUTPUT_DIR);
  await Promise.all([
    writeJson(path.join(WTT_OUTPUT_DIR, "players.json"), serializedPlayers),
    writeJson(path.join(WTT_OUTPUT_DIR, "matches.json"), matches),
    writeJson(path.join(WTT_OUTPUT_DIR, "player_match_index.json"), serializedIndex),
    writeJson(path.join(WTT_OUTPUT_DIR, "dataset.json"), dataset),
  ]);

  emit(
    options.onLog,
    `WTT scrape complete. Years=${years.length}, matches=${matches.length}, players=${players.size}`,
  );

  return {
    years,
    matches: matches.length,
    players: players.size,
    outputDir: WTT_OUTPUT_DIR,
  };
}

export async function scrapeWTTAllTime(
  options: WTTAllTimeScrapeOptions = {},
): Promise<WTTAllTimeScrapeResult> {
  emit(options.onLog, "Starting all-time WTT scrape.");
  const discoveredYears = await discoverWTTYears({
    startYear: options.startYear,
    endYear: options.endYear,
    delayMs: options.delayMs,
    listId: options.listId,
    onLog: options.onLog,
  });
  emit(options.onLog, `WTT year discovery complete: ${discoveredYears.length} years.`);

  const scrape = await scrapeWTTMatches({
    years: discoveredYears,
    pageSize: options.pageSize,
    maxPages: options.maxPages,
    delayMs: options.delayMs,
    listId: options.listId,
    tournamentScope: options.tournamentScope,
    eventScope: options.eventScope,
    includeYouth: options.includeYouth,
    profileEnrichMaxPlayers: options.profileEnrichMaxPlayers,
    profileEnrichMinMatches: options.profileEnrichMinMatches,
    onLog: options.onLog,
  });
  emit(options.onLog, "All-time WTT scrape complete.");

  return {
    generatedAt: new Date().toISOString(),
    discoveredYears,
    scrape,
  };
}
