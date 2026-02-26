import path from "node:path";
import { promises as fs } from "node:fs";
import { assertDataPath, ensureDir, fileExists, readJson, writeJson } from "@/lib/fs";
import {
  PLAYERS_MANUAL_FILE,
  PLAYERS_OUTPUT_DIR,
  PLAYERS_REGISTRY_FILE,
  TTBL_SEASONS_DIR,
  WTT_OUTPUT_DIR,
  getTTBLReadDir,
} from "@/lib/paths";
import {
  CanonicalPlayer,
  PlayerMergeCandidate,
  PlayerRegistryManualConfig,
  PlayerRegistrySnapshot,
  TTBLMetadata,
  WTTPlayer,
} from "@/lib/types";

interface SourcePlayerInput {
  source: "ttbl" | "wtt";
  sourceId: string;
  displayName: string;
  normalizedName: string;
  season?: string;
  country?: string | null;
}

interface MutableCanonical {
  canonicalKey: string;
  displayName: string;
  normalizedNames: Set<string>;
  members: Map<
    string,
    {
      source: "ttbl" | "wtt";
      sourceId: string;
      sourceKey: string;
      names: Set<string>;
      seasons: Set<string>;
    }
  >;
}

const DEFAULT_MANUAL_CONFIG: PlayerRegistryManualConfig = {
  aliases: {},
};

type RegistryLogFn = (message: string) => void;

