import { getPrismaClient } from "@/lib/db/prisma";
import {
  areCountriesCompatible,
  describeCountry,
  listCountryMappings,
} from "@/lib/normalization/country";
import { buildCountryConflictReport } from "@/lib/players/country-conflicts";
import {
  getPlayerFieldMappingContract,
  normalizeCanonicalField,
} from "@/lib/normalization/field-mapping";
import { getDashboardOverview } from "@/lib/overview";
import {
  ActionJobStatus,
  ActionJobType,
  cancelActionJob,
  cancelActiveActionJobs,
  cancelScheduledFollowups,
  getActionJob,
  getLatestActionJob,
  startActionJob,
} from "@/lib/jobs/action-job";
import {
  getCleanScrapeJob,
  getLatestCleanScrapeJob,
  startCleanScrapeJob,
} from "@/lib/scrapers/clean-job";
import { isWTTGenderedSinglesEvent } from "@/lib/wtt/events";

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: JsonObject;
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

interface DiagnosticMatch {
  source: "ttbl" | "wtt";
  matchId: string;
  seasonOrYear: string | null;
  occurredAt: string | null;
  state: string | null;
  notFinished: boolean;
  ongoing: boolean;
  today: boolean;
  legacy: boolean;
  place: string | null;
  event: string | null;
  homeOrPlayerA: string | null;
  awayOrPlayerX: string | null;
  score: string | null;
}

interface DiagnosticPlace {
  source: "ttbl" | "wtt";
  place: string;
  matches: number;
  currentMatches: number;
  legacyMatches: number;
  todayMatches: number;
  ongoingMatches: number;
}

interface DatasetSnapshot {
  generatedAt: string;
  matches: DiagnosticMatch[];
  places: DiagnosticPlace[];
  latestTTBLSeasonStart: number;
  latestWTTYear: number;
}

interface ToolContext {
  dataset?: DatasetSnapshot;
}

type ToolHandler = (args: JsonObject, ctx: ToolContext) => Promise<unknown>;

const SERVER_NAME = "ttbl-wtt-control-deck";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";

const MAX_MATCH_LIMIT = 1000;
const DEFAULT_MATCH_LIMIT = 100;
const MAX_PLACE_LIMIT = 500;
const DEFAULT_PLACE_LIMIT = 100;
const ACTION_JOB_TYPES: ActionJobType[] = [
  "ttbl",
  "ttbl-legacy",
  "ttbl-all-time",
  "wtt",
  "wtt-all-time",
  "players-registry",
  "destroy-data",
];

function parseActionJobType(value: unknown): ActionJobType | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim() as ActionJobType;
  return ACTION_JOB_TYPES.includes(normalized) ? normalized : null;
}

function parseSeasonStart(value: string | null | undefined): number {
  const match = value?.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (!match?.[1]) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSeasonToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly?.[1]) {
    const start = Number.parseInt(yearOnly[1], 10);
    return Number.isFinite(start) ? `${start}-${start + 1}` : null;
  }

  const range = trimmed.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (!range?.[1] || !range[2]) {
    return null;
  }

  const start = Number.parseInt(range[1], 10);
  const end = Number.parseInt(range[2], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end !== start + 1) {
    return null;
  }

  return `${start}-${end}`;
}

function normalizeSeasonList(value: unknown): string[] {
  const raw =
    Array.isArray(value)
      ? value.map((item) => String(item))
      : typeof value === "string"
        ? value.split(",")
        : [];

  const set = new Set<string>();
  for (const token of raw) {
    const season = parseSeasonToken(token);
    if (season) {
      set.add(season);
    }
  }

  return [...set].sort((a, b) => parseSeasonStart(b) - parseSeasonStart(a));
}

