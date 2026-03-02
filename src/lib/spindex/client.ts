import { getPlayerSlugOverview } from "@/lib/players/slugs";

export type SpindexScoreField = "winRate" | "wins" | "matchesPlayed";
export type SpindexIdStrategy = "none" | "ttbl" | "wtt" | "first";

interface SpindexClientBaseOptions {
  apiBaseUrl?: string;
  authToken?: string;
  timeoutMs?: number;
}

export interface SpindexPingOptions extends SpindexClientBaseOptions {
  publicStatusPath?: string;
}

export interface SpindexCheckOptions extends SpindexClientBaseOptions {
  scoreField?: SpindexScoreField;
  minMatches?: number;
  maxPlayers?: number;
  idStrategy?: SpindexIdStrategy;
  idOverrides?: Record<string, string>;
  includeWithoutSpindexId?: boolean;
  includeRemote?: boolean;
  cutoffDate?: string;
  privatePlayersListPath?: string;
}

export interface SpindexUpdateOptions extends SpindexCheckOptions {
  dryRun?: boolean;
  batchSize?: number;
  onlyChanged?: boolean;
  requireRemoteMatch?: boolean;
  maxUpdates?: number;
  privatePlayersPatchPath?: string;
}

export interface SpindexPingReport {
  ok: boolean;
  checkedAt: string;
  target: string;
  status: number;
  message: string;
}

export interface SpindexLocalPlayerRow {
  canonicalKey: string;
  displayName: string;
  firstName: string;
  lastName: string;
  gender: string;
  country: string | null;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  spindexId: string | null;
  scoreField: SpindexScoreField;
  score: number;
}

export interface SpindexCompareRow {
  canonicalKey: string;
  displayName: string;
  spindexId: string;
  firstName: string;
  lastName: string;
  gender: string;
  country: string | null;
  matchesPlayed: number;
  wins: number;
  losses: number;
  localScoreField: SpindexScoreField;
  localScore: number;
  remoteFound: boolean;
  remoteMlttRating: number | null;
  scoreDelta: number | null;
}

export interface SpindexCheckReport {
  generatedAt: string;
  localTotalCandidates: number;
  localRowsIncluded: number;
  localRowsWithSpindexId: number;
  localRowsWithoutSpindexId: number;
  remoteLookupsAttempted: number;
  remoteRowsFound: number;
  remoteMissing: number;
  invalidSpindexIds: string[];
  ratingMismatches: number;
  rows: SpindexCompareRow[];
  rowsWithoutSpindexId: SpindexLocalPlayerRow[];
  warnings: string[];
}

export interface SpindexUpdateReport {
  dryRun: boolean;
  generatedAt: string;
  target: string;
  localTotalCandidates: number;
  localRowsIncluded: number;
  localRowsWithSpindexId: number;
  eligibleRows: number;
  approvedPlayersPrepared: number;
  attemptedBatches: number;
  successfulBatches: number;
  failedBatches: number;
  skippedRows: {
    noSpindexId: number;
    noRemoteMatch: number;
    unchangedRating: number;
  };
  invalidSpindexIds: string[];
  ratingMismatches: number;
  sampleApprovedPlayers: Array<{ spindexId: string; mlttRating: number }>;
  failures: Array<{ batch: number; status: number; message: string }>;
  warnings: string[];
}

interface SpindexPrivatePlayer {
  spindexId: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  mlttRating?: number;
  mlttRatingEstimated?: number;
  ratingStatus?: string;
  country?: string | null;
}

const DEFAULT_PUBLIC_STATUS_PATH = "/api/public/status";
const DEFAULT_PRIVATE_PLAYERS_LIST_PATH = "/api/private/players/list";
const DEFAULT_PRIVATE_PLAYERS_PATCH_PATH = "/api/private/players";

