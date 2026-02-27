import path from "node:path";
import { promises as fs } from "node:fs";
import { assertDataPath, ensureDir, fileExists, readJson, writeJson } from "@/lib/fs";
import {
  PLAYERS_MANUAL_FILE,
  PLAYERS_OUTPUT_DIR,
  PLAYERS_REGISTRY_FILE,
  TTBL_LEGACY_INDEX_FILE,
  TTBL_OUTPUT_DIR,
  TTBL_SEASONS_DIR,
  WTT_OUTPUT_DIR,
  getTTBLReadDir,
} from "@/lib/paths";
import { getTTBLPlayerProfile, readTTBLPlayerProfiles } from "@/lib/ttbl/player-profiles";
import {
  CanonicalPlayer,
  PlayerGender,
  PlayerMergeCandidate,
  PlayerRegistryManualConfig,
  PlayerRegistrySnapshot,
  TTBLMetadata,
  TTBLPlayerProfile,
  WTTMatch,
  WTTPlayer,
} from "@/lib/types";
import { inferWTTEventGender, isWTTGenderedSinglesEvent } from "@/lib/wtt/events";

interface SourcePlayerInput {
  source: "ttbl" | "wtt";
  sourceId: string;
  displayName: string;
  normalizedName: string;
  canonicalHint?: string;
  season?: string;
  country?: string | null;
  dobIso?: string | null;
  gender?: PlayerGender | null;
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

const COUNTRY_CODE_ALIASES: Record<string, string> = {
  GER: "DEU",
  DEU: "DEU",
  POR: "PRT",
  PRT: "PRT",
  DEN: "DNK",
  DNK: "DNK",
  ENG: "GBR",
  GBR: "GBR",
  CRO: "HRV",
  HRV: "HRV",
  TPE: "TWN",
  TWN: "TWN",
  NED: "NLD",
  NLD: "NLD",
  SUI: "CHE",
  CHE: "CHE",
  SLO: "SVN",
  SVN: "SVN",
  GRE: "GRC",
  GRC: "GRC",
  CZE: "CZE",
  KOR: "KOR",
  CHN: "CHN",
  JPN: "JPN",
  USA: "USA",
  AUT: "AUT",
  BEL: "BEL",
  POL: "POL",
  FRA: "FRA",
  ESP: "ESP",
  ITA: "ITA",
};

const COUNTRY_NAME_ALIASES: Record<string, string> = {
  GERMANY: "DEU",
  PORTUGAL: "PRT",
  DENMARK: "DNK",
  ENGLAND: "GBR",
  "GREAT BRITAIN": "GBR",
  CROATIA: "HRV",
  TAIWAN: "TWN",
  "CHINESE TAIPEI": "TWN",
  NETHERLANDS: "NLD",
  SWITZERLAND: "CHE",
  SLOVENIA: "SVN",
  GREECE: "GRC",
  "KOREA REPUBLIC": "KOR",
  "REPUBLIC OF KOREA": "KOR",
};

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

function buildTTBLCanonicalHint(
  normalizedName: string,
  profile: TTBLPlayerProfile | null,
): string | undefined {
  const stablePlayerId = profile?.stablePlayerId?.trim() ?? "";
  if (stablePlayerId) {
    return `ttbl-stable:${stablePlayerId}`;
  }

  if (normalizedName && normalizedName !== "unknown") {
    const birthdayUnix = profile?.birthdayUnix;
    if (typeof birthdayUnix === "number" && Number.isFinite(birthdayUnix) && birthdayUnix > 0) {
      return `ttbl-profile:${normalizedName}:dob:${Math.trunc(birthdayUnix)}`;
    }
  }

  return undefined;
}

function uniqueStableHintByName(rows: SourcePlayerInput[]): Map<string, string> {
  const stableHintsByName = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.canonicalHint?.startsWith("ttbl-stable:")) {
      continue;
    }

    const set = stableHintsByName.get(row.normalizedName) ?? new Set<string>();
    set.add(row.canonicalHint);
    stableHintsByName.set(row.normalizedName, set);
  }

  const out = new Map<string, string>();
  for (const [name, hints] of stableHintsByName.entries()) {
    if (hints.size === 1) {
      const [hint] = [...hints];
      if (hint) {
        out.set(name, hint);
      }
    }
  }

  return out;
}