function normalizeYearList(value: unknown): number[] {
  const raw =
    Array.isArray(value)
      ? value.map((item) => Number.parseInt(String(item), 10))
      : typeof value === "string"
        ? value.split(",").map((item) => Number.parseInt(item.trim(), 10))
        : [];

  return [...new Set(raw.filter((year) => Number.isFinite(year)))].sort((a, b) => b - a);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toIsoFromUnixSeconds(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function toIsoFromYear(value: string | null | undefined): string | null {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(Date.UTC(parsed, 0, 1)).toISOString();
}

function isSameUtcDay(iso: string | null, now: Date): boolean {
  if (!iso) {
    return false;
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

function toTimestamp(iso: string | null): number {
  if (!iso) {
    return 0;
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMatchesNewest(matches: DiagnosticMatch[]): DiagnosticMatch[] {
  return [...matches].sort(
    (a, b) =>
      toTimestamp(b.occurredAt) - toTimestamp(a.occurredAt) ||
      (b.seasonOrYear ?? "").localeCompare(a.seasonOrYear ?? "") ||
      a.matchId.localeCompare(b.matchId),
  );
}

function resolveCurrentTTBLSeason(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (month >= 6) {
    return `${year}-${year + 1}`;
  }
  return `${year - 1}-${year}`;
}

function latestActionStatusForTTBL(): ActionJobStatus | null {
  const single = getLatestActionJob("ttbl");
  const multi = getLatestActionJob("ttbl-legacy");
  if (!single) {
    return multi;
  }
  if (!multi) {
    return single;
  }

  return single.createdAt >= multi.createdAt ? single : multi;
}

function summarizeActionStatus(
  status: ActionJobStatus | null,
  includeLogs: boolean,
  logLines: number,
): JsonObject {
  if (!status) {
    return {
      found: false,
      status: null,
    };
  }

  const summary: JsonObject = {
    found: true,
    jobId: status.jobId,
    type: status.type,
    state: status.state,
    createdAt: status.createdAt,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    updatedAt: status.updatedAt,
    error: status.error,
    result: status.result,
  };

  if (includeLogs) {
    const tail = status.logs.slice(-Math.max(1, logLines));
    summary.logsTail = tail;
    summary.logCount = status.logs.length;
  }

  return summary;
}

function scoreFromWTTMatch(match: { finalSetsA: number; finalSetsX: number }): string | null {
  const aSets = match.finalSetsA;
  const xSets = match.finalSetsX;
  if (!Number.isFinite(aSets) || !Number.isFinite(xSets)) {
    return null;
  }
  return `${aSets}-${xSets}`;
}

async function buildDatasetSnapshot(): Promise<DatasetSnapshot> {
  const now = new Date();
  const matches: DiagnosticMatch[] = [];
  const prisma = getPrismaClient();
  if (!prisma) {
    return {
      generatedAt: new Date().toISOString(),
      matches: [],
      places: [],
      latestTTBLSeasonStart: 0,
      latestWTTYear: 0,
    };
  }

  const [ttblRows, ttblGameRows, wttRows] = await Promise.all([
    prisma.ttblMatch.findMany({
      where: { isYouth: false },
      select: {
        id: true,
        season: true,
        timestampMs: true,
        matchState: true,
        gameday: true,
        venue: true,
        homeTeamName: true,
        awayTeamName: true,
        homeGameWins: true,
        awayGameWins: true,
      },
    }),
    prisma.ttblGame.findMany({
      where: {
        isYouth: false,
        gameState: "Finished",
      },
      select: {
        matchId: true,
        format: true,
        winnerSide: true,
      },
    }),
    prisma.wttMatch.findMany({
      where: { isYouth: false },
      select: {
        id: true,
        year: true,
        lastUpdatedAt: true,
        resultStatus: true,
        notFinished: true,
        ongoing: true,
        tournament: true,
        event: true,
        stage: true,
        round: true,
        playerAId: true,
        playerAName: true,
        playerXId: true,
        playerXName: true,
        finalSetsA: true,
        finalSetsX: true,
      },
    }),
  ]);

  const latestTTBLSeasonStart = ttblRows.reduce(
    (max, row) => Math.max(max, parseSeasonStart(row.season)),
    0,
  );
  const ttblDerivedScoreByMatchId = new Map<string, { home: number; away: number }>();
  for (const row of ttblGameRows) {
    if (row.format === "doubles") {
      continue;
    }

    const existing = ttblDerivedScoreByMatchId.get(row.matchId) ?? { home: 0, away: 0 };
    if (row.winnerSide === "Home") {
      existing.home += 1;
    } else if (row.winnerSide === "Away") {
      existing.away += 1;
    }
    ttblDerivedScoreByMatchId.set(row.matchId, existing);
  }

  for (const row of ttblRows) {
    const seasonStart = parseSeasonStart(row.season);
    const legacy = latestTTBLSeasonStart > 0 && seasonStart < latestTTBLSeasonStart;
    const occurredAt = toIsoFromUnixSeconds(Number(row.timestampMs));
    const state = row.matchState ?? null;
    const normalizedState = (state ?? "").toLowerCase().replace(/\s+/g, "");
    const preMatch = /(inactive|scheduled|upcoming|pending|notstarted|startlist|draw)/.test(
      normalizedState,
    );
    const ongoing = /(live|running|ongoing|inprogress|active)/.test(normalizedState);
    const notFinished = normalizedState !== "finished" && !preMatch;

    const derivedScore = ttblDerivedScoreByMatchId.get(row.id) ?? null;
    const homeScore = Number.isFinite(row.homeGameWins)
      ? row.homeGameWins
      : (derivedScore?.home ?? null);
    const awayScore = Number.isFinite(row.awayGameWins)
      ? row.awayGameWins
      : (derivedScore?.away ?? null);

    matches.push({
      source: "ttbl",
      matchId: row.id,
      seasonOrYear: row.season,
      occurredAt,
      state,
      notFinished,
      ongoing,
      today: isSameUtcDay(occurredAt, now),
      legacy,
      place: row.venue ?? null,
      event: row.gameday ?? null,
      homeOrPlayerA: row.homeTeamName ?? null,
      awayOrPlayerX: row.awayTeamName ?? null,
      score: Number.isFinite(homeScore) && Number.isFinite(awayScore) ? `${homeScore}-${awayScore}` : null,
    });
  }

  const latestWTTYear = wttRows.reduce((max, row) => {
    if (!isWTTGenderedSinglesEvent(row.event)) {
      return max;
    }
    return Number.isFinite(row.year) ? Math.max(max, row.year as number) : max;
  }, 0);

  for (const row of wttRows) {
    if (!isWTTGenderedSinglesEvent(row.event)) {
      continue;
    }

    const year = Number.isFinite(row.year) ? String(row.year) : null;
    const parsedYear = Number.parseInt(year ?? "", 10);
    const legacy =
      Number.isFinite(parsedYear) && latestWTTYear > 0
        ? parsedYear < latestWTTYear
        : false;
    const occurredAt = row.lastUpdatedAt?.toISOString() ?? toIsoFromYear(year);

    matches.push({
      source: "wtt",
      matchId: row.id,
      seasonOrYear: year,
      occurredAt,
      state: row.resultStatus ?? (row.notFinished ? "In Progress" : "Finished"),
      notFinished: Boolean(row.notFinished),
      ongoing: Boolean(row.ongoing),
      today: isSameUtcDay(occurredAt, now),
      legacy,
      place: row.tournament ?? null,
      event: row.event ?? row.stage ?? row.round ?? null,
      homeOrPlayerA: row.playerAName ?? row.playerAId,
      awayOrPlayerX: row.playerXName ?? row.playerXId,
      score: scoreFromWTTMatch(row),
    });
  }

  const placeMap = new Map<string, DiagnosticPlace>();
  for (const match of matches) {
    if (!match.place) {
      continue;
    }

    const key = `${match.source}:${match.place}`;
    const existing =
      placeMap.get(key) ??
      ({
        source: match.source,
        place: match.place,
        matches: 0,
        currentMatches: 0,
        legacyMatches: 0,
        todayMatches: 0,
        ongoingMatches: 0,
      } as DiagnosticPlace);

    existing.matches += 1;
    if (match.legacy) {
      existing.legacyMatches += 1;
    } else {
      existing.currentMatches += 1;
    }
    if (match.today) {
      existing.todayMatches += 1;
    }
    if (match.ongoing || match.notFinished) {
      existing.ongoingMatches += 1;
    }
    placeMap.set(key, existing);
  }

  const places = [...placeMap.values()].sort(
    (a, b) => b.matches - a.matches || a.place.localeCompare(b.place),
  );

  return {
    generatedAt: new Date().toISOString(),
    matches: sortMatchesNewest(matches),
    places,
    latestTTBLSeasonStart,
    latestWTTYear,
  };
}

function filterMatches(matches: DiagnosticMatch[], args: JsonObject): DiagnosticMatch[] {
  const source = typeof args.source === "string" ? args.source : "all";
  const scope = typeof args.scope === "string" ? args.scope : "all";
  const season = typeof args.season === "string" ? args.season.trim() : "";
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const year = Number.parseInt(String(args.year ?? ""), 10);

  return matches.filter((row) => {
    if (source !== "all" && row.source !== source) {
      return false;
    }

    if (scope === "today" && !row.today) {
      return false;
    }
    if (scope === "ongoing" && !row.ongoing) {
      return false;
    }
    if (scope === "not_finished" && !row.notFinished) {
      return false;
    }
    if (scope === "legacy" && !row.legacy) {
      return false;
    }
    if (scope === "current" && row.legacy) {
      return false;
    }

    if (season && row.seasonOrYear !== season) {
      return false;
    }

    if (Number.isFinite(year)) {
      const startsWithYear = (row.seasonOrYear ?? "").startsWith(String(year));
      if (!startsWithYear) {
        return false;
      }
    }

    if (!query) {
      return true;
    }

    const hay = [
      row.matchId,
      row.seasonOrYear ?? "",
      row.place ?? "",
      row.event ?? "",
      row.homeOrPlayerA ?? "",
      row.awayOrPlayerX ?? "",
      row.state ?? "",
      row.score ?? "",
    ]
      .join(" ")
      .toLowerCase();

    return hay.includes(query);
  });
}

function filterPlaces(places: DiagnosticPlace[], args: JsonObject): DiagnosticPlace[] {
  const source = typeof args.source === "string" ? args.source : "all";
  const scope = typeof args.scope === "string" ? args.scope : "all";
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";

  return places.filter((row) => {
    if (source !== "all" && row.source !== source) {
      return false;
    }

    if (scope === "legacy" && row.legacyMatches === 0) {
      return false;
    }
    if (scope === "current" && row.currentMatches === 0) {
      return false;
    }
    if (scope === "today" && row.todayMatches === 0) {
      return false;
    }
    if (scope === "ongoing" && row.ongoingMatches === 0) {
      return false;
    }

    if (!query) {
      return true;
    }

    return row.place.toLowerCase().includes(query);
  });
}

function getDatasetFromContext(ctx: ToolContext): Promise<DatasetSnapshot> {
  if (ctx.dataset) {
    return Promise.resolve(ctx.dataset);
  }
  return buildDatasetSnapshot();
}

async function toolGetOverview(): Promise<unknown> {
  return await getDashboardOverview();
}

async function toolStartTTBLScrape(args: JsonObject): Promise<unknown> {
  const seasons = normalizeSeasonList(args.seasons);
  const useCurrentSeason = args.currentSeason === true;
  const resolvedSeasons =
    seasons.length > 0
      ? seasons
      : useCurrentSeason
        ? [resolveCurrentTTBLSeason()]
        : [];

  if (resolvedSeasons.length === 0) {
    throw new Error("Provide seasons or set currentSeason=true.");
  }

  const numGamedays = Number.parseInt(String(args.numGamedays ?? ""), 10);
  const delayMs = Number.parseInt(String(args.delayMs ?? ""), 10);

  const startResult =
    resolvedSeasons.length > 1
      ? startActionJob("ttbl-legacy", {
          seasons: resolvedSeasons,
          numGamedays: Number.isFinite(numGamedays) ? numGamedays : undefined,
          delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
        })
      : startActionJob("ttbl", {
          season: resolvedSeasons[0],
          numGamedays: Number.isFinite(numGamedays) ? numGamedays : undefined,
          delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
        });

  return {
    requestedSeasons: resolvedSeasons,
    alreadyRunning: startResult.alreadyRunning,
    status: summarizeActionStatus(startResult.status, false, 0),
  };
}

async function toolStartWTTScrape(args: JsonObject): Promise<unknown> {
  const nowYear = new Date().getUTCFullYear();
  const years = normalizeYearList(args.years);
  const useCurrentYear = args.currentYear === true;
  const resolvedYears = years.length > 0 ? years : useCurrentYear ? [nowYear] : [];

  if (resolvedYears.length === 0) {
    throw new Error("Provide years or set currentYear=true.");
  }

  const pageSize = Number.parseInt(String(args.pageSize ?? ""), 10);
  const maxPages = Number.parseInt(String(args.maxPages ?? ""), 10);
  const maxEventsPerYear = Number.parseInt(String(args.maxEventsPerYear ?? ""), 10);
  const recentDays = Number.parseInt(String(args.recentDays ?? ""), 10);
  const delayMs = Number.parseInt(String(args.delayMs ?? ""), 10);
  const tournamentScope =
    args.tournamentScope === "all" ? "all" : args.tournamentScope === "wtt_only" ? "wtt_only" : undefined;
  const eventScope =
    args.eventScope === "all" ? "all" : args.eventScope === "singles_only" ? "singles_only" : undefined;
  const includeYouth = args.includeYouth === true ? true : args.includeYouth === false ? false : undefined;
  const profileEnrichMaxPlayers = Number.parseInt(
    String(args.profileEnrichMaxPlayers ?? ""),
    10,
  );
  const profileEnrichMinMatches = Number.parseInt(
    String(args.profileEnrichMinMatches ?? ""),
    10,
  );

  const { alreadyRunning, status } = startActionJob("wtt", {
    years: resolvedYears,
    pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
    maxEventsPerYear: Number.isFinite(maxEventsPerYear) ? maxEventsPerYear : undefined,
    recentDays: Number.isFinite(recentDays) ? recentDays : undefined,
    delayMs: Number.isFinite(delayMs) ? delayMs : undefined,
    tournamentScope,
    eventScope,
    includeYouth,
    profileEnrichMaxPlayers: Number.isFinite(profileEnrichMaxPlayers)
      ? profileEnrichMaxPlayers
      : undefined,
    profileEnrichMinMatches: Number.isFinite(profileEnrichMinMatches)
      ? profileEnrichMinMatches
      : undefined,
  });

  return {
    requestedYears: resolvedYears,
    alreadyRunning,
    status: summarizeActionStatus(status, false, 0),
  };
}

async function toolStartWTTAllTimeScrape(args: JsonObject): Promise<unknown> {
  const numberOrUndefined = (value: unknown): number | undefined => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const tournamentScope =
    args.tournamentScope === "all" ? "all" : args.tournamentScope === "wtt_only" ? "wtt_only" : undefined;
  const eventScope =
    args.eventScope === "all" ? "all" : args.eventScope === "singles_only" ? "singles_only" : undefined;
  const includeYouth = args.includeYouth === true ? true : args.includeYouth === false ? false : undefined;

  const { alreadyRunning, status } = startActionJob("wtt-all-time", {
    startYear: numberOrUndefined(args.startYear),
    endYear: numberOrUndefined(args.endYear),
    pageSize: numberOrUndefined(args.pageSize),
    maxPages: numberOrUndefined(args.maxPages),
    maxEventsPerYear: numberOrUndefined(args.maxEventsPerYear),
    recentDays: numberOrUndefined(args.recentDays),
    delayMs: numberOrUndefined(args.delayMs),
    tournamentScope,
    eventScope,
    includeYouth,
    profileEnrichMaxPlayers: numberOrUndefined(args.profileEnrichMaxPlayers),
    profileEnrichMinMatches: numberOrUndefined(args.profileEnrichMinMatches),
  });

  return {
    requestedOptions: {
      startYear: numberOrUndefined(args.startYear),
      endYear: numberOrUndefined(args.endYear),
      pageSize: numberOrUndefined(args.pageSize),
      maxPages: numberOrUndefined(args.maxPages),
      maxEventsPerYear: numberOrUndefined(args.maxEventsPerYear),
      recentDays: numberOrUndefined(args.recentDays),
      delayMs: numberOrUndefined(args.delayMs),
      tournamentScope,
      eventScope,
      includeYouth,
      profileEnrichMaxPlayers: numberOrUndefined(args.profileEnrichMaxPlayers),
      profileEnrichMinMatches: numberOrUndefined(args.profileEnrichMinMatches),
    },
    alreadyRunning,
    status: summarizeActionStatus(status, false, 0),
  };
}

async function toolStartMasterScrape(args: JsonObject): Promise<unknown> {
  const numberOrUndefined = (value: unknown): number | undefined => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const options = {
    ttblStartYear: numberOrUndefined(args.ttblStartYear),
    ttblEndYear: numberOrUndefined(args.ttblEndYear),
    ttblNumGamedays: numberOrUndefined(args.ttblNumGamedays),
    wttStartYear: numberOrUndefined(args.wttStartYear),
    wttEndYear: numberOrUndefined(args.wttEndYear),
    wttPageSize: numberOrUndefined(args.wttPageSize),
    wttMaxPages: numberOrUndefined(args.wttMaxPages),
    delayMs: numberOrUndefined(args.delayMs),
  };

  const { alreadyRunning, status } = startCleanScrapeJob(options);
  return {
    requestedOptions: options,
    alreadyRunning,
    status,
  };
}

async function toolGetScrapeStatus(args: JsonObject): Promise<unknown> {
  const target = typeof args.target === "string" ? args.target : "ttbl";
  const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
  const includeLogs = args.includeLogs === true;
  const logLines = clamp(
    Number.parseInt(String(args.logLines ?? 50), 10) || 50,
    1,
    500,
  );

  if (target === "master") {
    const status = jobId ? getCleanScrapeJob(jobId) : getLatestCleanScrapeJob();
    if (!status) {
      return {
        found: false,
        target,
      };
    }

    const summary: JsonObject = {
      found: true,
      target,
      jobId: status.jobId,
      state: status.state,
      createdAt: status.createdAt,
      startedAt: status.startedAt,
      finishedAt: status.finishedAt,
      updatedAt: status.updatedAt,
      error: status.error,
      result: status.result,
    };

    if (includeLogs) {
      summary.logsTail = status.logs.slice(-logLines);
      summary.logCount = status.logs.length;
    }

    return summary;
  }

  let status: ActionJobStatus | null = null;
  if (jobId) {
    status = getActionJob(jobId);
  } else if (target === "ttbl") {
    status = latestActionStatusForTTBL();
  } else {
    const validTarget = target as ActionJobType;
    status = getLatestActionJob(validTarget);
  }

  return {
    target,
    ...summarizeActionStatus(status, includeLogs, logLines),
  };
}

async function toolCancelScrapeJobs(args: JsonObject): Promise<unknown> {
  const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
  const type = parseActionJobType(args.target);
  const includeQueued = args.includeQueued !== false;
  const clearFollowups = args.clearFollowups !== false;
  const reason =
    typeof args.reason === "string" && args.reason.trim().length > 0
      ? args.reason.trim()
      : "Cancelled from MCP.";

  let cancelled:
    | { cancelled: Array<{ jobId: string; type: ActionJobType; state: string }>; count: number }
    | null = null;
  let single: ReturnType<typeof cancelActionJob> | null = null;

  if (jobId) {
    single = cancelActionJob(jobId, reason);
    cancelled = null;
  } else {
    cancelled = cancelActiveActionJobs({
      type: type ?? undefined,
      includeQueued,
      reason,
    });
  }

  let followups: ReturnType<typeof cancelScheduledFollowups> | null = null;
  if (clearFollowups) {
    const followupTarget =
      type === "ttbl" || type === "ttbl-legacy" || type === "ttbl-all-time"
        ? "ttbl"
        : type === "wtt" || type === "wtt-all-time"
          ? "wtt"
          : "all";
    followups = cancelScheduledFollowups(followupTarget);
  }

  return {
    requested: {
      jobId: jobId || null,
      target: type ?? null,
      includeQueued,
      clearFollowups,
      reason,
    },
    single,
    cancelled,
    followups,
  };
}

async function toolListMatches(args: JsonObject, ctx: ToolContext): Promise<unknown> {
  const dataset = await getDatasetFromContext(ctx);
  const limit = clamp(
    Number.parseInt(String(args.limit ?? DEFAULT_MATCH_LIMIT), 10) || DEFAULT_MATCH_LIMIT,
    1,
    MAX_MATCH_LIMIT,
  );

  const filtered = filterMatches(dataset.matches, args);
  const rows = filtered.slice(0, limit);
  return {
    generatedAt: dataset.generatedAt,
    totalMatches: filtered.length,
    returnedMatches: rows.length,
    truncated: filtered.length > rows.length,
    filters: {
      source: args.source ?? "all",
      scope: args.scope ?? "all",
      season: args.season ?? null,
      year: args.year ?? null,
      query: args.query ?? null,
      limit,
    },
    notes: [
      "today/ongoing are reliable for TTBL timestamps and states.",
      "WTT rows now persist result_status/ongoing/not_finished when available from source feeds.",
    ],
    matches: rows,
  };
}

async function toolListPlaces(args: JsonObject, ctx: ToolContext): Promise<unknown> {
  const dataset = await getDatasetFromContext(ctx);
  const limit = clamp(
    Number.parseInt(String(args.limit ?? DEFAULT_PLACE_LIMIT), 10) || DEFAULT_PLACE_LIMIT,
    1,
    MAX_PLACE_LIMIT,
  );

  const filtered = filterPlaces(dataset.places, args);
  const rows = filtered.slice(0, limit);
  return {
    generatedAt: dataset.generatedAt,
    totalPlaces: filtered.length,
    returnedPlaces: rows.length,
    truncated: filtered.length > rows.length,
    filters: {
      source: args.source ?? "all",
      scope: args.scope ?? "all",
      query: args.query ?? null,
      limit,
    },
    places: rows,
  };
}

async function toolHealthCheck(args: JsonObject, ctx: ToolContext): Promise<unknown> {
  const dataset = await getDatasetFromContext(ctx);
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentTTBLSeason = resolveCurrentTTBLSeason(now);
  const includeSamples = args.includeSamples !== false;

  const hasCurrentTTBLSeason = dataset.matches.some(
    (row) => row.source === "ttbl" && row.seasonOrYear === currentTTBLSeason,
  );
  const hasCurrentWTTYear = dataset.matches.some(
    (row) => row.source === "wtt" && row.seasonOrYear === String(currentYear),
  );
  const todayMatches = dataset.matches.filter((row) => row.today);
  const ongoingMatches = dataset.matches.filter((row) => row.ongoing);
  const notFinishedMatches = dataset.matches.filter((row) => row.notFinished);
  const legacyTTBL = dataset.matches.filter((row) => row.source === "ttbl" && row.legacy).length;
  const legacyWTT = dataset.matches.filter((row) => row.source === "wtt" && row.legacy).length;

  const latestMaster = getLatestCleanScrapeJob();
  const latestTTBL = latestActionStatusForTTBL();
  const latestWTT = getLatestActionJob("wtt");
  const latestWTTAllTime = getLatestActionJob("wtt-all-time");

  return {
    generatedAt: dataset.generatedAt,
    checks: {
      canScrapeCurrentTTBLSeason: hasCurrentTTBLSeason,
      canScrapeCurrentWTTYear: hasCurrentWTTYear,
      todayMatchesAvailable: todayMatches.length > 0,
      ongoingMatchesAvailable: ongoingMatches.length > 0,
      notFinishedMatchesAvailable: notFinishedMatches.length > 0,
      legacyTTBLMatchesAvailable: legacyTTBL > 0,
      legacyWTTMatchesAvailable: legacyWTT > 0,
    },
    counts: {
      totalMatches: dataset.matches.length,
      ttblMatches: dataset.matches.filter((row) => row.source === "ttbl").length,
      wttMatches: dataset.matches.filter((row) => row.source === "wtt").length,
      todayMatches: todayMatches.length,
      ongoingMatches: ongoingMatches.length,
      notFinishedMatches: notFinishedMatches.length,
      legacyTTBLMatches: legacyTTBL,
      legacyWTTMatches: legacyWTT,
      places: dataset.places.length,
    },
    jobs: {
      latestMaster: latestMaster
        ? {
            jobId: latestMaster.jobId,
            state: latestMaster.state,
            updatedAt: latestMaster.updatedAt,
            error: latestMaster.error,
          }
        : null,
      latestTTBL: latestTTBL
        ? {
            jobId: latestTTBL.jobId,
            type: latestTTBL.type,
            state: latestTTBL.state,
            updatedAt: latestTTBL.updatedAt,
            error: latestTTBL.error,
          }
        : null,
      latestWTT: latestWTT
        ? {
            jobId: latestWTT.jobId,
            type: latestWTT.type,
            state: latestWTT.state,
            updatedAt: latestWTT.updatedAt,
            error: latestWTT.error,
          }
        : null,
      latestWTTAllTime: latestWTTAllTime
        ? {
            jobId: latestWTTAllTime.jobId,
            type: latestWTTAllTime.type,
            state: latestWTTAllTime.state,
            updatedAt: latestWTTAllTime.updatedAt,
            error: latestWTTAllTime.error,
          }
        : null,
    },
    samples: includeSamples
      ? {
          todayMatches: todayMatches.slice(0, 10),
          ongoingMatches: ongoingMatches.slice(0, 10),
          notFinishedMatches: notFinishedMatches.slice(0, 10),
        }
      : null,
    assumptions: [
      `current TTBL season inferred as ${currentTTBLSeason}`,
      `current WTT year inferred as ${currentYear}`,
      "WTT rows are year-granular from public Fabrik data; no official daily status is exposed there.",
    ],
  };
}

async function toolFieldMapping(args: JsonObject): Promise<unknown> {
  const mode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "describe";
  const field = typeof args.field === "string" ? args.field.trim() : "";

  if (mode === "describe") {
    const contract = getPlayerFieldMappingContract();
    if (!field) {
      return contract;
    }

    const row = contract.fields.find(
      (entry) => entry.field.toLowerCase() === field.toLowerCase(),
    );
    return {
      ...contract,
      fields: row ? [row] : [],
      found: Boolean(row),
      requestedField: field,
    };
  }

  if (mode === "normalize") {
    if (!field) {
      throw new Error("field is required when mode=normalize");
    }

    return normalizeCanonicalField(field, args.value, {
      source: typeof args.source === "string" ? args.source : null,
      unit: typeof args.unit === "string" ? args.unit : null,
    });
  }

  throw new Error("mode must be 'describe' or 'normalize'");
}

async function toolMatchCountry(args: JsonObject): Promise<unknown> {
  const value = typeof args.value === "string" ? args.value : null;
  const left = typeof args.left === "string" ? args.left : null;
  const right = typeof args.right === "string" ? args.right : null;
  const includeCatalog = args.includeCatalog === true;

  if (!value && (!left || !right) && !includeCatalog) {
    throw new Error("Provide value, left+right, or includeCatalog=true.");
  }

  return {
    value: value ? describeCountry(value) : null,
    comparison:
      left && right
        ? {
            left: describeCountry(left),
            right: describeCountry(right),
            compatible: areCountriesCompatible(left, right),
          }
        : null,
    catalog: includeCatalog ? listCountryMappings() : null,
  };
}

async function toolAuditCountryConflicts(args: JsonObject): Promise<unknown> {
  const limit = clamp(
    Number.parseInt(String(args.limit ?? 100), 10) || 100,
    1,
    500,
  );
  const includeCompatible = args.includeCompatible === true;
  const includeCountryDetail = args.includeCountryDetail === true;

  return await buildCountryConflictReport({
    limit,
    includeCompatible,
    includeCountryDetail,
  });
}

const tools: Array<MCPToolDefinition & { handler: ToolHandler }> = [
  {
    name: "get_overview",
    description: "Read dashboard overview with TTBL/WTT totals and registry state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    handler: async () => await toolGetOverview(),
  },
  {
    name: "start_ttbl_scrape",
    description:
      "Start TTBL scrape for specified seasons or inferred current season.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        seasons: {
          anyOf: [
            { type: "string", description: "CSV, e.g. 2025,2024-2025" },
            { type: "array", items: { type: "string" } },
          ],
        },
        currentSeason: { type: "boolean" },
        numGamedays: { type: "integer", minimum: 1 },
        delayMs: { type: "integer", minimum: 0 },
      },
    },
    handler: async (args) => await toolStartTTBLScrape(args),
  },
  {
    name: "start_wtt_scrape",
    description: "Start WTT scrape for specified years or current year.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        years: {
          anyOf: [
            { type: "string", description: "CSV, e.g. 2026,2025" },
            { type: "array", items: { type: "integer" } },
          ],
        },
        currentYear: { type: "boolean" },
        pageSize: { type: "integer", minimum: 1 },
        maxPages: { type: "integer", minimum: 1 },
        maxEventsPerYear: { type: "integer", minimum: 1 },
        recentDays: { type: "integer", minimum: 1 },
        delayMs: { type: "integer", minimum: 0 },
        tournamentScope: { type: "string", enum: ["wtt_only", "all"] },
        eventScope: { type: "string", enum: ["singles_only", "all"] },
        includeYouth: { type: "boolean" },
        profileEnrichMaxPlayers: { type: "integer", minimum: 0 },
        profileEnrichMinMatches: { type: "integer", minimum: 1 },
      },
    },
    handler: async (args) => await toolStartWTTScrape(args),
  },
  {
    name: "start_wtt_all_time_scrape",
    description:
      "Start all-time WTT scrape (year discovery + scrape + player registry rebuild) without deleting TTBL data.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startYear: { type: "integer" },
        endYear: { type: "integer" },
        pageSize: { type: "integer", minimum: 1 },
        maxPages: { type: "integer", minimum: 1 },
        maxEventsPerYear: { type: "integer", minimum: 1 },
        recentDays: { type: "integer", minimum: 1 },
        delayMs: { type: "integer", minimum: 0 },
        tournamentScope: { type: "string", enum: ["wtt_only", "all"] },
        eventScope: { type: "string", enum: ["singles_only", "all"] },
        includeYouth: { type: "boolean" },
        profileEnrichMaxPlayers: { type: "integer", minimum: 0 },
        profileEnrichMinMatches: { type: "integer", minimum: 1 },
      },
    },
    handler: async (args) => await toolStartWTTAllTimeScrape(args),
  },
  {
    name: "start_master_scrape",
    description:
      "Start full clean master scrape (TTBL all-time + WTT all-time + player registry rebuild).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ttblStartYear: { type: "integer" },
        ttblEndYear: { type: "integer" },
        ttblNumGamedays: { type: "integer", minimum: 1 },
        wttStartYear: { type: "integer" },
        wttEndYear: { type: "integer" },
        wttPageSize: { type: "integer", minimum: 1 },
        wttMaxPages: { type: "integer", minimum: 1 },
        delayMs: { type: "integer", minimum: 0 },
      },
    },
    handler: async (args) => await toolStartMasterScrape(args),
  },
  {
    name: "get_scrape_status",
    description: "Get TTBL/WTT/master/registry scrape job status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          enum: [
            "ttbl",
            "ttbl-legacy",
            "wtt",
            "wtt-all-time",
            "master",
            "players-registry",
            "destroy-data",
          ],
        },
        jobId: { type: "string" },
        includeLogs: { type: "boolean" },
        logLines: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["target"],
    },
    handler: async (args) => await toolGetScrapeStatus(args),
  },
  {
    name: "cancel_scrape_jobs",
    description:
      "Cancel one job by jobId or cancel currently active jobs, with optional follow-up timer cancellation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        jobId: { type: "string" },
        target: {
          type: "string",
          enum: [
            "ttbl",
            "ttbl-legacy",
            "ttbl-all-time",
            "wtt",
            "wtt-all-time",
            "players-registry",
            "destroy-data",
          ],
        },
        includeQueued: { type: "boolean" },
        clearFollowups: { type: "boolean" },
        reason: { type: "string" },
      },
    },
    handler: async (args) => await toolCancelScrapeJobs(args),
  },
  {
    name: "list_matches",
    description:
      "List TTBL/WTT matches with filters for today, ongoing, not finished, legacy, current, season/year, and query.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", enum: ["all", "ttbl", "wtt"] },
        scope: {
          type: "string",
          enum: ["all", "today", "ongoing", "not_finished", "legacy", "current"],
        },
        season: { type: "string" },
        year: { type: "integer" },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_MATCH_LIMIT },
      },
    },
    handler: async (args, ctx) => await toolListMatches(args, ctx),
  },
  {
    name: "list_places",
    description:
      "List TTBL venues and WTT tournaments with match counts and scope filters.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", enum: ["all", "ttbl", "wtt"] },
        scope: {
          type: "string",
          enum: ["all", "today", "ongoing", "legacy", "current"],
        },
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PLACE_LIMIT },
      },
    },
    handler: async (args, ctx) => await toolListPlaces(args, ctx),
  },
  {
    name: "health_check",
    description:
      "Run scrape health diagnostics (current year, today, ongoing, legacy, and latest job states).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeSamples: { type: "boolean" },
      },
    },
    handler: async (args, ctx) => await toolHealthCheck(args, ctx),
  },
  {
    name: "match_country",
    description:
      "Normalize/compare country values and aliases (codes + names), including compatibility checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        value: { type: "string" },
        left: { type: "string" },
        right: { type: "string" },
        includeCatalog: { type: "boolean" },
      },
    },
    handler: async (args) => await toolMatchCountry(args),
  },
  {
    name: "audit_country_conflicts",
    description:
      "List country-related merge blockers/candidates and show normalized compatibility across canonical pairs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
        includeCompatible: { type: "boolean" },
        includeCountryDetail: { type: "boolean" },
      },
    },
    handler: async (args) => await toolAuditCountryConflicts(args),
  },
  {
    name: "field_mapping",
    description:
      "Describe canonical cross-source player field mappings and normalize sample values (dates, country, gender, unit conversions).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["describe", "normalize"] },
        field: { type: "string" },
        value: {},
        source: { type: "string" },
        unit: { type: "string" },
      },
    },
    handler: async (args) => await toolFieldMapping(args),
  },
];