function withTrailingSlashRemoved(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function toSpindexUrl(apiBaseUrl: string, path: string): string {
  const base = withTrailingSlashRemoved(apiBaseUrl.trim());
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function buildSpindexHeaders(authToken: string | undefined, includeJson = false): HeadersInit {
  const token = authToken?.trim() ?? "";

  return {
    ...(includeJson ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(token ? { "x-api-key": token } : {}),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const tokens = displayName
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return {
      firstName: "Unknown",
      lastName: "",
    };
  }

  if (tokens.length === 1) {
    return {
      firstName: tokens[0] ?? "Unknown",
      lastName: "",
    };
  }

  return {
    firstName: tokens[0] ?? "Unknown",
    lastName: tokens.slice(1).join(" "),
  };
}

function scoreFromRow(
  row: { winRate: number | null; wins: number; matchesPlayed: number },
  field: SpindexScoreField,
): number {
  if (field === "wins") {
    return row.wins;
  }
  if (field === "matchesPlayed") {
    return row.matchesPlayed;
  }

  return row.winRate ?? 0;
}

function parseSourceId(sourceId: string): { source: string; id: string } | null {
  const token = sourceId.trim();
  if (!token) {
    return null;
  }

  const splitIndex = token.indexOf(":");
  if (splitIndex < 0) {
    return {
      source: "",
      id: token,
    };
  }

  return {
    source: token.slice(0, splitIndex).trim().toLowerCase(),
    id: token.slice(splitIndex + 1).trim(),
  };
}

function inferSpindexId(
  row: { canonicalKey: string; sourceIds: string[] },
  strategy: SpindexIdStrategy,
  idOverrides: Record<string, string>,
): string | null {
  const override = idOverrides[row.canonicalKey]?.trim() ?? "";
  if (override) {
    return override;
  }

  const parsedSourceIds = row.sourceIds
    .map((token) => parseSourceId(token))
    .filter((value): value is { source: string; id: string } => Boolean(value?.id));

  const explicit = parsedSourceIds.find((value) => value.source === "spindex")?.id ?? "";
  if (explicit) {
    return explicit;
  }

  if (strategy === "none") {
    return null;
  }

  const ttbl =
    parsedSourceIds.find((value) => value.source === "ttbl" && !value.id.startsWith("name:"))?.id ??
    "";
  const wtt =
    parsedSourceIds.find((value) => value.source === "wtt" && !value.id.startsWith("name:"))?.id ??
    "";

  if (strategy === "ttbl") {
    return ttbl || null;
  }

  if (strategy === "wtt") {
    return wtt || null;
  }

  return ttbl || wtt || null;
}

async function buildLocalPlayerRows(
  options: Pick<
    SpindexCheckOptions,
    "scoreField" | "minMatches" | "maxPlayers" | "idStrategy" | "idOverrides"
  >,
): Promise<{ totalCandidates: number; rows: SpindexLocalPlayerRow[] }> {
  const scoreField = options.scoreField ?? "winRate";
  const minMatches = Math.max(0, options.minMatches ?? 0);
  const maxPlayers = Math.max(1, Math.min(options.maxPlayers ?? 500, 5000));
  const idStrategy = options.idStrategy ?? "none";
  const idOverrides = options.idOverrides ?? {};

  const overview = await getPlayerSlugOverview();

  const filtered = overview.players
    .filter((row) => row.matchesPlayed >= minMatches)
    .sort(
      (a, b) =>
        b.matchesPlayed - a.matchesPlayed ||
        b.wins - a.wins ||
        a.displayName.localeCompare(b.displayName),
    );

  const rows = filtered.slice(0, maxPlayers).map((row) => {
    const { firstName, lastName } = splitDisplayName(row.displayName);

    return {
      canonicalKey: row.canonicalKey,
      displayName: row.displayName,
      firstName,
      lastName,
      gender: row.gender,
      country: row.country,
      matchesPlayed: row.matchesPlayed,
      wins: row.wins,
      losses: row.losses,
      winRate: row.winRate,
      spindexId: inferSpindexId(row, idStrategy, idOverrides),
      scoreField,
      score: scoreFromRow(row, scoreField),
    } as SpindexLocalPlayerRow;
  });

  return {
    totalCandidates: filtered.length,
    rows,
  };
}

function chunkValues<T>(values: T[], size: number): T[][] {
  if (size <= 0) {
    return [values];
  }

  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

async function fetchSpindexPlayersByIds(
  options: Required<
    Pick<SpindexCheckOptions, "apiBaseUrl" | "authToken" | "timeoutMs" | "privatePlayersListPath">
  >,
  ids: string[],
  cutoffDate?: string,
): Promise<{
  players: SpindexPrivatePlayer[];
  invalidSpindexIds: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const playersById = new Map<string, SpindexPrivatePlayer>();
  const invalid = new Set<string>();
  const batches = chunkValues(ids, 200);

  for (const batch of batches) {
    const params = new URLSearchParams();
    params.set("spindexIds", batch.join(","));
    if (cutoffDate?.trim()) {
      params.set("cutoffDate", cutoffDate.trim());
    }

    const target = `${toSpindexUrl(options.apiBaseUrl, options.privatePlayersListPath)}?${params.toString()}`;

    try {
      const response = await fetchWithTimeout(
        target,
        {
          method: "GET",
          headers: buildSpindexHeaders(options.authToken, false),
        },
        options.timeoutMs,
      );

      if (!response.ok) {
        const message = (await response.text()).slice(0, 500);
        warnings.push(`Spindex list request failed (${response.status}): ${message}`);
        continue;
      }

      const payload = (await response.json()) as {
        players?: SpindexPrivatePlayer[];
        invalidSpindexIds?: string[];
      };

      for (const row of payload.players ?? []) {
        const spindexId = row.spindexId?.trim() ?? "";
        if (!spindexId) {
          continue;
        }
        playersById.set(spindexId, row);
      }

      for (const row of payload.invalidSpindexIds ?? []) {
        const spindexId = (row ?? "").trim();
        if (spindexId) {
          invalid.add(spindexId);
        }
      }
    } catch (error) {
      warnings.push(
        `Spindex list request failed: ${
          error instanceof Error ? error.message : "network/parse error"
        }`,
      );
    }
  }

  return {
    players: [...playersById.values()],
    invalidSpindexIds: [...invalid].sort((a, b) => a.localeCompare(b)),
    warnings,
  };
}

export async function pingSpindex(options: SpindexPingOptions = {}): Promise<SpindexPingReport> {
  const apiBaseUrl = options.apiBaseUrl ?? process.env.SPINDEX_API_BASE_URL ?? "";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const publicStatusPath = options.publicStatusPath ?? DEFAULT_PUBLIC_STATUS_PATH;
  const checkedAt = new Date().toISOString();

  if (!apiBaseUrl.trim()) {
    return {
      ok: false,
      checkedAt,
      target: publicStatusPath,
      status: 0,
      message: "SPINDEX_API_BASE_URL is missing",
    };
  }

  const target = toSpindexUrl(apiBaseUrl, publicStatusPath);

  try {
    const response = await fetchWithTimeout(
      target,
      {
        method: "GET",
        headers: buildSpindexHeaders(undefined, false),
      },
      timeoutMs,
    );

    const message = (await response.text()).slice(0, 500);

    return {
      ok: response.ok,
      checkedAt,
      target,
      status: response.status,
      message,
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      target,
      status: 0,
      message: error instanceof Error ? error.message : "network error",
    };
  }
}

export async function checkPlayersAgainstSpindex(
  options: SpindexCheckOptions = {},
): Promise<SpindexCheckReport> {
  const includeRemote = options.includeRemote ?? true;
  const includeWithoutSpindexId = options.includeWithoutSpindexId ?? true;
  const apiBaseUrl = options.apiBaseUrl ?? process.env.SPINDEX_API_BASE_URL ?? "";
  const authToken = options.authToken ?? process.env.SPINDEX_API_TOKEN ?? "";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const privatePlayersListPath =
    options.privatePlayersListPath ?? DEFAULT_PRIVATE_PLAYERS_LIST_PATH;

  const warnings: string[] = [];
  const localBuilt = await buildLocalPlayerRows(options);
  const localRows = localBuilt.rows;

  const rowsWithId = localRows.filter((row) => Boolean(row.spindexId));
  const rowsWithoutId = localRows.filter((row) => !row.spindexId);
  const spindexIds = [...new Set(rowsWithId.map((row) => row.spindexId as string))].sort((a, b) =>
    a.localeCompare(b),
  );

  const remoteById = new Map<string, SpindexPrivatePlayer>();
  let invalidSpindexIds: string[] = [];

  if (includeRemote) {
    if (!apiBaseUrl.trim()) {
      warnings.push("Remote comparison skipped: SPINDEX_API_BASE_URL is missing.");
    } else if (!authToken.trim()) {
      warnings.push("Remote comparison skipped: SPINDEX_API_TOKEN is missing.");
    } else if (spindexIds.length === 0) {
      warnings.push("Remote comparison skipped: no players have mapped Spindex IDs.");
    } else {
      const remoteResult = await fetchSpindexPlayersByIds(
        {
          apiBaseUrl,
          authToken,
          timeoutMs,
          privatePlayersListPath,
        },
        spindexIds,
        options.cutoffDate,
      );

      for (const row of remoteResult.players) {
        const spindexId = row.spindexId?.trim() ?? "";
        if (spindexId) {
          remoteById.set(spindexId, row);
        }
      }
      invalidSpindexIds = remoteResult.invalidSpindexIds;
      warnings.push(...remoteResult.warnings);
    }
  }

  const comparisonRows: SpindexCompareRow[] = rowsWithId.map((local) => {
    const spindexId = local.spindexId as string;
    const remote = remoteById.get(spindexId) ?? null;
    const remoteMlttRating =
      typeof remote?.mlttRating === "number" && Number.isFinite(remote.mlttRating)
        ? remote.mlttRating
        : null;

    return {
      canonicalKey: local.canonicalKey,
      displayName: local.displayName,
      spindexId,
      firstName: local.firstName,
      lastName: local.lastName,
      gender: local.gender,
      country: local.country,
      matchesPlayed: local.matchesPlayed,
      wins: local.wins,
      losses: local.losses,
      localScoreField: local.scoreField,
      localScore: local.score,
      remoteFound: Boolean(remote),
      remoteMlttRating,
      scoreDelta: remoteMlttRating === null ? null : local.score - remoteMlttRating,
    };
  });

  const filteredRows = includeWithoutSpindexId
    ? comparisonRows
    : comparisonRows.filter((row) => row.remoteFound);

  return {
    generatedAt: new Date().toISOString(),
    localTotalCandidates: localBuilt.totalCandidates,
    localRowsIncluded: localRows.length,
    localRowsWithSpindexId: rowsWithId.length,
    localRowsWithoutSpindexId: rowsWithoutId.length,
    remoteLookupsAttempted: spindexIds.length,
    remoteRowsFound: remoteById.size,
    remoteMissing: comparisonRows.filter((row) => !row.remoteFound).length,
    invalidSpindexIds,
    ratingMismatches: comparisonRows.filter(
      (row) => row.remoteMlttRating !== null && row.remoteMlttRating !== row.localScore,
    ).length,
    rows: filteredRows,
    rowsWithoutSpindexId: rowsWithoutId,
    warnings,
  };
}

function defaultSyncTarget(apiBaseUrl: string, path: string): string {
  if (!apiBaseUrl.trim()) {
    return path;
  }

  return toSpindexUrl(apiBaseUrl, path);
}

export async function syncPlayersToSpindex(
  options: SpindexUpdateOptions = {},
): Promise<SpindexUpdateReport> {
  const dryRun = options.dryRun ?? true;
  const onlyChanged = options.onlyChanged ?? true;
  const requireRemoteMatch = options.requireRemoteMatch ?? true;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1000));
  const maxUpdates = Math.max(0, options.maxUpdates ?? 0);
  const apiBaseUrl = options.apiBaseUrl ?? process.env.SPINDEX_API_BASE_URL ?? "";
  const authToken = options.authToken ?? process.env.SPINDEX_API_TOKEN ?? "";
  const timeoutMs = options.timeoutMs ?? 20_000;
  const privatePlayersPatchPath =
    options.privatePlayersPatchPath ?? DEFAULT_PRIVATE_PLAYERS_PATCH_PATH;

  const compare = await checkPlayersAgainstSpindex({
    ...options,
    includeRemote: true,
  });

  const warnings = [...compare.warnings];

  let noRemoteMatch = 0;
  let unchangedRating = 0;

  const eligibleRows = compare.rows.filter((row) => {
    if (requireRemoteMatch && !row.remoteFound) {
      noRemoteMatch += 1;
      return false;
    }

    if (onlyChanged && row.remoteMlttRating !== null && row.remoteMlttRating === row.localScore) {
      unchangedRating += 1;
      return false;
    }

    return true;
  });

  const limitedRows =
    maxUpdates > 0 ? eligibleRows.slice(0, Math.min(maxUpdates, eligibleRows.length)) : eligibleRows;

  const approvedPlayers = limitedRows.map((row) => ({
    spindexId: row.spindexId,
    mlttRating: row.localScore,
  }));

  const target = defaultSyncTarget(apiBaseUrl, privatePlayersPatchPath);

  if (!apiBaseUrl.trim()) {
    warnings.push("Push skipped: SPINDEX_API_BASE_URL is missing.");
  }
  if (!authToken.trim()) {
    warnings.push("Push skipped: SPINDEX_API_TOKEN is missing.");
  }

  if (dryRun || !apiBaseUrl.trim() || !authToken.trim()) {
    return {
      dryRun: true,
      generatedAt: new Date().toISOString(),
      target,
      localTotalCandidates: compare.localTotalCandidates,
      localRowsIncluded: compare.localRowsIncluded,
      localRowsWithSpindexId: compare.localRowsWithSpindexId,
      eligibleRows: eligibleRows.length,
      approvedPlayersPrepared: approvedPlayers.length,
      attemptedBatches: 0,
      successfulBatches: 0,
      failedBatches: 0,
      skippedRows: {
        noSpindexId: compare.localRowsWithoutSpindexId,
        noRemoteMatch,
        unchangedRating,
      },
      invalidSpindexIds: compare.invalidSpindexIds,
      ratingMismatches: compare.ratingMismatches,
      sampleApprovedPlayers: approvedPlayers.slice(0, 20),
      failures: [],
      warnings,
    };
  }

  const batches = chunkValues(approvedPlayers, batchSize);
  let successfulBatches = 0;
  let failedBatches = 0;
  const failures: Array<{ batch: number; status: number; message: string }> = [];

  for (let i = 0; i < batches.length; i += 1) {
    const payload = {
      approvedPlayers: batches[i] ?? [],
    };

    try {
      const response = await fetchWithTimeout(
        target,
        {
          method: "PATCH",
          headers: buildSpindexHeaders(authToken, true),
          body: JSON.stringify(payload),
        },
        timeoutMs,
      );

      if (response.ok) {
        successfulBatches += 1;
      } else {
        failedBatches += 1;
        failures.push({
          batch: i + 1,
          status: response.status,
          message: (await response.text()).slice(0, 500),
        });
      }
    } catch (error) {
      failedBatches += 1;
      failures.push({
        batch: i + 1,
        status: 0,
        message: error instanceof Error ? error.message : "network error",
      });
    }
  }

  return {
    dryRun: false,
    generatedAt: new Date().toISOString(),
    target,
    localTotalCandidates: compare.localTotalCandidates,
    localRowsIncluded: compare.localRowsIncluded,
    localRowsWithSpindexId: compare.localRowsWithSpindexId,
    eligibleRows: eligibleRows.length,
    approvedPlayersPrepared: approvedPlayers.length,
    attemptedBatches: batches.length,
    successfulBatches,
    failedBatches,
    skippedRows: {
      noSpindexId: compare.localRowsWithoutSpindexId,
      noRemoteMatch,
      unchangedRating,
    },
    invalidSpindexIds: compare.invalidSpindexIds,
    ratingMismatches: compare.ratingMismatches,
    sampleApprovedPlayers: approvedPlayers.slice(0, 20),
    failures,
    warnings,
  };
}

export type SpindexSyncOptions = SpindexUpdateOptions;
export type SpindexSyncReport = SpindexUpdateReport;

export async function syncResultsToSpindex(
  options: SpindexSyncOptions = {},
): Promise<SpindexSyncReport> {
  return await syncPlayersToSpindex(options);
}
