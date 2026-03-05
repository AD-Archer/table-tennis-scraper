import { ensureDir, readJson, writeJson } from "@/lib/fs";
import { PIPELINE_DIR, TTBL_PIPELINE_STATE_FILE } from "@/lib/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TTBLPipelineMode = "idle" | "active" | "cooldown";

export interface TTBLPipelineState {
  mode: TTBLPipelineMode;
  /** Current season being monitored (e.g. "2025-2026") */
  currentSeason: string | null;
  /** Gamedays with active/upcoming matches */
  trackedGamedays: number[];
  /** Match IDs already ingested — prevents duplicate DB writes */
  knownCompletions: string[];
  lastCheck: string | null;
  cooldownSince: string | null;
  stats: {
    totalIngested: number;
    lastIngestedAt: string | null;
    startedAt: string | null;
  };
}

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

export function defaultTTBLPipelineState(): TTBLPipelineState {
  return {
    mode: "idle",
    currentSeason: null,
    trackedGamedays: [],
    knownCompletions: [],
    lastCheck: null,
    cooldownSince: null,
    stats: {
      totalIngested: 0,
      lastIngestedAt: null,
      startedAt: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function readTTBLPipelineState(): Promise<TTBLPipelineState> {
  const stored = await readJson<TTBLPipelineState>(
    TTBL_PIPELINE_STATE_FILE,
    null,
  );

  const validModes: TTBLPipelineMode[] = ["idle", "active", "cooldown"];
  if (
    !stored ||
    typeof stored.mode !== "string" ||
    !validModes.includes(stored.mode as TTBLPipelineMode)
  ) {
    return defaultTTBLPipelineState();
  }

  return {
    mode: stored.mode,
    currentSeason: stored.currentSeason ?? null,
    trackedGamedays: Array.isArray(stored.trackedGamedays)
      ? stored.trackedGamedays
      : [],
    knownCompletions: Array.isArray(stored.knownCompletions)
      ? stored.knownCompletions
      : [],
    lastCheck: stored.lastCheck ?? null,
    cooldownSince: stored.cooldownSince ?? null,
    stats: {
      totalIngested: stored.stats?.totalIngested ?? 0,
      lastIngestedAt: stored.stats?.lastIngestedAt ?? null,
      startedAt: stored.stats?.startedAt ?? null,
    },
  };
}

export async function writeTTBLPipelineState(
  state: TTBLPipelineState,
): Promise<void> {
  await ensureDir(PIPELINE_DIR);
  await writeJson(TTBL_PIPELINE_STATE_FILE, state);
}
