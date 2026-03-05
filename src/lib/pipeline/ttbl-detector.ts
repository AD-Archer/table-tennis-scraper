import { sleep } from "@/lib/fs";
import { fetchDataRoute } from "./ttbl-resolver";
import { getCachedBuildId } from "./ttbl-resolver";
import { ingestMatch } from "./ttbl-ingestion";
import {
  defaultTTBLPipelineState,
  readTTBLPipelineState,
  writeTTBLPipelineState,
} from "./ttbl-state";
import type { TTBLPipelineMode, TTBLPipelineState } from "./ttbl-state";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const ACTIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const COOLDOWN_DURATION_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 8_000;
const MATCH_FETCH_DELAY_MS = 500;
const LOG_RING_SIZE = 200;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let started = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
const recentLogs: string[] = [];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(message: string): void {
  const entry = `[${new Date().toISOString()}] [TTBL-PIPELINE] ${message}`;
  recentLogs.push(entry);
  if (recentLogs.length > LOG_RING_SIZE) {
    recentLogs.splice(0, recentLogs.length - LOG_RING_SIZE);
  }
  console.log(entry);
}

// ---------------------------------------------------------------------------
// API response types for gameschedule listing
// ---------------------------------------------------------------------------

interface GamescheduleMatch {
  id: string;
  matchState: string;
  timeStamp: number;
  homeGames: number;
  awayGames: number;
  updateCount: number | null;
  season?: {
    startYear: number;
    endYear: number;
    isCurrentSeason?: boolean;
  };
  gameday?: {
    index: number;
    name: string;
  };
}

