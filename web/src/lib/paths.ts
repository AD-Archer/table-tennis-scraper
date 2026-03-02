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
export const PLAYERS_MANUAL_FILE = path.join(PLAYERS_OUTPUT_DIR, "manual_merges.json");

export const PIPELINE_DIR = path.join(DATA_ROOT, "pipeline");
export const WTT_PIPELINE_STATE_FILE = path.join(PIPELINE_DIR, "wtt_state.json");

interface TTBLLegacyIndexLike {
  seasons?: string[];
  results?: Array<{ season?: string }>;
}

interface TTBLMetadataLike {
  season?: string;
}

function readJsonFile<T>(targetPath: string): T | null {
  if (!fs.existsSync(targetPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseSeasonStart(value: string | null | undefined): number {
  const match = value?.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
  if (!match?.[1]) {
    return 0;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLatestLegacySeasonDir(): string | null {
  const index = readJsonFile<TTBLLegacyIndexLike>(TTBL_LEGACY_INDEX_FILE);
  if (!index) {
    return null;
  }

  const rawSeasons = new Set<string>();
  for (const season of index.seasons ?? []) {
    if (typeof season === "string" && season.trim()) {
      rawSeasons.add(season.trim());
    }
  }
  for (const row of index.results ?? []) {
    if (typeof row.season === "string" && row.season.trim()) {
      rawSeasons.add(row.season.trim());
    }
  }

  const seasons = [...rawSeasons].sort((a, b) => parseSeasonStart(b) - parseSeasonStart(a));
  for (const season of seasons) {
    const dir = path.join(TTBL_SEASONS_DIR, season);
    if (fs.existsSync(path.join(dir, "metadata.json"))) {
      return dir;
    }
  }

  return null;
}

export function getTTBLReadDir(): string {
  const latestLegacyDir = getLatestLegacySeasonDir();
  const currentMetaPath = path.join(TTBL_OUTPUT_DIR, "metadata.json");
  const currentMeta = readJsonFile<TTBLMetadataLike>(currentMetaPath);

  if (!latestLegacyDir) {
    return TTBL_OUTPUT_DIR;
  }

  const legacyMeta = readJsonFile<TTBLMetadataLike>(path.join(latestLegacyDir, "metadata.json"));
  const currentStart = parseSeasonStart(currentMeta?.season);
  const legacyStart = parseSeasonStart(legacyMeta?.season ?? path.basename(latestLegacyDir));

  if (!currentMeta) {
    return latestLegacyDir;
  }

  return legacyStart > currentStart ? latestLegacyDir : TTBL_OUTPUT_DIR;
}

export function toProjectRelative(absolutePath: string): string {
  return path.relative(APP_ROOT, absolutePath) || ".";
}