function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function formatToolResult(payload: unknown): JsonObject {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function callTool(name: string, args: JsonObject): Promise<unknown> {
  const tool = tools.find((row) => row.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const needsDataset = name === "list_matches" || name === "list_places" || name === "health_check";
  const ctx: ToolContext = {};
  if (needsDataset) {
    ctx.dataset = await buildDatasetSnapshot();
  }

  return await tool.handler(args, ctx);
}

export async function handleMCPRequest(payload: unknown): Promise<JsonObject | null> {
  const request = (payload ?? {}) as JsonRpcRequest;
  const id = request.id ?? null;
  const hasId = Object.prototype.hasOwnProperty.call(request, "id");
  const method = request.method;

  if (request.jsonrpc !== "2.0" || typeof method !== "string") {
    if (!hasId) {
      return null;
    }
    return jsonRpcError(id, -32600, "Invalid Request");
  }

  // MCP notifications are fire-and-forget and should not produce JSON-RPC responses.
  if (!hasId && method.startsWith("notifications/")) {
    return null;
  }

  if (method === "initialize") {
    return jsonRpcSuccess(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      capabilities: {
        tools: {},
      },
    });
  }

  if (method === "ping") {
    return jsonRpcSuccess(id, {});
  }

  if (method === "tools/list") {
    return jsonRpcSuccess(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const name = typeof request.params?.name === "string" ? request.params.name : "";
    const args = (request.params?.arguments as JsonObject | undefined) ?? {};

    if (!name) {
      return jsonRpcError(id, -32602, "tools/call requires params.name");
    }

    try {
      const result = await callTool(name, args);
      return jsonRpcSuccess(id, formatToolResult(result));
    } catch (error) {
      return jsonRpcError(
        id,
        -32000,
        error instanceof Error ? error.message : "tool execution failed",
      );
    }
  }

  if (method === "resources/list") {
    return jsonRpcSuccess(id, {
      resources: [],
    });
  }

  if (method === "resources/templates/list") {
    return jsonRpcSuccess(id, {
      resourceTemplates: [],
    });
  }

  if (!hasId) {
    return null;
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function getMCPToolCatalog(): MCPToolDefinition[] {
  return tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}