interface GamescheduleResponse {
  matches: GamescheduleMatch[];
  seasons: Array<{
    startYear: number;
    endYear: number;
    isCurrentSeason: boolean;
    bundesliga?: { gamedayCount: number };
  }>;
  selectedSeason: {
    startYear: number;
    endYear: number;
    isCurrentSeason: boolean;
    bundesliga?: { gamedayCount: number };
  };
  selectedGameday: {
    index: number;
  };
  gamedays: Array<{
    index: number;
    name: string;
  }>;
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

function seasonString(startYear: number, endYear: number): string {
  return `${startYear}-${endYear}`;
}

/**
 * Discover the current season and find gamedays that may have recently
 * finished matches. Returns gameday indices to scan.
 */
async function discoverActiveGamedays(
  state: TTBLPipelineState,
): Promise<{
  season: string;
  gamedayCount: number;
  gamedaysToScan: number[];
} | null> {
  // Fetch any gameday to get season/gameday metadata.
  // Using gameday 1 as a stable entry point.
  const data = await fetchDataRoute<GamescheduleResponse>(
    "bundesliga/gameschedule",
  );

  if (!data?.selectedSeason) {
    // Fallback: try explicit current season route
    const fallback = await fetchDataRoute<GamescheduleResponse>(
      "bundesliga/table",
    );
    if (!fallback?.selectedSeason) return null;

    const s = fallback.selectedSeason;
    const season = seasonString(s.startYear, s.endYear);
    const gamedayCount = s.bundesliga?.gamedayCount ?? 22;

    return {
      season,
      gamedayCount,
      gamedaysToScan: state.trackedGamedays.length > 0
        ? state.trackedGamedays
        : findRecentGamedays(gamedayCount),
    };
  }

  const s = data.selectedSeason;
  const season = seasonString(s.startYear, s.endYear);
  const gamedayCount = s.bundesliga?.gamedayCount ?? 22;
  const allGamedays = (data.gamedays ?? []).map((gd) => gd.index);

  // Determine which gamedays need scanning:
  // - Any gamedays the detector is already tracking
  // - The "current" gameday from the site
  // - Adjacent gamedays (matches may span multiple gamedays in a week)
  const currentGd = data.selectedGameday?.index;
  const candidateSet = new Set([
    ...state.trackedGamedays,
    ...(currentGd ? [currentGd, Math.max(1, currentGd - 1)] : []),
  ]);

  // Filter to valid gamedays
  const validSet = new Set(allGamedays);
  const gamedaysToScan = [...candidateSet]
    .filter((gd) => validSet.size === 0 || validSet.has(gd))
    .sort((a, b) => a - b);

  return {
    season,
    gamedayCount,
    gamedaysToScan: gamedaysToScan.length > 0
      ? gamedaysToScan
      : findRecentGamedays(gamedayCount),
  };
}

function findRecentGamedays(gamedayCount: number): number[] {
  // Scan the last few gamedays as a fallback
  const end = Math.min(gamedayCount, 22);
  return [Math.max(1, end - 1), end];
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------

function intervalForMode(mode: TTBLPipelineMode): number {
  switch (mode) {
    case "idle":
      return IDLE_INTERVAL_MS;
    case "active":
    case "cooldown":
      return ACTIVE_INTERVAL_MS;
  }
}

// ---------------------------------------------------------------------------
// Core tick
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  let state: TTBLPipelineState;

  try {
    state = await readTTBLPipelineState();
  } catch {
    log("Failed to read pipeline state, using defaults.");
    state = defaultTTBLPipelineState();
  }

  const now = new Date();
  const nowIso = now.toISOString();
  state.lastCheck = nowIso;

  log(`Tick [mode=${state.mode}]: discovering gamedays (buildId=${getCachedBuildId() ?? "none"})...`);

  // 1. Discover season and gamedays to scan
  const discovery = await discoverActiveGamedays(state);
  if (!discovery) {
    log("Discovery failed (site unreachable or buildId stale). Will retry next tick.");
    await persistAndSchedule(state);
    return;
  }

  state.currentSeason = discovery.season;
  log(`Season: ${discovery.season}, scanning gamedays: [${discovery.gamedaysToScan.join(", ")}]`);

  // 2. Scan each gameday for finished matches
  let newCompletions = 0;
  let activeMatchesFound = false;
  const gamedaysWithActivity: number[] = [];

  for (const gd of discovery.gamedaysToScan) {
    const route = `bundesliga/gameschedule/${discovery.season}/${gd}/all`;
    const listing = await fetchDataRoute<GamescheduleResponse>(route);

    if (!listing?.matches) {
      log(`Gameday ${gd}: no data`);
      continue;
    }

    const matches = listing.matches;
    const finished = matches.filter((m) => m.matchState === "Finished");
    const active = matches.filter((m) => m.matchState === "Active");
    const inactive = matches.filter((m) => m.matchState === "Inactive");

    if (active.length > 0) {
      activeMatchesFound = true;
      gamedaysWithActivity.push(gd);
    }

    // Find newly finished matches not yet ingested
    const knownSet = new Set(state.knownCompletions);
    const newlyFinished = finished.filter((m) => !knownSet.has(m.id));

    if (newlyFinished.length > 0) {
      gamedaysWithActivity.push(gd);
      log(
        `Gameday ${gd}: ${newlyFinished.length} new completions ` +
        `(${finished.length} finished, ${active.length} active, ${inactive.length} inactive)`
      );

      for (const match of newlyFinished) {
        const result = await ingestMatch(
          match.id,
          discovery.season,
          String(gd),
        );

        if (result.ingested) {
          state.knownCompletions.push(match.id);
          state.stats.totalIngested += 1;
          state.stats.lastIngestedAt = new Date().toISOString();
          newCompletions += 1;
          log(
            `Ingested: ${match.id} (${match.homeGames}-${match.awayGames}, ${result.gamesIngested} games)`
          );
        } else {
          log(`Skipped ${match.id}: ${result.reason}`);
        }

        await sleep(MATCH_FETCH_DELAY_MS);
      }
    }
  }

  // 3. Mode transitions
  if (activeMatchesFound) {
    if (state.mode !== "active") {
      log("Transitioning to ACTIVE (live matches detected).");
    }
    state.mode = "active";
    state.cooldownSince = null;
    state.trackedGamedays = [...new Set(gamedaysWithActivity)];
  } else if (state.mode === "active") {
    state.mode = "cooldown";
    state.cooldownSince = nowIso;
    log("No active matches. Transitioning to COOLDOWN.");
  } else if (state.mode === "cooldown") {
    const cooldownStart = state.cooldownSince
      ? new Date(state.cooldownSince).getTime()
      : 0;
    const elapsed = now.getTime() - cooldownStart;

    if (elapsed >= COOLDOWN_DURATION_MS) {
      log(
        `Cooldown expired (${Math.floor(elapsed / 60_000)}min). Transitioning to IDLE.`,
      );
      state.mode = "idle";
      state.trackedGamedays = [];
      state.cooldownSince = null;
    }
  }

  if (newCompletions > 0) {
    log(`Tick complete: ${newCompletions} new matches ingested.`);
  }

  await persistAndSchedule(state);
}

async function persistAndSchedule(state: TTBLPipelineState): Promise<void> {
  try {
    await writeTTBLPipelineState(state);
  } catch (error) {
    log(
      `Failed to write pipeline state: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  scheduleNextTick(state.mode);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function scheduleNextTick(mode: TTBLPipelineMode): void {
  if (tickTimer !== null) {
    clearTimeout(tickTimer);
  }

  const interval = intervalForMode(mode);
  tickTimer = setTimeout(() => {
    void safeTick();
  }, interval);

  log(`Next tick in ${Math.floor(interval / 1000)}s [mode=${mode}].`);
}

async function safeTick(): Promise<void> {
  try {
    await tick();
  } catch (error) {
    log(
      `Tick error: ${error instanceof Error ? error.message : "unknown"}`,
    );
    scheduleNextTick("idle");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TTBLPipelineStatus {
  enabled: boolean;
  started: boolean;
  mode: TTBLPipelineMode;
  currentSeason: string | null;
  trackedGamedays: number[];
  knownCompletions: number;
  stats: {
    totalIngested: number;
    lastIngestedAt: string | null;
    startedAt: string | null;
  };
  recentLogs: string[];
}

export async function getTTBLPipelineStatus(): Promise<TTBLPipelineStatus> {
  const state = await readTTBLPipelineState();

  return {
    enabled: process.env.TTBL_PIPELINE_ENABLED === "true",
    started,
    mode: state.mode,
    currentSeason: state.currentSeason,
    trackedGamedays: state.trackedGamedays,
    knownCompletions: state.knownCompletions.length,
    stats: state.stats,
    recentLogs: [...recentLogs],
  };
}

export function startTTBLPipeline(): void {
  if (started) {
    log("Pipeline already started, ignoring duplicate call.");
    return;
  }

  started = true;

  const nowIso = new Date().toISOString();
  log("TTBL pipeline starting.");

  void (async () => {
    try {
      const state = await readTTBLPipelineState();
      if (!state.stats.startedAt) {
        state.stats.startedAt = nowIso;
        await writeTTBLPipelineState(state);
      }
    } catch {
      // State will be initialized on first tick
    }

    await sleep(INITIAL_DELAY_MS);
    void safeTick();
  })();
}