function emit(log: RegistryLogFn | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] [PLAYERS] ${message}`);
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildTTBLName(row: {
  firstName?: string;
  lastName?: string;
  name?: string;
}): string {
  const direct = cleanName(row.name ?? "");
  if (direct) {
    return direct;
  }

  const joined = cleanName(`${row.firstName ?? ""} ${row.lastName ?? ""}`);
  return joined || "Unknown";
}

function normalizeCountry(value: string | null | undefined): string | null {
  const cleaned = cleanName(value ?? "");
  if (!cleaned) {
    return null;
  }

  return cleaned.toUpperCase();
}

function splitCountrySuffix(value: string): { name: string; country: string | null } {
  const match = value.match(/\(([^)]+)\)\s*$/);
  if (!match?.[1]) {
    return { name: cleanName(value), country: null };
  }

  const withoutCountry = value.slice(0, Math.max(0, match.index ?? value.length)).trim();
  return {
    name: cleanName(withoutCountry),
    country: normalizeCountry(match[1]),
  };
}

function isUppercaseSurnameToken(token: string): boolean {
  return /^[A-Z][A-Z-]{1,}$/.test(token);
}

interface NameParts {
  surname: string;
  given: string;
  givenInitial: string;
  country: string | null;
}

function parseNameParts(displayName: string, fallbackCountry?: string | null): NameParts | null {
  const trimmed = cleanName(displayName);
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return null;
  }

  const split = splitCountrySuffix(trimmed);
  const base = split.name;
  const normalizedBase = normalizeName(base);
  const normalizedTokens = normalizedBase.split(" ").filter(Boolean);
  if (normalizedTokens.length === 0) {
    return null;
  }

  const originalTokens = base.split(/\s+/).filter(Boolean);
  let surname = "";
  let given = "";

  if (
    originalTokens.length >= 2 &&
    originalTokens[0] &&
    isUppercaseSurnameToken(originalTokens[0])
  ) {
    surname = normalizedTokens[0] ?? "";
    given = normalizedTokens.slice(1).join(" ");
  } else {
    surname = normalizedTokens.at(-1) ?? "";
    given = normalizedTokens.slice(0, -1).join(" ");
  }

  if (!surname) {
    return null;
  }

  return {
    surname,
    given,
    givenInitial: given[0] ?? "",
    country: normalizeCountry(split.country ?? fallbackCountry ?? null),
  };
}

async function listSeasonDirectories(): Promise<string[]> {
  if (!(await fileExists(TTBL_SEASONS_DIR))) {
    return [];
  }

  assertDataPath(TTBL_SEASONS_DIR);
  const entries = await fs.readdir(TTBL_SEASONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
}

async function collectTTBLPlayers(): Promise<SourcePlayerInput[]> {
  const out: SourcePlayerInput[] = [];
  const dedupe = new Set<string>();

  const currentDir = getTTBLReadDir();
  const dirs = new Map<string, string>();

  const currentMeta = await readJson<TTBLMetadata>(path.join(currentDir, "metadata.json"), null);
  dirs.set(currentDir, currentMeta?.season ?? "current");

  const seasonNames = await listSeasonDirectories();
  for (const seasonName of seasonNames) {
    dirs.set(path.join(TTBL_SEASONS_DIR, seasonName), seasonName);
  }

  for (const [dirPath, season] of dirs.entries()) {
    const players =
      (await readJson<
        Array<{ id?: string; firstName?: string; lastName?: string; name?: string }>
      >(path.join(dirPath, "players", "unique_players.json"), [])) ?? [];

    for (const row of players) {
      const displayName = buildTTBLName(row);
      const normalizedName = normalizeName(displayName);
      const hasId = Boolean(row.id?.trim());
      if (!hasId && normalizedName === "unknown") {
        continue;
      }

      const sourceId = row.id?.trim() || `name:${normalizedName}`;
      const dedupeKey = `ttbl:${sourceId}:${season}`;

      if (!normalizedName || dedupe.has(dedupeKey)) {
        continue;
      }
      dedupe.add(dedupeKey);

      out.push({
        source: "ttbl",
        sourceId,
        displayName,
        normalizedName,
        season,
        country: null,
      });
    }
  }

  return out;
}

async function collectWTTPlayers(): Promise<SourcePlayerInput[]> {
  const players =
    (await readJson<Record<string, WTTPlayer>>(
      path.join(WTT_OUTPUT_DIR, "players.json"),
      {},
    )) ?? {};

  const out: SourcePlayerInput[] = [];

  for (const [ittfId, row] of Object.entries(players)) {
    const displayName =
      cleanName(row.full_name ?? "") ||
      cleanName(`${row.first_name ?? ""} ${row.last_name ?? ""}`) ||
      ittfId;
    const normalizedName = normalizeName(displayName);

    if (!normalizedName) {
      continue;
    }

    out.push({
      source: "wtt",
      sourceId: ittfId,
      displayName,
      normalizedName,
      country: normalizeCountry(row.nationality),
    });
  }

  return out;
}

async function loadManualConfig(): Promise<PlayerRegistryManualConfig> {
  if (!(await fileExists(PLAYERS_MANUAL_FILE))) {
    await ensureDir(PLAYERS_OUTPUT_DIR);
    await writeJson(PLAYERS_MANUAL_FILE, DEFAULT_MANUAL_CONFIG);
    return DEFAULT_MANUAL_CONFIG;
  }

  return (
    (await readJson<PlayerRegistryManualConfig>(
      PLAYERS_MANUAL_FILE,
      DEFAULT_MANUAL_CONFIG,
    )) ?? DEFAULT_MANUAL_CONFIG
  );
}

function givenNamesSimilar(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  if (left.startsWith(right) || right.startsWith(left)) {
    return true;
  }

  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[rows - 1][cols - 1] <= 1;
}

function sameSingleSource(left: CanonicalPlayer, right: CanonicalPlayer): boolean {
  const leftSources = new Set(left.members.map((member) => member.source));
  const rightSources = new Set(right.members.map((member) => member.source));

  if (leftSources.size !== 1 || rightSources.size !== 1) {
    return false;
  }

  const leftSource = [...leftSources][0];
  const rightSource = [...rightSources][0];
  return leftSource === rightSource;
}

function buildMergeCandidates(players: CanonicalPlayer[]): PlayerMergeCandidate[] {
  const buckets = new Map<
    string,
    Array<{
      player: CanonicalPlayer;
      parts: NameParts;
    }>
  >();

  for (const player of players) {
    const parsed = parseNameParts(player.displayName);
    if (!parsed || !parsed.givenInitial) {
      continue;
    }

    const signature = `${parsed.surname}|${parsed.country ?? "UNK"}|${parsed.givenInitial}`;
    const bucket = buckets.get(signature) ?? [];
    bucket.push({ player, parts: parsed });
    buckets.set(signature, bucket);
  }

  const candidates: PlayerMergeCandidate[] = [];
  const seen = new Set<string>();

  for (const rows of buckets.values()) {
    if (rows.length < 2) {
      continue;
    }

    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const left = rows[i];
        const right = rows[j];

        if (left.player.canonicalKey === right.player.canonicalKey) {
          continue;
        }

        if (sameSingleSource(left.player, right.player)) {
          continue;
        }

        if (
          left.parts.country &&
          right.parts.country &&
          left.parts.country !== right.parts.country
        ) {
          continue;
        }

        if (!givenNamesSimilar(left.parts.given, right.parts.given)) {
          continue;
        }

        const pairKey = [left.player.canonicalKey, right.player.canonicalKey].sort().join("::");
        if (seen.has(pairKey)) {
          continue;
        }
        seen.add(pairKey);

        const reason =
          left.parts.given === right.parts.given
            ? "same surname + same given name (cross-source)"
            : "same surname + similar given name (cross-source)";

        candidates.push({
          leftCanonicalKey: left.player.canonicalKey,
          rightCanonicalKey: right.player.canonicalKey,
          leftName: left.player.displayName,
          rightName: right.player.displayName,
          reason,
        });
      }
    }
  }

  return candidates
    .sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) ||
        a.leftName.localeCompare(b.leftName) ||
        a.rightName.localeCompare(b.rightName),
    )
    .slice(0, 150);
}

function toCanonicalArray(input: Map<string, MutableCanonical>): CanonicalPlayer[] {
  const out: CanonicalPlayer[] = [];

  for (const row of input.values()) {
    const members = [...row.members.values()].map((member) => ({
      source: member.source,
      sourceId: member.sourceId,
      sourceKey: member.sourceKey,
      names: [...member.names].sort((a, b) => a.localeCompare(b)),
      seasons: [...member.seasons].sort((a, b) => a.localeCompare(b)),
    }));

    out.push({
      canonicalKey: row.canonicalKey,
      displayName: row.displayName,
      normalizedNames: [...row.normalizedNames].sort((a, b) => a.localeCompare(b)),
      sourceCount: new Set(members.map((member) => member.source)).size,
      memberCount: members.length,
      members,
    });
  }

  return out.sort(
    (a, b) => b.memberCount - a.memberCount || a.displayName.localeCompare(b.displayName),
  );
}

export async function rebuildPlayerRegistry(log?: RegistryLogFn): Promise<PlayerRegistrySnapshot> {
  emit(log, "Starting player registry rebuild.");
  await ensureDir(PLAYERS_OUTPUT_DIR);

  const manual = await loadManualConfig();
  emit(log, `Loaded manual aliases: ${Object.keys(manual.aliases ?? {}).length}`);
  const [ttblPlayers, wttPlayers] = await Promise.all([
    collectTTBLPlayers(),
    collectWTTPlayers(),
  ]);
  emit(log, `Collected source players: TTBL=${ttblPlayers.length}, WTT=${wttPlayers.length}`);

  const sourcePlayers = [...ttblPlayers, ...wttPlayers];
  const canonicalMap = new Map<string, MutableCanonical>();
  const sourceIndex: Record<string, string> = {};

  for (const player of sourcePlayers) {
    const sourceKey = `${player.source}:${player.sourceId}`;
    const aliasKeyByName = `name:${player.normalizedName}`;

    const manualCanonicalKey =
      manual.aliases[sourceKey] ?? manual.aliases[aliasKeyByName] ?? null;
    const canonicalKey = manualCanonicalKey ?? sourceKey;

    sourceIndex[sourceKey] = canonicalKey;

    const canonical =
      canonicalMap.get(canonicalKey) ??
      ({
        canonicalKey,
        displayName: player.displayName,
        normalizedNames: new Set<string>(),
        members: new Map(),
      } as MutableCanonical);

    canonical.normalizedNames.add(player.normalizedName);

    const existingMember = canonical.members.get(sourceKey) ?? {
      source: player.source,
      sourceId: player.sourceId,
      sourceKey,
      names: new Set<string>(),
      seasons: new Set<string>(),
    };

    existingMember.names.add(player.displayName);
    if (player.season) {
      existingMember.seasons.add(player.season);
    }

    canonical.members.set(sourceKey, existingMember);

    if (canonical.displayName === "Unknown" && player.displayName !== "Unknown") {
      canonical.displayName = player.displayName;
    }

    canonicalMap.set(canonicalKey, canonical);
  }

  const canonicalPlayers = toCanonicalArray(canonicalMap);
  const mergeCandidates = buildMergeCandidates(canonicalPlayers);
  emit(
    log,
    `Built canonical map: canonical=${canonicalPlayers.length}, candidates=${mergeCandidates.length}`,
  );

  const snapshot: PlayerRegistrySnapshot = {
    generatedAt: new Date().toISOString(),
    totals: {
      sourcePlayers: sourcePlayers.length,
      ttblSourcePlayers: ttblPlayers.length,
      wttSourcePlayers: wttPlayers.length,
      canonicalPlayers: canonicalPlayers.length,
      mergedPlayers: Math.max(sourcePlayers.length - canonicalPlayers.length, 0),
      candidates: mergeCandidates.length,
    },
    players: canonicalPlayers,
    mergeCandidates,
    sourceIndex,
  };

  await writeJson(PLAYERS_REGISTRY_FILE, snapshot);
  emit(log, `Registry written to ${PLAYERS_REGISTRY_FILE}`);

  return snapshot;
}

export async function getPlayerRegistrySnapshot(): Promise<PlayerRegistrySnapshot | null> {
  return await readJson<PlayerRegistrySnapshot>(PLAYERS_REGISTRY_FILE, null);
}

export async function getManualMergeFilePath(): Promise<string> {
  await loadManualConfig();
  return PLAYERS_MANUAL_FILE;
}

export async function ensurePlayerRegistry(): Promise<PlayerRegistrySnapshot | null> {
  const existing = await getPlayerRegistrySnapshot();
  if (existing) {
    return existing;
  }

  return await rebuildPlayerRegistry();
}