function normalizeCountry(value: string | null | undefined): string | null {
  const cleaned = cleanName(value ?? "");
  if (!cleaned) {
    return null;
  }
  const upper = cleaned.toUpperCase();
  const compact = upper.replace(/[^A-Z]/g, "");

  return COUNTRY_CODE_ALIASES[compact] ?? COUNTRY_NAME_ALIASES[upper] ?? upper;
}

function normalizeSourceGender(value: string | null | undefined): PlayerGender | null {
  const normalized = cleanName(value ?? "").toUpperCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "M" || normalized === "MALE") {
    return "M";
  }
  if (normalized === "W" || normalized === "F" || normalized === "FEMALE") {
    return "W";
  }
  if (normalized === "MIXED" || normalized === "X") {
    return "mixed";
  }
  if (normalized === "UNKNOWN") {
    return "unknown";
  }

  return null;
}

function normalizeDateToIso(value: string | null | undefined): string | null {
  const raw = cleanName(value ?? "");
  if (!raw) {
    return null;
  }

  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (direct) {
    return `${direct[1]}-${direct[2]}-${direct[3]}`;
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

function unixSecondsToIsoDate(value: number | null | undefined): string | null {
  if (!Number.isFinite(value ?? null) || (value ?? 0) <= 0) {
    return null;
  }

  const millis = Math.trunc((value ?? 0) * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
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

function buildNameKey(displayName: string, fallbackCountry?: string | null): string | null {
  const parts = parseNameParts(displayName, fallbackCountry);
  if (!parts) {
    return null;
  }

  return `${parts.surname}|${parts.given}`;
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

async function safeMtime(filePath: string): Promise<number> {
  if (!(await fileExists(filePath))) {
    return 0;
  }

  assertDataPath(filePath);

  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

async function latestSourceMtime(): Promise<number> {
  const seasonNames = await listSeasonDirectories();
  const seasonMetadataFiles = seasonNames.map((season) =>
    path.join(TTBL_SEASONS_DIR, season, "metadata.json"),
  );

  const files = [
    TTBL_LEGACY_INDEX_FILE,
    path.join(TTBL_OUTPUT_DIR, "metadata.json"),
    path.join(getTTBLReadDir(), "metadata.json"),
    path.join(WTT_OUTPUT_DIR, "dataset.json"),
    path.join(WTT_OUTPUT_DIR, "players.json"),
    ...seasonMetadataFiles,
  ];

  const mtimes = await Promise.all(files.map((filePath) => safeMtime(filePath)));
  return Math.max(0, ...mtimes);
}

async function isRegistryStale(): Promise<boolean> {
  const [registryMtime, sourceMtime] = await Promise.all([
    safeMtime(PLAYERS_REGISTRY_FILE),
    latestSourceMtime(),
  ]);

  return sourceMtime > registryMtime;
}

async function collectTTBLPlayers(log?: RegistryLogFn): Promise<SourcePlayerInput[]> {
  const ttblProfiles = await readTTBLPlayerProfiles();
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

      const sourceProfile = row.id?.trim() ? (ttblProfiles[row.id.trim()] ?? null) : null;
      const canonicalHint = buildTTBLCanonicalHint(normalizedName, sourceProfile);

      out.push({
        source: "ttbl",
        sourceId,
        displayName,
        normalizedName,
        canonicalHint,
        season,
        country: normalizeCountry(sourceProfile?.nationality ?? null),
        dobIso: unixSecondsToIsoDate(sourceProfile?.birthdayUnix ?? null),
      });
    }
  }

  const missingWithKnownStable = out.filter(
    (row) => row.sourceId && !row.sourceId.startsWith("name:") && !row.canonicalHint,
  );
  const stableHintByName = uniqueStableHintByName(out);
  const profileFetchIds = [
    ...new Set(
      missingWithKnownStable
        .filter((row) => stableHintByName.has(row.normalizedName))
        .map((row) => row.sourceId),
    ),
  ];

  if (profileFetchIds.length > 0) {
    emit(
      log,
      `TTBL profile backfill for merge identity: fetching ${profileFetchIds.length} missing source profiles.`,
    );

    let fetched = 0;
    let failed = 0;
    for (const sourceId of profileFetchIds) {
      try {
        const profile = await getTTBLPlayerProfile(sourceId);
        if (profile) {
          ttblProfiles[sourceId] = profile;
          fetched += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    for (const row of out) {
      if (row.canonicalHint || row.sourceId.startsWith("name:")) {
        continue;
      }

      const sourceProfile = ttblProfiles[row.sourceId] ?? null;
      row.canonicalHint = buildTTBLCanonicalHint(row.normalizedName, sourceProfile);
    }

    emit(
      log,
      `TTBL profile backfill complete: fetched=${fetched}, failed=${failed}.`,
    );
  }

  const postBackfillStableHintByName = uniqueStableHintByName(out);
  for (const row of out) {
    if (row.canonicalHint || row.sourceId.startsWith("name:")) {
      continue;
    }

    const hinted = postBackfillStableHintByName.get(row.normalizedName);
    if (hinted) {
      row.canonicalHint = hinted;
    }
  }

  return out;
}

async function collectWTTPlayers(): Promise<SourcePlayerInput[]> {
  const [players, matches] = await Promise.all([
    readJson<Record<string, WTTPlayer>>(path.join(WTT_OUTPUT_DIR, "players.json"), {}),
    readJson<WTTMatch[]>(path.join(WTT_OUTPUT_DIR, "matches.json"), []),
  ]);
  const playersById = players ?? {};
  const allMatches = matches ?? [];

  const out: SourcePlayerInput[] = [];
  const yearsByPlayer = new Map<string, Set<string>>();
  const gendersByPlayer = new Map<string, Set<PlayerGender>>();

  for (const match of allMatches) {
    if (!isWTTGenderedSinglesEvent(match.event)) {
      continue;
    }

    const year = (match.year ?? "").trim();
    if (!year) {
      continue;
    }
    const inferredGender = inferWTTEventGender(match.event);
    const genderFromEvent = inferredGender === "M" || inferredGender === "W" ? inferredGender : null;

    const aId = (match.players.a.ittf_id ?? "").trim();
    if (aId) {
      const years = yearsByPlayer.get(aId) ?? new Set<string>();
      years.add(year);
      yearsByPlayer.set(aId, years);
      if (genderFromEvent) {
        const genders = gendersByPlayer.get(aId) ?? new Set<PlayerGender>();
        genders.add(genderFromEvent);
        gendersByPlayer.set(aId, genders);
      }
    }

    const xId = (match.players.x.ittf_id ?? "").trim();
    if (xId) {
      const years = yearsByPlayer.get(xId) ?? new Set<string>();
      years.add(year);
      yearsByPlayer.set(xId, years);
      if (genderFromEvent) {
        const genders = gendersByPlayer.get(xId) ?? new Set<PlayerGender>();
        genders.add(genderFromEvent);
        gendersByPlayer.set(xId, genders);
      }
    }
  }

  for (const [ittfId, row] of Object.entries(playersById)) {
    const displayName =
      cleanName(row.full_name ?? "") ||
      cleanName(`${row.first_name ?? ""} ${row.last_name ?? ""}`) ||
      ittfId;
    const normalizedName = normalizeName(displayName);

    if (!normalizedName) {
      continue;
    }

    const profileGender = normalizeSourceGender(row.gender ?? null);
    const genderSet = gendersByPlayer.get(ittfId) ?? new Set<PlayerGender>();
    const eventGender =
      genderSet.size === 1
        ? [...genderSet][0]
        : genderSet.size > 1
          ? "mixed"
          : null;
    const mergedGender = profileGender ?? eventGender ?? null;

    const sourceYears = [...(yearsByPlayer.get(ittfId) ?? new Set<string>())].sort((a, b) =>
      b.localeCompare(a),
    );

    if (sourceYears.length === 0) {
      out.push({
        source: "wtt",
        sourceId: ittfId,
        displayName,
        normalizedName,
        dobIso: normalizeDateToIso(row.dob),
        country: normalizeCountry(row.nationality),
        gender: mergedGender,
      });
      continue;
    }

    for (const season of sourceYears) {
      out.push({
        source: "wtt",
        sourceId: ittfId,
        displayName,
        normalizedName,
        season,
        dobIso: normalizeDateToIso(row.dob),
        country: normalizeCountry(row.nationality),
        gender: mergedGender,
      });
    }
  }

  return out;
}

function autoConsolidateTTBLStableHints(
  sourcePlayers: SourcePlayerInput[],
  log?: RegistryLogFn,
): PlayerMergeCandidate[] {
  const ttblByName = new Map<string, SourcePlayerInput[]>();

  for (const row of sourcePlayers) {
    if (row.source !== "ttbl" || !row.canonicalHint?.startsWith("ttbl-stable:")) {
      continue;
    }

    const bucket = ttblByName.get(row.normalizedName) ?? [];
    bucket.push(row);
    ttblByName.set(row.normalizedName, bucket);
  }

  const issues: PlayerMergeCandidate[] = [];
  let changedRows = 0;
  let mergedGroups = 0;

  for (const [normalizedName, rows] of ttblByName.entries()) {
    const stableKeys = [...new Set(rows.map((row) => row.canonicalHint ?? ""))].filter(Boolean);
    if (stableKeys.length <= 1) {
      continue;
    }

    const dobValues = [...new Set(rows.map((row) => row.dobIso ?? null).filter(Boolean))];
    const countryValues = [
      ...new Set(rows.map((row) => row.country ?? null).filter(Boolean)),
    ];
    const rowsByStable = new Map<string, number>();
    for (const row of rows) {
      const key = row.canonicalHint ?? "";
      rowsByStable.set(key, (rowsByStable.get(key) ?? 0) + 1);
    }

    const maxRowsPerStable = Math.max(...[...rowsByStable.values()]);
    const canMergeByDob = dobValues.length === 1;
    const canMergeByNameCountryOnly =
      dobValues.length === 0 &&
      countryValues.length <= 1 &&
      (maxRowsPerStable > 1 || rows.length >= 3);
    const canMerge = canMergeByDob || canMergeByNameCountryOnly;

    if (!canMerge) {
      const leftStable = stableKeys[0] ?? "ttbl:unknown";
      const rightStable = stableKeys[1] ?? leftStable;
      const firstName = rows[0]?.displayName ?? normalizedName;
      const secondName = rows.find((row) => row.canonicalHint === rightStable)?.displayName ?? firstName;
      const detail =
        dobValues.length > 1
          ? `conflicting DOB values (${dobValues.join(", ")})`
          : countryValues.length > 1
            ? `conflicting countries (${countryValues.join(", ")})`
            : "insufficient evidence";
      issues.push({
        leftCanonicalKey: leftStable,
        rightCanonicalKey: rightStable,
        leftName: firstName,
        rightName: secondName,
        reason: `TTBL stable split unresolved for "${firstName}": ${detail}.`,
      });
      continue;
    }

    const primaryStable =
      stableKeys
        .sort((a, b) => {
          const countDiff = (rowsByStable.get(b) ?? 0) - (rowsByStable.get(a) ?? 0);
          if (countDiff !== 0) {
            return countDiff;
          }
          return a.localeCompare(b);
        })
        .at(0) ?? stableKeys[0];

    if (!primaryStable) {
      continue;
    }

    let groupChanged = false;
    for (const row of rows) {
      if (row.canonicalHint && row.canonicalHint !== primaryStable) {
        row.canonicalHint = primaryStable;
        changedRows += 1;
        groupChanged = true;
      }
    }

    if (groupChanged) {
      mergedGroups += 1;
    }
  }

  emit(
    log,
    `Auto-consolidated TTBL stable hints: groups=${mergedGroups}, rowReassignments=${changedRows}.`,
  );
  if (issues.length > 0) {
    emit(log, `TTBL stable split issues (unresolved): ${issues.length}.`);
  }

  return issues;
}

function autoLinkWTTToTTBL(
  sourcePlayers: SourcePlayerInput[],
  log?: RegistryLogFn,
): PlayerMergeCandidate[] {
  type TTBLCandidate = {
    stableKey: string;
    displayName: string;
    countries: Set<string>;
    dobIsoValues: Set<string>;
    genders: Set<PlayerGender>;
  };

  const ttblByNameKey = new Map<string, Map<string, TTBLCandidate>>();
  const wttByNameKey = new Map<string, SourcePlayerInput[]>();

  for (const player of sourcePlayers) {
    const nameKey = buildNameKey(player.displayName, player.country);
    if (!nameKey) {
      continue;
    }

    if (player.source === "ttbl" && player.canonicalHint?.startsWith("ttbl-stable:")) {
      const byStable = ttblByNameKey.get(nameKey) ?? new Map<string, TTBLCandidate>();
      const existing = byStable.get(player.canonicalHint) ?? {
        stableKey: player.canonicalHint,
        displayName: player.displayName,
        countries: new Set<string>(),
        dobIsoValues: new Set<string>(),
        genders: new Set<PlayerGender>(),
      };
      if (player.country) {
        existing.countries.add(player.country);
      }
      if (player.dobIso) {
        existing.dobIsoValues.add(player.dobIso);
      }
      if (player.gender && player.gender !== "unknown") {
        existing.genders.add(player.gender);
      }
      if (!existing.displayName || existing.displayName === "Unknown") {
        existing.displayName = player.displayName;
      }
      byStable.set(player.canonicalHint, existing);
      ttblByNameKey.set(nameKey, byStable);
    } else if (player.source === "wtt") {
      const rows = wttByNameKey.get(nameKey) ?? [];
      rows.push(player);
      wttByNameKey.set(nameKey, rows);
    }
  }

  let autoLinkedWTTIds = 0;
  const issues: PlayerMergeCandidate[] = [];
  const issueDedupe = new Set<string>();

  for (const [nameKey, wttRows] of wttByNameKey.entries()) {
    const ttblRows = [...(ttblByNameKey.get(nameKey)?.values() ?? [])];
    if (ttblRows.length === 0) {
      continue;
    }

    const ttblStableCount = new Set(ttblRows.map((row) => row.stableKey)).size;
    const wttRowsBySourceId = new Map<string, SourcePlayerInput[]>();
    for (const row of wttRows) {
      const rows = wttRowsBySourceId.get(row.sourceId) ?? [];
      rows.push(row);
      wttRowsBySourceId.set(row.sourceId, rows);
    }
    const wttSourceCount = wttRowsBySourceId.size;

    for (const [wttSourceId, rowsForSourceId] of wttRowsBySourceId.entries()) {
      const wtt =
        rowsForSourceId
          .slice()
          .sort((a, b) => {
            const score = (row: SourcePlayerInput) =>
              (row.dobIso ? 4 : 0) + (row.country ? 2 : 0) + (row.gender ? 1 : 0);
            return score(b) - score(a);
          })
          .at(0) ?? null;
      if (!wtt || wtt.canonicalHint) {
        continue;
      }

      const compatible = ttblRows.filter((ttbl) => {
        const countryCompatible =
          !wtt.country || ttbl.countries.size === 0 || ttbl.countries.has(wtt.country);
        const genderCompatible =
          !wtt.gender ||
          wtt.gender === "unknown" ||
          ttbl.genders.size === 0 ||
          ttbl.genders.has(wtt.gender);
        const dobMatch = Boolean(wtt.dobIso) && ttbl.dobIsoValues.has(wtt.dobIso ?? "");
        const dobConflict =
          Boolean(wtt.dobIso) &&
          ttbl.dobIsoValues.size > 0 &&
          !ttbl.dobIsoValues.has(wtt.dobIso ?? "");

        if (dobConflict) {
          return false;
        }
        if (!genderCompatible) {
          return false;
        }

        if (dobMatch) {
          return true;
        }

        if (!wtt.dobIso || ttbl.dobIsoValues.size === 0) {
          return countryCompatible && wttSourceCount === 1 && ttblStableCount === 1;
        }

        return false;
      });

      const stableKeys = [...new Set(compatible.map((row) => row.stableKey))];
      if (stableKeys.length === 1) {
        const target = stableKeys[0];
        for (const row of rowsForSourceId) {
          row.canonicalHint = target;
        }
        autoLinkedWTTIds += 1;
        continue;
      }

      const issueKeyBase = `wtt:${wttSourceId}`;
      if (stableKeys.length > 1) {
        const leftCanonicalKey = issueKeyBase;
        const leftName = wtt.displayName;
        const rightName = compatible
          .map((row) => row.displayName)
          .filter((value, index, arr) => arr.indexOf(value) === index)
          .slice(0, 3)
          .join(" | ");

        const dedupeKey = `${issueKeyBase}:ambiguous:${stableKeys.sort().join("|")}`;
        if (!issueDedupe.has(dedupeKey)) {
          issueDedupe.add(dedupeKey);
          issues.push({
            leftCanonicalKey,
            rightCanonicalKey: stableKeys[0] ?? "ttbl:ambiguous",
            leftName,
            rightName: rightName || "TTBL stable candidates",
            reason: `Auto-link ambiguity: ${stableKeys.length} TTBL stable matches for name key (${nameKey}).`,
          });
        }
        continue;
      }

      const hasDobConflict = ttblRows.some(
        (ttbl) =>
          Boolean(wtt.dobIso) &&
          ttbl.dobIsoValues.size > 0 &&
          !ttbl.dobIsoValues.has(wtt.dobIso ?? ""),
      );
      const hasCountryConflict =
        Boolean(wtt.country) &&
        ttblRows.every(
          (ttbl) => ttbl.countries.size > 0 && !ttbl.countries.has(wtt.country ?? ""),
        );
      const hasGenderConflict =
        Boolean(wtt.gender) &&
        wtt.gender !== "unknown" &&
        ttblRows.every(
          (ttbl) =>
            ttbl.genders.size > 0 && !ttbl.genders.has((wtt.gender ?? "unknown") as PlayerGender),
        );
      const detail = hasDobConflict
        ? "DOB mismatch"
        : hasGenderConflict
          ? "gender mismatch"
          : hasCountryConflict
            ? "country mismatch"
            : "insufficient evidence";
      const dedupeKey = `${issueKeyBase}:blocked:${detail}`;
      if (!issueDedupe.has(dedupeKey)) {
        issueDedupe.add(dedupeKey);
        issues.push({
          leftCanonicalKey: issueKeyBase,
          rightCanonicalKey: ttblRows[0]?.stableKey ?? "ttbl:unknown",
          leftName: wtt.displayName,
          rightName: ttblRows[0]?.displayName ?? "TTBL candidate",
          reason: `Auto-link blocked for name key (${nameKey}): ${detail}.`,
        });
      }
    }
  }

  emit(log, `Auto-linked WTT->TTBL players: ${autoLinkedWTTIds}.`);
  if (issues.length > 0) {
    emit(log, `Auto-link issues (unresolved): ${issues.length}.`);
  }

  return issues;
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
    collectTTBLPlayers(log),
    collectWTTPlayers(),
  ]);
  emit(log, `Collected source players: TTBL=${ttblPlayers.length}, WTT=${wttPlayers.length}`);

  const sourcePlayers = [...ttblPlayers, ...wttPlayers];
  const ttblConsolidationIssues = autoConsolidateTTBLStableHints(sourcePlayers, log);
  const autoLinkIssues = autoLinkWTTToTTBL(sourcePlayers, log);
  const canonicalMap = new Map<string, MutableCanonical>();
  const sourceIndex: Record<string, string> = {};

  for (const player of sourcePlayers) {
    const sourceKey = `${player.source}:${player.sourceId}`;
    const aliasKeyByName = `name:${player.normalizedName}`;

    const manualCanonicalKey =
      manual.aliases[sourceKey] ?? manual.aliases[aliasKeyByName] ?? null;
    const canonicalKey = manualCanonicalKey ?? player.canonicalHint ?? sourceKey;

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
  const mergeCandidates = [
    ...buildMergeCandidates(canonicalPlayers),
    ...ttblConsolidationIssues,
    ...autoLinkIssues,
  ].slice(0, 300);
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
  if (existing && !(await isRegistryStale())) {
    return existing;
  }

  return await rebuildPlayerRegistry();
}
