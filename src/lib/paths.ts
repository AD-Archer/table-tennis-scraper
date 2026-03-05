import fs from "node:fs";
import path from "node:path";

function isWebAppRoot(candidate: string): boolean {
  const packagePath = path.join(candidate, "package.json");
  if (!fs.existsSync(packagePath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name === "tabletennis-scraper";
  } catch {
    return false;
  }
}

function resolveAppRoot(): string {
  const cwd = process.cwd();
  if (isWebAppRoot(cwd)) {
    return cwd;
  }

  const nestedWeb = path.join(cwd, "web");
  if (isWebAppRoot(nestedWeb)) {
    return nestedWeb;
  }

  return cwd;
}

export const APP_ROOT = resolveAppRoot();
export const DATA_ROOT = path.join(APP_ROOT, "data");
export const TTBL_DATA_ROOT = path.join(DATA_ROOT, "ttbl");

export const TTBL_OUTPUT_DIR = path.join(TTBL_DATA_ROOT, "current");
export const TTBL_SEASONS_DIR = path.join(TTBL_DATA_ROOT, "seasons");
export const TTBL_LEGACY_INDEX_FILE = path.join(TTBL_DATA_ROOT, "legacy_index.json");
export const TTBL_PLAYER_PROFILES_FILE = path.join(TTBL_DATA_ROOT, "player_profiles.json");
export const WTT_OUTPUT_DIR = path.join(DATA_ROOT, "wtt");

export const PLAYERS_OUTPUT_DIR = path.join(DATA_ROOT, "players");
export const PLAYERS_REGISTRY_FILE = path.join(PLAYERS_OUTPUT_DIR, "player_registry.json");
export const PLAYERS_MANUAL_FILE = path.join(PLAYERS_OUTPUT_DIR, "manual_merges");

export const PIPELINE_DIR = path.join(DATA_ROOT, "pipeline");
export const WTT_PIPELINE_STATE_FILE = path.join(PIPELINE_DIR, "wtt_state.json");
export const TTBL_PIPELINE_STATE_FILE = path.join(PIPELINE_DIR, "ttbl_state.json");
export const SYNC_ACTIVITY_LOG_FILE = path.join(PIPELINE_DIR, "sync_activity_log.json");

export function getTTBLReadDir(): string {
  return TTBL_OUTPUT_DIR;
}

export function toProjectRelative(absolutePath: string): string {
  return path.relative(APP_ROOT, absolutePath) || ".";
}
