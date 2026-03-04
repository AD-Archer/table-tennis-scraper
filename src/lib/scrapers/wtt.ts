import path from "node:path";
import { getPrismaClient } from "@/lib/db/prisma";
import { persistWTTSnapshotToDb } from "@/lib/db/domain-persistence";
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
const TTU_BASE_URL = "https://wttcmsapigateway-new.azure-api.net/ttu";
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
const TTU_EVENTS_PAGE_LIMIT = 500;
const TTU_FUTURE_EVENT_GRACE_DAYS = 2;

type WTTSourceBackend = "ttu" | "fabrik";

export type WTTEventScope = "singles_only" | "all";

export interface WTTScrapeOptions {
  years?: number[];
  pageSize?: number;
  maxPages?: number;
  maxEventsPerYear?: number;
  delayMs?: number;
  listId?: string;
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
  ongoingMatches: number;
  notFinishedMatches: number;
  youthMatches: number;
  suggestedRescrapeAt: string | null;
  suggestedRescrapeDelayMs: number | null;
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
  maxEventsPerYear?: number;
  delayMs?: number;
  listId?: string;
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

interface TTUApiEnvelope<T> {
  StatusCode?: number | string;
  Result?: T;
}

interface TTUEventRow {
  EventId?: number | string;
  EventShortName?: string;
  EventLongName?: string;
  EventCoreType?: string;
  EventTypeCode?: string;
  EventCategoryGroupCode?: string;
  EventStartDate?: string;
  EventEndDate?: string;
}

interface TTUMessageRow {
  EventId?: number | string;
  SubEventCode?: string;
  MatchId?: string;
  SeqNo?: number | string;
  LatestRecord?: number | string;
  MessagePayLoad?: string;
  UTCDate?: string;
  UTCTime?: string;
  LogicalDate?: string;
  LogicalTime?: string;
}

function emit(log: ((message: string) => void) | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] [WTT] ${message}`);
}

function mapRowToWTTPlayer(row: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  dob: string | null;
  nationality: string | null;
  team: string | null;
  countryName: string | null;
  organizationName: string | null;
  gender: string | null;
  age: number | null;
  handedness: string | null;
  style: string | null;
  worldRanking: number | null;
  worldRankingPoints: number | null;
  headshotUrl: string | null;
  matchesPlayed: number;
  wins: number;
  losses: number;
  sources: string[];
  isYouth: boolean;
  lastSeenAt: Date | null;
}): WTTPlayer {
  return {
    ittf_id: row.id,
    first_name: row.firstName,
    last_name: row.lastName,
    full_name: row.fullName,
    dob: row.dob,
    nationality: row.nationality,
    team: row.team,
    country_name: row.countryName,
    organization_name: row.organizationName,
    gender:
      row.gender === "M" || row.gender === "W" || row.gender === "mixed" || row.gender === "unknown"
        ? row.gender
        : null,
    age: row.age,
    handedness: row.handedness,
    style: row.style,
    world_ranking: row.worldRanking,
    world_ranking_points: row.worldRankingPoints,
    headshot_url: row.headshotUrl,
    stats: {
      matches_played: row.matchesPlayed,
      wins: row.wins,
      losses: row.losses,
    },
    sources: row.sources,
    is_youth: row.isYouth,
    last_seen: row.lastSeenAt?.toISOString() ?? new Date().toISOString(),
  };
}

async function loadExistingPlayersMap(): Promise<Record<string, WTTPlayer>> {
  const prisma = getPrismaClient();
  if (prisma) {
    const rows = await prisma.wttPlayer.findMany();
    return Object.fromEntries(rows.map((row) => [row.id, mapRowToWTTPlayer(row)]));
  }

  return (
    (await readJson<Record<string, WTTPlayer>>(path.join(WTT_OUTPUT_DIR, "players.json"), {})) ??
    {}
  );
}

function resolveWTTBackend(): WTTSourceBackend {
  const raw = process.env.WTT_SCRAPER_BACKEND?.trim().toLowerCase();
  if (raw === "fabrik") {
    return "fabrik";
  }

  return "ttu";
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function safeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseYearFromDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) {
    return null;
  }

  const direct = text.match(/^(\d{4})[/-]/);
  if (direct?.[1]) {
    return direct[1];
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return String(parsed.getUTCFullYear());
}

function resolveMatchYear(
  expectedYear: number,
  ...candidateYears: Array<string | null>
): string {
  const expected = safeInt(expectedYear);
  if (expected === null) {
    const firstValid = candidateYears
      .map((row) => safeInt(row))
      .find((row): row is number => row !== null);
    return firstValid !== undefined ? String(firstValid) : "";
  }

  const parsedCandidates = candidateYears
    .map((row) => safeInt(row))
    .filter((row): row is number => row !== null);

  const exact = parsedCandidates.find((row) => row === expected);
  if (exact !== undefined) {
    return String(exact);
  }

  const near = parsedCandidates.find((row) => Math.abs(row - expected) <= 1);
  if (near !== undefined) {
    return String(near);
  }

  return String(expected);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function pickValue(
  row: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function pickText(
  row: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  return cleanText(pickValue(row, keys));
}

function pickInt(
  row: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  return safeInt(pickValue(row, keys));
}

function toArrayLoose<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const asRecord = value as Record<string, unknown>;
  const numericKeys = Object.keys(asRecord)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));

  if (numericKeys.length === 0) {
    return [];
  }

  return numericKeys
    .map((key) => asRecord[key])
    .filter((entry) => entry !== undefined) as T[];
}

function normalizeStatus(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

function deriveWTTProgressFlags(status: string | null): {
  ongoing: boolean;
  notFinished: boolean;
} {
  const normalized = normalizeStatus(status);
  if (!normalized) {
    return {
      ongoing: false,
      notFinished: false,
    };
  }

  if (/(OFFICIAL|FINISHED|FINAL|COMPLETE|COMPLETED|CLOSED)/.test(normalized)) {
    return {
      ongoing: false,
      notFinished: false,
    };
  }

  if (/(LIVE|RUNNING|ONGOING|INPROGRESS|IN_PROGRESS|INTERMEDIATE|ACTIVE)/.test(normalized)) {
    return {
      ongoing: true,
      notFinished: true,
    };
  }

  return {
    ongoing: false,
    notFinished: true,
  };
}

function shouldSkipPreMatchStatus(status: string | null): boolean {
  const normalized = normalizeStatus(status);
  if (!normalized) {
    return false;
  }

  return /(STARTLIST|SCHEDULED|UPCOMING|PENDING|NOTSTARTED|DRAW)/.test(normalized);
}

function parseIsoFromDateAndTime(dateText: string | null, timeText: string | null): string | null {
  const datePart = cleanText(dateText);
  if (!datePart) {
    return null;
  }

  const parsedDate = new Date(datePart);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  const rawTime = cleanText(timeText)?.replace(/\D/g, "") ?? "";
  if (rawTime.length < 6) {
    return parsedDate.toISOString();
  }

  const hh = rawTime.slice(0, 2);
  const mm = rawTime.slice(2, 4);
  const ss = rawTime.slice(4, 6);
  const candidate = new Date(`${datePart}T${hh}:${mm}:${ss}Z`);

  if (Number.isNaN(candidate.getTime())) {
    return parsedDate.toISOString();
  }

  return candidate.toISOString();
}

function inferWTTYouthFlag(
  eventName: string | null,
  tournamentName: string | null,
): boolean {
  return isWTTYouthEvent(eventName) || isWTTYouthTournamentName(tournamentName);
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
    eventScope: WTTEventScope;
    includeYouth: boolean;
  },
): "ok" | "event" | "youth" {
  const tournament = rowTournament(row);

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
  return [year, year - 1];
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

function rowToMatch(
  row: FabrikPlayerRow,
  listId: string,
  expectedYear: number,
): WTTMatch | null {
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

  const resolvedYear = resolveMatchYear(
    expectedYear,
    String(row.vw_matches___yr_raw ?? row.vw_matches___yr ?? "").trim() || null,
  );

  return {
    match_id: matchId,
    source_match_id: matchId,
    event_id: row.vw_matches___tournament_id ?? null,
    sub_event_code: row.vw_matches___event ?? null,
    year: resolvedYear,
    last_updated_at: null,
    tournament: row.vw_matches___tournament_id ?? null,
    event: row.vw_matches___event ?? null,
    stage: row.vw_matches___stage ?? null,
    round: row.vw_matches___round ?? null,
    result_status: "OFFICIAL",
    not_finished: false,
    ongoing: false,
    is_youth: inferWTTYouthFlag(
      row.vw_matches___event ?? null,
      row.vw_matches___tournament_id ?? null,
    ),
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
  isYouthMatch: boolean = false,
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
      is_youth: isYouthMatch,
      last_seen: new Date().toISOString(),
    });
    return;
  }

  if (existing.is_youth && !isYouthMatch) {
    existing.is_youth = false;
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

async function fetchTTUResult<T>(
  endpointPath: string,
  params: Record<string, string | number | undefined>,
  options: {
    allowNotFound?: boolean;
    onLog?: (message: string) => void;
    context?: string;
  } = {},
): Promise<T> {
  const url = new URL(`${TTU_BASE_URL}${endpointPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "ITTF-WTT-NextJS-Scraper/1.0",
          accept: "application/json, text/plain, */*",
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as TTUApiEnvelope<T>;
      const statusCode = safeInt(payload?.StatusCode) ?? 200;

      if (statusCode === 404 && options.allowNotFound) {
        return [] as unknown as T;
      }

      if (statusCode >= 400) {
        throw new Error(`status ${statusCode}`);
      }

      return (payload?.Result ?? ([] as unknown)) as T;
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRIES) {
        emit(
          options.onLog,
          `TTU request retry ${attempt}/${REQUEST_RETRIES - 1}${options.context ? ` (${options.context})` : ""} after error: ${
            error instanceof Error ? error.message : "unknown request failure"
          }`,
        );
        await sleep(250 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed TTU request for ${endpointPath}`);
}

async function fetchTTUEventsForYear(
  year: number,
  options: {
    delayMs?: number;
    onLog?: (message: string) => void;
  } = {},
): Promise<TTUEventRow[]> {
  const rows: TTUEventRow[] = [];
  let page = 1;

  for (;;) {
    const pageRows =
      (await fetchTTUResult<TTUEventRow[]>(
        "/Events/GetEvents",
        {
          StartDate: `${year}-01-01`,
          EndDate: `${year}-12-31`,
          Limit: TTU_EVENTS_PAGE_LIMIT,
          Page: page,
        },
        {
          onLog: options.onLog,
          context: `Events/GetEvents year=${year} page=${page}`,
        },
      )) ?? [];

    if (!Array.isArray(pageRows) || pageRows.length === 0) {
      break;
    }

    rows.push(...pageRows);
    if (pageRows.length < TTU_EVENTS_PAGE_LIMIT) {
      break;
    }

    page += 1;
    if (options.delayMs && options.delayMs > 0) {
      await sleep(Math.min(options.delayMs, 250));
    }
  }

  return rows;
}

function getTTUEventName(event: TTUEventRow): string | null {
  return cleanText(event.EventShortName) ?? cleanText(event.EventLongName);
}

function parseTTUEventDateMillis(event: TTUEventRow): number {
  const sourceDate = cleanText(event.EventStartDate) ?? cleanText(event.EventEndDate);
  if (!sourceDate) {
    return 0;
  }

  const parsed = Date.parse(sourceDate);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTTUYouthEvent(event: TTUEventRow): boolean {
  const categoryGroup = cleanText(event.EventCategoryGroupCode)?.toUpperCase();
  if (categoryGroup === "YOU") {
    return true;
  }

  const name = getTTUEventName(event);
  return isWTTYouthTournamentName(name);
}

function isTTUWTTEvent(event: TTUEventRow): boolean {
  const coreType = cleanText(event.EventCoreType)?.toUpperCase();
  if (coreType === "WTT") {
    return true;
  }

  return isWTTTournamentName(getTTUEventName(event));
}

function pickTTUPlayer(resultEntry: unknown): {
  ittfId: string | null;
  name: string | null;
  association: string | null;
} {
  const resultRecord = toRecord(resultEntry);
  const competitor = toRecord(
    toArrayLoose<Record<string, unknown>>(
      pickValue(resultRecord, ["competitor", "Competitor"]),
    )[0],
  );
  const composition = toRecord(
    toArrayLoose<Record<string, unknown>>(
      pickValue(competitor, ["composition", "Composition"]),
    )[0],
  );
  const athlete = toRecord(
    toArrayLoose<Record<string, unknown>>(
      pickValue(composition, ["athlete", "Athlete"]),
    )[0],
  );
  const description = toRecord(pickValue(athlete, ["description", "Description"]));

  const given = pickText(description, ["givenName", "GivenName"]);
  const family = pickText(description, ["familyName", "FamilyName"]);
  const fullName = cleanText([given, family].filter(Boolean).join(" "));

  return {
    ittfId:
      pickText(description, ["ifId", "IFId"]) ??
      pickText(competitor, ["code", "Code"]),
    name: fullName,
    association:
      pickText(competitor, ["organization", "Organisation", "Organization"]) ??
      pickText(description, ["organization", "Organisation", "Organization"]),
  };
}

function extractTTURound(matchDescription: unknown): string | null {
  const text = cleanText(matchDescription);
  if (!text) {
    return null;
  }

  const parts = text
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2] ?? null;
  }

  return null;
}

function resolveTTUMessageSeq(row: TTUMessageRow): number {
  return safeInt(row.SeqNo) ?? safeInt(row.LatestRecord) ?? 0;
}

function ttuMessageToMatch(
  row: TTUMessageRow,
  event: TTUEventRow,
  streamCode: WTTEventFetchCode,
  expectedYear: number,
): WTTMatch | null {
  const rawPayload = cleanText(row.MessagePayLoad);
  if (!rawPayload) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const competition = toRecord(pickValue(payload, ["competition", "Competition"]));
  const extendedInfos = toRecord(
    pickValue(competition, ["extendedInfos", "ExtendedInfos"]),
  );
  const sportDescription = toRecord(
    pickValue(extendedInfos, ["sportDescription", "SportDescription"]),
  );
  const resultRows = toArrayLoose<Record<string, unknown>>(
    pickValue(competition, ["result", "Result"]),
  );
  if (resultRows.length < 2) {
    return null;
  }

  const aResult = resultRows[0] ?? {};
  const xResult = resultRows[1] ?? {};

  const playerA = pickTTUPlayer(aResult);
  const playerX = pickTTUPlayer(xResult);

  const periodsContainer = toRecord(
    pickValue(competition, ["periods", "Periods"]),
  );
  const periods = toArrayLoose<Record<string, unknown>>(
    pickValue(periodsContainer, ["period", "Period"]),
  );
  const games: Array<{ game_number: number; a_points: number; x_points: number }> = [];
  for (const period of periods) {
    const aPoints = pickInt(period, ["homePeriodScore", "HomePeriodScore"]);
    const xPoints = pickInt(period, ["awayPeriodScore", "AwayPeriodScore"]);
    if (aPoints === null || xPoints === null) {
      continue;
    }
    games.push({
      game_number: games.length + 1,
      a_points: aPoints,
      x_points: xPoints,
    });
  }

  const parsedSetA = pickInt(aResult, ["result", "Result"]);
  const parsedSetX = pickInt(xResult, ["result", "Result"]);
  const computedSets = computeSetScore(games);
  const finalSets = {
    a: parsedSetA ?? computedSets.a,
    x: parsedSetX ?? computedSets.x,
  };

  const wltA = pickText(aResult, ["wlt", "WLT"])?.toUpperCase();
  const wltX = pickText(xResult, ["wlt", "WLT"])?.toUpperCase();
  const winnerFromWlt: "A" | "X" | null =
    wltA === "W" ? "A" : wltX === "W" ? "X" : null;
  const winnerFromSets: "A" | "X" | null =
    finalSets.a === finalSets.x ? null : finalSets.a > finalSets.x ? "A" : "X";
  const winnerInferred = winnerFromWlt ?? winnerFromSets;

  const resultStatus = normalizeStatus(
    pickText(payload, ["resultStatus", "ResultStatus"]),
  );
  if (shouldSkipPreMatchStatus(resultStatus)) {
    return null;
  }

  const progressFlags = deriveWTTProgressFlags(resultStatus);
  const irmA = pickText(aResult, ["irm", "IRM"])?.toUpperCase();
  const irmX = pickText(xResult, ["irm", "IRM"])?.toUpperCase();
  const walkover =
    (resultStatus ?? "").includes("WO") ||
    (irmA !== null && irmA !== "OK") ||
    (irmX !== null && irmX !== "OK");

  const sourceMatchId = pickText(payload, ["matchId", "MatchId"]) ?? cleanText(row.MatchId);
  if (!sourceMatchId) {
    return null;
  }

  const eventId = cleanText(event.EventId) ?? cleanText(row.EventId) ?? "unknown";
  const matchId = `${eventId}:${streamCode}:${sourceMatchId}`;

  const yearFromPayload = parseYearFromDate(
    pickValue(payload, [
      "localDate",
      "LocalDate",
      "logicalDate",
      "LogicalDate",
      "utcDate",
      "UTCDate",
    ]),
  );
  const yearFromEvent =
    parseYearFromDate(event.EventStartDate) ??
    parseYearFromDate(event.EventEndDate);
  const year = resolveMatchYear(
    expectedYear,
    yearFromPayload,
    yearFromEvent,
    parseYearFromDate(
      pickValue(payload, [
        "localDate",
        "LocalDate",
        "logicalDate",
        "LogicalDate",
        "utcDate",
        "UTCDate",
      ]),
    ),
  );
  const tournament = getTTUEventName(event);
  const eventName =
    pickText(sportDescription, ["eventName", "EventName"]) ??
    (streamCode === "MS" ? "Men Singles" : "Women Singles");
  const stage = pickText(sportDescription, ["phaseName", "PhaseName"]);
  const round = extractTTURound(
    pickValue(sportDescription, ["matchDescription", "MatchDescription"]),
  );
  const isYouth =
    isTTUYouthEvent(event) || inferWTTYouthFlag(eventName, tournament);
  const lastUpdatedAt =
    parseIsoFromDateAndTime(
      pickText(payload, ["utcDate", "UTCDate"]) ??
        cleanText(row.UTCDate) ??
        pickText(payload, ["logicalDate", "LogicalDate"]) ??
        cleanText(row.LogicalDate),
      pickText(payload, ["utcTime", "UTCTime"]) ??
        cleanText(row.UTCTime) ??
        pickText(payload, ["logicalTime", "LogicalTime"]) ??
        cleanText(row.LogicalTime),
    ) ?? parseIsoFromDateAndTime(event.EventStartDate ?? null, null);

  return {
    match_id: matchId,
    source_match_id: sourceMatchId,
    event_id: eventId,
    sub_event_code: streamCode,
    year,
    last_updated_at: lastUpdatedAt,
    tournament,
    event: eventName,
    stage,
    round,
    result_status: resultStatus,
    not_finished: progressFlags.notFinished,
    ongoing: progressFlags.ongoing,
    is_youth: isYouth,
    walkover,
    winner_raw: winnerInferred === "A" ? 1 : winnerInferred === "X" ? 2 : null,
    winner_inferred: winnerInferred,
    final_sets: finalSets,
    games,
    players: {
      a: {
        ittf_id: playerA.ittfId,
        name: playerA.name,
        association: playerA.association,
      },
      x: {
        ittf_id: playerX.ittfId,
        name: playerX.name,
        association: playerX.association,
      },
    },
    source: {
      type: "ttu_ovr_all",
      base_url: TTU_BASE_URL,
      list_id: `${eventId}:${streamCode}`,
    },
  };
}

async function discoverWTTYearsViaTTU(
  options: WTTDiscoverOptions = {},
): Promise<number[]> {
  const nowYear = new Date().getUTCFullYear();
  const startYear = options.startYear ?? WTT_FIRST_KNOWN_YEAR;
  const endYear = options.endYear ?? nowYear;
  const delayMs = options.delayMs ?? 75;

  const years: number[] = [];
  let discoveredAny = false;
  let consecutiveMissesAfterDiscovery = 0;
  emit(options.onLog, `Discovering WTT years from ${startYear} to ${endYear} via TTU API.`);

  for (let year = endYear; year >= startYear; year -= 1) {
    try {
      const events = await fetchTTUEventsForYear(year, {
        delayMs,
        onLog: options.onLog,
      });
      const hasRows = events.some((event) => isTTUWTTEvent(event));
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

async function scrapeWTTMatchesViaTTU(
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

  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const maxEventsPerYearRaw = options.maxEventsPerYear;
  const maxEventsPerYear =
    Number.isFinite(maxEventsPerYearRaw) && (maxEventsPerYearRaw as number) > 0
      ? Math.min(Math.trunc(maxEventsPerYearRaw as number), 200)
      : null;
  const futureCutoffMs = Date.now() + TTU_FUTURE_EVENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
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

  const existingPlayers = await loadExistingPlayersMap();
  const players = new Map<string, WTTPlayer>();
  const matches: WTTMatch[] = [];
  const playerMatchIndex = new Map<string, string[]>();
  const globalSeenMatchIds = new Set<string>();
  let ongoingMatches = 0;
  let notFinishedMatches = 0;
  let youthMatches = 0;

  emit(
    options.onLog,
    `Scraping WTT years: ${years.join(", ") || "none"} (backend=ttu, requestedEventScope=${requestedEventScope}, effectiveEventScope=${eventScope}, includeYouth=${includeYouth}, maxEventsPerYear=${maxEventsPerYear ?? "none"})`,
  );
  if (requestedEventScope === "all") {
    emit(
      options.onLog,
      "Requested eventScope=all, but WTT ingestion is hard-filtered to men's/women's singles only (MS/WS).",
    );
  }

  for (const year of years) {
    const seenMatchIds = new Set<string>();
    let duplicateAcrossYears = 0;
    let filteredYouth = 0;
    emit(options.onLog, `Year ${year}: loading event list from TTU API.`);

    const allEvents = await fetchTTUEventsForYear(year, {
      delayMs,
      onLog: options.onLog,
    });
    const selectedEvents: TTUEventRow[] = [];
    for (const event of allEvents) {
      if (!includeYouth && isTTUYouthEvent(event)) {
        filteredYouth += 1;
        continue;
      }
      selectedEvents.push(event);
    }
    const sortedSelected = [...selectedEvents].sort((a, b) => {
      const aDate = parseTTUEventDateMillis(a);
      const bDate = parseTTUEventDateMillis(b);
      const aFuture = aDate > futureCutoffMs ? 1 : 0;
      const bFuture = bDate > futureCutoffMs ? 1 : 0;
      if (aFuture !== bFuture) {
        return aFuture - bFuture;
      }
      return bDate - aDate;
    });
    const limitedEvents =
      maxEventsPerYear && sortedSelected.length > maxEventsPerYear
        ? sortedSelected.slice(0, maxEventsPerYear)
        : sortedSelected;
    emit(
      options.onLog,
      `Year ${year}: events selected ${limitedEvents.length}/${allEvents.length} (filteredYouth=${filteredYouth}, limitedByMaxEvents=${maxEventsPerYear ? Math.max(0, sortedSelected.length - limitedEvents.length) : 0}).`,
    );

    const eventStreams: Array<WTTEventFetchCode> = ["MS", "WS"];

    for (const event of limitedEvents) {
      const eventId = cleanText(event.EventId);
      if (!eventId) {
        continue;
      }

      const eventName = getTTUEventName(event) ?? `Event ${eventId}`;
      emit(options.onLog, `Year ${year}: loading ${eventName} (${eventId}).`);
      let eventHadData = false;

      for (const eventCode of eventStreams) {
        const messages =
          (await fetchTTUResult<TTUMessageRow[]>(
            "/OVRMessages/GetDtResultAll",
            {
              EventId: eventId,
              SubEventCode: eventCode,
            },
            {
              allowNotFound: true,
              onLog: options.onLog,
              context: `OVRMessages/GetDtResultAll event=${eventId} subevent=${eventCode}`,
            },
          )) ?? [];

        if (!Array.isArray(messages) || messages.length === 0) {
          continue;
        }
        eventHadData = true;

        const latestByMatch = new Map<string, TTUMessageRow>();
        for (const message of messages) {
          const key = cleanText(message.MatchId);
          if (!key) {
            continue;
          }

          const existing = latestByMatch.get(key);
          if (!existing) {
            latestByMatch.set(key, message);
            continue;
          }

          const existingSeq = resolveTTUMessageSeq(existing);
          const currentSeq = resolveTTUMessageSeq(message);
          if (currentSeq >= existingSeq) {
            latestByMatch.set(key, message);
          }
        }

        let streamNewRows = 0;
        let streamOngoing = 0;
        let streamNotFinished = 0;
        let streamYouth = 0;
        for (const message of latestByMatch.values()) {
          const normalized = ttuMessageToMatch(message, event, eventCode, year);
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
          streamNewRows += 1;
          matches.push(normalized);
          if (normalized.ongoing) {
            ongoingMatches += 1;
            streamOngoing += 1;
          }
          if (normalized.not_finished) {
            notFinishedMatches += 1;
            streamNotFinished += 1;
          }
          if (normalized.is_youth) {
            youthMatches += 1;
            streamYouth += 1;
          }

          const a = normalized.players.a;
          const x = normalized.players.x;

          upsertPlayer(
            players,
            a.ittf_id,
            a.name,
            a.association,
            a.ittf_id ? existingPlayers[a.ittf_id] ?? null : null,
            normalized.is_youth ?? false,
          );
          upsertPlayer(
            players,
            x.ittf_id,
            x.name,
            x.association,
            x.ittf_id ? existingPlayers[x.ittf_id] ?? null : null,
            normalized.is_youth ?? false,
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

        emit(
          options.onLog,
          `Year ${year}: event ${eventId} ${eventCode} processed (statusMessages=${messages.length}, dedupedMessageMatches=${latestByMatch.size}, acceptedMatches=${streamNewRows}, eventOngoing=${streamOngoing}, eventNotFinished=${streamNotFinished}, eventYouth=${streamYouth}, yearTotalMatches=${seenMatchIds.size}).`,
        );

        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }

      if (!eventHadData) {
        emit(
          options.onLog,
          `Year ${year}: event ${eventId} had no MS/WS message rows and was skipped.`,
        );
      }
    }

    emit(
      options.onLog,
      `Year ${year}: complete, matches=${seenMatchIds.size}, duplicateAcrossYears=${duplicateAcrossYears}.`,
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
      ongoingMatches,
      notFinishedMatches,
      youthMatches,
      suggestedRescrapeDelayMs: ongoingMatches > 0 ? 120000 : null,
      suggestedRescrapeAt:
        ongoingMatches > 0
          ? new Date(Date.now() + 120000).toISOString()
          : null,
      filters: {
        eventScope,
        requestedEventScope,
        includeYouth,
      },
      sources: [
        {
          type: "ttu_ovr_all",
          base_url: TTU_BASE_URL,
          list_id: "events+subevents",
        },
      ],
      notes: [
        "Matches are sourced from TTU OVR all-result feed to capture live/in-progress states.",
        "Rows are hard-filtered to men's/women's singles events only (MS/WS).",
        "Player profile fields may be enriched from WTT public CMS player endpoint.",
        "Winner inferred from W/L flags and per-game points where possible.",
      ],
    },
    players: serializedPlayers,
    matches,
    player_match_index: serializedIndex,
  };

  await persistWTTSnapshotToDb({
    years,
    players: [...players.values()],
    matches,
    onLog: options.onLog,
  });

  await ensureDir(WTT_OUTPUT_DIR);
  await Promise.all([
    writeJson(path.join(WTT_OUTPUT_DIR, "players.json"), serializedPlayers),
    writeJson(path.join(WTT_OUTPUT_DIR, "matches.json"), matches),
    writeJson(path.join(WTT_OUTPUT_DIR, "player_match_index.json"), serializedIndex),
    writeJson(path.join(WTT_OUTPUT_DIR, "dataset.json"), dataset),
  ]);

  emit(
    options.onLog,
    `WTT scrape complete. Years=${years.length}, matches=${matches.length}, players=${players.size}, ongoing=${ongoingMatches}, notFinished=${notFinishedMatches}, youth=${youthMatches}`,
  );

  return {
    years,
    matches: matches.length,
    players: players.size,
    ongoingMatches,
    notFinishedMatches,
    youthMatches,
    suggestedRescrapeAt:
      ongoingMatches > 0
        ? new Date(Date.now() + 120000).toISOString()
        : null,
    suggestedRescrapeDelayMs: ongoingMatches > 0 ? 120000 : null,
    outputDir: WTT_OUTPUT_DIR,
  };
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
  if (resolveWTTBackend() === "ttu") {
    return await discoverWTTYearsViaTTU(options);
  }

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
  if (resolveWTTBackend() === "ttu") {
    return await scrapeWTTMatchesViaTTU(options);
  }

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

  const existingPlayers = await loadExistingPlayersMap();
  const players = new Map<string, WTTPlayer>();
  const matches: WTTMatch[] = [];
  const playerMatchIndex = new Map<string, string[]>();
  const globalSeenMatchIds = new Set<string>();
  let ongoingMatches = 0;
  let notFinishedMatches = 0;
  let youthMatches = 0;
  emit(
    options.onLog,
    `Scraping WTT years: ${years.join(", ") || "none"} (pageSize=${pageSize}, maxPages=${maxPages}, requestedEventScope=${requestedEventScope}, effectiveEventScope=${eventScope}, includeYouth=${includeYouth})`,
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
            eventScope,
            includeYouth,
          });
          if (keepReason === "event") {
            filteredEvent += 1;
            continue;
          }
          if (keepReason === "youth") {
            filteredYouth += 1;
            continue;
          }

          const normalized = rowToMatch(row, listId, year);
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
          if (normalized.ongoing) {
            ongoingMatches += 1;
          }
          if (normalized.not_finished) {
            notFinishedMatches += 1;
          }
          if (normalized.is_youth) {
            youthMatches += 1;
          }

          const a = normalized.players.a;
          const x = normalized.players.x;

          upsertPlayer(
            players,
            a.ittf_id,
            a.name,
            a.association,
            a.ittf_id ? existingPlayers[a.ittf_id] ?? null : null,
            normalized.is_youth ?? false,
          );
          upsertPlayer(
            players,
            x.ittf_id,
            x.name,
            x.association,
            x.ittf_id ? existingPlayers[x.ittf_id] ?? null : null,
            normalized.is_youth ?? false,
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
          `Year ${year}: stream ${streamLabel} page ${page + 1} processed (rows=${rows.length}, new=${newRows}, offset=${offset}, filteredOutOfYear=${filteredOutOfYear}, filteredEvent=${filteredEvent}, filteredYouth=${filteredYouth}, duplicateAcrossYears=${duplicateAcrossYears}, matches so far=${seenMatchIds.size})`,
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
      `Year ${year}: complete, matches=${seenMatchIds.size}, filteredOutOfYear=${filteredOutOfYear}, filteredEvent=${filteredEvent}, filteredYouth=${filteredYouth}, duplicateAcrossYears=${duplicateAcrossYears}`,
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
      ongoingMatches,
      notFinishedMatches,
      youthMatches,
      suggestedRescrapeDelayMs: ongoingMatches > 0 ? 120000 : null,
      suggestedRescrapeAt:
        ongoingMatches > 0
          ? new Date(Date.now() + 120000).toISOString()
          : null,
      filters: {
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

  await persistWTTSnapshotToDb({
    years,
    players: [...players.values()],
    matches,
    onLog: options.onLog,
  });

  await ensureDir(WTT_OUTPUT_DIR);
  await Promise.all([
    writeJson(path.join(WTT_OUTPUT_DIR, "players.json"), serializedPlayers),
    writeJson(path.join(WTT_OUTPUT_DIR, "matches.json"), matches),
    writeJson(path.join(WTT_OUTPUT_DIR, "player_match_index.json"), serializedIndex),
    writeJson(path.join(WTT_OUTPUT_DIR, "dataset.json"), dataset),
  ]);

  emit(
    options.onLog,
    `WTT scrape complete. Years=${years.length}, matches=${matches.length}, players=${players.size}, ongoing=${ongoingMatches}, notFinished=${notFinishedMatches}, youth=${youthMatches}`,
  );

  return {
    years,
    matches: matches.length,
    players: players.size,
    ongoingMatches,
    notFinishedMatches,
    youthMatches,
    suggestedRescrapeAt:
      ongoingMatches > 0
        ? new Date(Date.now() + 120000).toISOString()
        : null,
    suggestedRescrapeDelayMs: ongoingMatches > 0 ? 120000 : null,
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
    maxEventsPerYear: options.maxEventsPerYear,
    delayMs: options.delayMs,
    listId: options.listId,
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
