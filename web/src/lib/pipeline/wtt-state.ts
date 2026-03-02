import { ensureDir, readJson, writeJson } from "@/lib/fs";
import { PIPELINE_DIR, WTT_PIPELINE_STATE_FILE } from "@/lib/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WTTPipelineMode = "idle" | "active" | "cooldown";

export interface WTTPipelineState {
  mode: WTTPipelineMode;
  trackedEvents: string[];
  knownCompletions: Record<string, string[]>;
  lastLiveCheck: string | null;
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

export function defaultPipelineState(): WTTPipelineState {
  return {
    mode: "idle",
    trackedEvents: [],
    knownCompletions: {},
    lastLiveCheck: null,
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

export async function readPipelineState(): Promise<WTTPipelineState> {
  const stored = await readJson<WTTPipelineState>(
    WTT_PIPELINE_STATE_FILE,
    null,
  );

  const validModes: WTTPipelineMode[] = ["idle", "active", "cooldown"];
  if (
    !stored ||
    typeof stored.mode !== "string" ||
    !validModes.includes(stored.mode as WTTPipelineMode)
  ) {
    return defaultPipelineState();
  }

  return {
    mode: stored.mode,
    trackedEvents: Array.isArray(stored.trackedEvents)
      ? stored.trackedEvents
      : [],
    knownCompletions:
      stored.knownCompletions && typeof stored.knownCompletions === "object"
        ? stored.knownCompletions
        : {},
    lastLiveCheck: stored.lastLiveCheck ?? null,
    cooldownSince: stored.cooldownSince ?? null,
    stats: {
      totalIngested: stored.stats?.totalIngested ?? 0,
      lastIngestedAt: stored.stats?.lastIngestedAt ?? null,
      startedAt: stored.stats?.startedAt ?? null,
    },
  };
}

export async function writePipelineState(
  state: WTTPipelineState,
): Promise<void> {
  await ensureDir(PIPELINE_DIR);
  await writeJson(WTT_PIPELINE_STATE_FILE, state);
}
