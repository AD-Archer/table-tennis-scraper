import path from "node:path";
import { ensureDir, sleep, writeJson } from "@/lib/fs";
import { WTT_OUTPUT_DIR } from "@/lib/paths";
import { WTTMatch, WTTPlayer } from "@/lib/types";

const FABRIK_BASE_URL = "https://results.ittf.link/index.php";
const DEFAULT_LIST_ID = "31";

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 25000;
const REQUEST_RETRIES = 3;

export interface WTTScrapeOptions {
  years?: number[];
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  listId?: string;
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
  onLog?: (message: string) => void;
}

export interface WTTAllTimeScrapeResult {
  generatedAt: string;
  discoveredYears: number[];
  scrape: WTTScrapeResult;
}

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
): void {
  if (!ittfId) {
    return;
  }

  const existing = players.get(ittfId);
  if (!existing) {
    const names = normalizeName(name ?? "");

    players.set(ittfId, {
      ittf_id: ittfId,
      first_name: names.first_name,
      last_name: names.last_name,
      full_name: names.full_name,
      dob: null,
      nationality: association,
      team: null,
      stats: {
        matches_played: 0,
        wins: 0,
        losses: 0,
      },
      sources: ["fabrik_matches"],
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
  onLog?: (message: string) => void,
): Promise<FabrikPlayerRow[]> {
  const url = new URL(FABRIK_BASE_URL);
  url.searchParams.set("option", "com_fabrik");
  url.searchParams.set("view", "list");
  url.searchParams.set("listid", listId);
  url.searchParams.set("format", "json");
  url.searchParams.set("vw_matches___yr[value]", String(year));
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
          `Year ${year}: request retry ${attempt}/${REQUEST_RETRIES - 1} at offset ${offset} after error: ${reason}`,
        );
        await sleep(250 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch WTT page for year=${year}, offset=${offset}`);
}

async function yearHasData(
  year: number,
  listId: string,
  onLog?: (message: string) => void,
): Promise<boolean> {
  const rows = await fetchFabrikPage(year, listId, 1, 0, onLog);
  return rows.length > 0;
}

export async function discoverWTTYears(
  options: WTTDiscoverOptions = {},
): Promise<number[]> {
  const nowYear = new Date().getUTCFullYear();
  const startYear = options.startYear ?? 1926;
  const endYear = options.endYear ?? nowYear;
  const delayMs = options.delayMs ?? 75;
  const listId = options.listId ?? DEFAULT_LIST_ID;

  const years: number[] = [];
  emit(options.onLog, `Discovering WTT years from ${startYear} to ${endYear}`);

  for (let year = endYear; year >= startYear; year -= 1) {
    try {
      const hasRows = await yearHasData(year, listId, options.onLog);
      if (hasRows) {
        years.push(year);
        emit(options.onLog, `Discovered year ${year}`);
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
  const years = (options.years && options.years.length > 0
    ? [...new Set(options.years)]
    : getDefaultYears())
    .map((year) => Number.parseInt(String(year), 10))
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => b - a);

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const listId = options.listId ?? DEFAULT_LIST_ID;

  const players = new Map<string, WTTPlayer>();
  const matches: WTTMatch[] = [];
  const playerMatchIndex = new Map<string, string[]>();
  emit(
    options.onLog,
    `Scraping WTT years: ${years.join(", ") || "none"} (pageSize=${pageSize}, maxPages=${maxPages})`,
  );

  for (const year of years) {
    const seenMatchIds = new Set<string>();
    let stagnantPages = 0;
    emit(options.onLog, `Year ${year}: starting paginated scrape`);

    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const rows = await fetchFabrikPage(year, listId, pageSize, offset, options.onLog);

      if (rows.length === 0) {
        emit(options.onLog, `Year ${year}: page ${page + 1} returned no rows, stopping.`);
        break;
      }

      let newRows = 0;

      for (const row of rows) {
        const normalized = rowToMatch(row, listId);
        if (!normalized) {
          continue;
        }

        if (seenMatchIds.has(normalized.match_id)) {
          continue;
        }

        seenMatchIds.add(normalized.match_id);
        newRows += 1;
        matches.push(normalized);

        const a = normalized.players.a;
        const x = normalized.players.x;

        upsertPlayer(players, a.ittf_id, a.name, a.association);
        upsertPlayer(players, x.ittf_id, x.name, x.association);

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

      if (newRows === 0) {
        stagnantPages += 1;
      } else {
        stagnantPages = 0;
      }

      if (stagnantPages >= 2) {
        emit(
          options.onLog,
          `Year ${year}: page ${page + 1} produced no new matches twice in a row, stopping.`,
        );
        break;
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }

      emit(
        options.onLog,
        `Year ${year}: page ${page + 1} processed (rows=${rows.length}, new=${newRows}, matches so far=${seenMatchIds.size})`,
      );
    }

    emit(options.onLog, `Year ${year}: complete, matches=${seenMatchIds.size}`);
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
      sources: [
        {
          type: "fabrik_list",
          base_url: FABRIK_BASE_URL,
          list_id: listId,
        },
      ],
      notes: [
        "DOB/team generally unavailable from public Fabrik match rows; fields left null.",
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
    onLog: options.onLog,
  });
  emit(options.onLog, "All-time WTT scrape complete.");

  return {
    generatedAt: new Date().toISOString(),
    discoveredYears,
    scrape,
  };
}
