import { sleep } from "@/lib/fs";
import {
  fetchLiveResult,
  fetchMatchCard,
  fetchOfficialResult,
} from "./wtt-cms";
import type { WTTCMSLiveMatch, WTTCMSOfficialMatch } from "./wtt-cms";
import { ingestMatchCard } from "./wtt-ingestion";
import {
  defaultPipelineState,
  readPipelineState,
  writePipelineState,
} from "./wtt-state";
import type { WTTPipelineMode, WTTPipelineState } from "./wtt-state";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_INTERVAL_MS = 30 * 60 * 1000;
const ACTIVE_INTERVAL_MS = 5 * 60 * 1000;
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5_000;
const MATCH_CARD_DELAY_MS = 500;
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
  const entry = `[${new Date().toISOString()}] [WTT-PIPELINE] ${message}`;
  recentLogs.push(entry);
  if (recentLogs.length > LOG_RING_SIZE) {
    recentLogs.splice(0, recentLogs.length - LOG_RING_SIZE);
  }
  console.log(entry);
}

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

function isSingles(subEventType: string): boolean {
  const normalized = subEventType.trim().toUpperCase().replace(/\s+/g, "");

  if (!normalized.includes("SINGLES")) {
    return false;
  }

  if (
    normalized.includes("MEN") ||
    normalized.includes("WOMEN") ||
    normalized.includes("BOY") ||
    normalized.includes("GIRL")
  ) {
    return true;
  }

  if (/U\d+/.test(normalized)) {
    return true;
  }

  if (normalized.includes("MS") || normalized.includes("WS")) {
    return true;
  }

  return false;
}

function filterSinglesLive(matches: WTTCMSLiveMatch[]): WTTCMSLiveMatch[] {
  return matches.filter((m) => isSingles(m.subEventType));
}

function filterSinglesOfficial(
  matches: WTTCMSOfficialMatch[],
): WTTCMSOfficialMatch[] {
  return matches.filter((m) => isSingles(m.subEventType));
}

// ---------------------------------------------------------------------------
// Mode transitions
// ---------------------------------------------------------------------------

function intervalForMode(mode: WTTPipelineMode): number {
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
  let state: WTTPipelineState;

  try {
    state = await readPipelineState();
  } catch {
    log("Failed to read pipeline state, using defaults.");
    state = defaultPipelineState();
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Heartbeat: fetch live results
  log(`Tick [mode=${state.mode}]: fetching GetLiveResult...`);
  const allLive = await fetchLiveResult();
  const singlesLive = filterSinglesLive(allLive);
  state.lastLiveCheck = nowIso;

  const liveEventIds = [...new Set(singlesLive.map((m) => m.eventId))];

  log(
    `GetLiveResult: ${allLive.length} total, ${singlesLive.length} singles across ${liveEventIds.length} events.`,
  );

  // 2. Mode transitions
  if (singlesLive.length > 0) {
    if (state.mode !== "active") {
      log(`Transitioning to ACTIVE (live matches detected).`);
    }
    state.mode = "active";
    state.cooldownSince = null;

    for (const eventId of liveEventIds) {
      if (!state.trackedEvents.includes(eventId)) {
        state.trackedEvents.push(eventId);
        log(`Tracking new event: ${eventId}`);
      }
    }
  } else if (state.mode === "active") {
    state.mode = "cooldown";
    state.cooldownSince = nowIso;
    log(`No live singles matches. Transitioning to COOLDOWN.`);
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
      state.trackedEvents = [];
      state.cooldownSince = null;
    }
  }

  // 3. Check for new completions in tracked events
  if (
    state.trackedEvents.length > 0 &&
    (state.mode === "active" || state.mode === "cooldown")
  ) {
    let totalNew = 0;

    for (const eventId of state.trackedEvents) {
      const allOfficial = await fetchOfficialResult(eventId);
      const singlesOfficial = filterSinglesOfficial(allOfficial);

      const knownSet = new Set(state.knownCompletions[eventId] ?? []);
      const newCompletions = singlesOfficial.filter(
        (m) => !knownSet.has(m.documentCode),
      );

      if (newCompletions.length > 0) {
        log(
          `Event ${eventId}: ${newCompletions.length} new completions (${singlesOfficial.length} total official singles).`,
        );

        for (const completion of newCompletions) {
          const card = await fetchMatchCard(
            eventId,
            completion.documentCode,
          );

          if (card && card.resultStatus === "OFFICIAL") {
            const ingested = await ingestMatchCard(eventId, card);
            if (ingested) {
              state.stats.totalIngested += 1;
              state.stats.lastIngestedAt = new Date().toISOString();
              totalNew += 1;
              log(
                `Ingested: ${card.subEventDescription} [${card.overallScores}] (${card.competitiors.map((c) => c.competitiorName).join(" vs ")})`,
              );
            } else {
              log(
                `Skipped duplicate: ${completion.documentCode}`,
              );
            }
          } else if (card) {
            log(
              `Skipped non-official result: ${completion.documentCode} (status=${card.resultStatus})`,
            );
          } else {
            log(
              `Failed to fetch match card: ${eventId}/${completion.documentCode} (will retry next tick)`,
            );
            await sleep(MATCH_CARD_DELAY_MS);
            continue;
          }

          if (!state.knownCompletions[eventId]) {
            state.knownCompletions[eventId] = [];
          }
          state.knownCompletions[eventId].push(completion.documentCode);

          await sleep(MATCH_CARD_DELAY_MS);
        }
      }
    }

    if (totalNew > 0) {
      log(`Tick complete: ${totalNew} new matches ingested.`);
    }
  }

  // 4. Persist state
  try {
    await writePipelineState(state);
  } catch (error) {
    log(
      `Failed to write pipeline state: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  // 5. Schedule next tick
  scheduleNextTick(state.mode);
}

function scheduleNextTick(mode: WTTPipelineMode): void {
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

export interface WTTPipelineStatus {
  enabled: boolean;
  started: boolean;
  mode: WTTPipelineMode;
  trackedEvents: string[];
  knownCompletions: Record<string, number>;
  stats: {
    totalIngested: number;
    lastIngestedAt: string | null;
    startedAt: string | null;
  };
  recentLogs: string[];
}

export async function getWTTPipelineStatusFull(): Promise<WTTPipelineStatus> {
  const state = await readPipelineState();
  const completionCounts: Record<string, number> = {};
  for (const [eventId, codes] of Object.entries(state.knownCompletions)) {
    completionCounts[eventId] = codes.length;
  }

  return {
    enabled: process.env.WTT_PIPELINE_ENABLED === "true",
    started,
    mode: state.mode,
    trackedEvents: state.trackedEvents,
    knownCompletions: completionCounts,
    stats: state.stats,
    recentLogs: [...recentLogs],
  };
}

export function startWTTPipeline(): void {
  if (started) {
    log("Pipeline already started, ignoring duplicate call.");
    return;
  }

  started = true;

  const nowIso = new Date().toISOString();
  log("WTT pipeline starting.");

  void (async () => {
    try {
      const state = await readPipelineState();
      if (!state.stats.startedAt) {
        state.stats.startedAt = nowIso;
        await writePipelineState(state);
      }
    } catch {
      // State will be initialized on first tick
    }

    await sleep(INITIAL_DELAY_MS);
    void safeTick();
  })();
}
