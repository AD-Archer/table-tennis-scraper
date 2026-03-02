import { getPrismaClient } from "@/lib/db/prisma";
import {
  areCountriesCompatible,
  getCountryCompatibilityCodes,
  normalizeCountryCode,
} from "@/lib/normalization/country";
import { getTTBLPlayerProfile, readTTBLPlayerProfiles } from "@/lib/ttbl/player-profiles";
import {
  CanonicalPlayer,
  PlayerGender,
  PlayerMergeCandidate,
  PlayerRegistryManualConfig,
  PlayerRegistrySnapshot,
  TTBLPlayerProfile,
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
  ttblClub?: string | null;
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
interface RebuildPlayerRegistryOptions {
  failOnUnresolvedCandidates?: boolean;
}

const registryGlobal = globalThis as typeof globalThis & {
  __playerRegistrySnapshotCompat?: PlayerRegistrySnapshot | null;
};

function getRegistryPrismaClient() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required in Postgres mode.");
  }

  return prisma;
}

function hasRegistryTables(
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>,
): prisma is NonNullable<ReturnType<typeof getPrismaClient>> & {
  playerRegistryState: { findUnique: (...args: unknown[]) => Promise<unknown> };
  playerCanonical: { findMany: (...args: unknown[]) => Promise<unknown[]> };
  playerCanonicalMember: { createMany: (...args: unknown[]) => Promise<unknown> };
  playerMergeCandidate: { findMany: (...args: unknown[]) => Promise<unknown[]> };
} {
  const candidate = prisma as unknown as Record<string, unknown>;
  return Boolean(
    candidate.playerRegistryState &&
      candidate.playerCanonical &&
      candidate.playerCanonicalMember &&
      candidate.playerMergeCandidate,
  );
}

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
  return normalizeCountryCode(value);
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

function extractBirthYear(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{4})/);
  if (!match?.[1]) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

function hasCloseBirthYearMatch(
  wttDob: string | null | undefined,
  ttblDobs: Set<string>,
  toleranceYears = 2,
): boolean {
  const wttYear = extractBirthYear(wttDob ?? null);
  if (!Number.isFinite(wttYear)) {
    return false;
  }

  for (const dob of ttblDobs) {
    const ttblYear = extractBirthYear(dob);
    if (!Number.isFinite(ttblYear)) {
      continue;
    }

    if (Math.abs((wttYear as number) - (ttblYear as number)) <= toleranceYears) {
      return true;
    }
  }

  return false;
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

function toTimestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

async function latestSourceTimestamp(): Promise<number> {
  const prisma = getRegistryPrismaClient();
  const prismaAny = prisma as unknown as {
    ttblSeasonSummary?: {
      findFirst: (args: unknown) => Promise<{ scrapeDate: Date } | null>;
    };
  };
  const [latestTtblSeasonCompat, latestTtblMatchCompat, latestWttMatch, latestWttPlayer] =
    await Promise.all([
      prismaAny.ttblSeasonSummary?.findFirst
        ? prismaAny.ttblSeasonSummary.findFirst({
            orderBy: { scrapeDate: "desc" },
            select: { scrapeDate: true },
          })
        : Promise.resolve(null),
      prisma.ttblMatch.findFirst({
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
    prisma.wttMatch.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    prisma.wttPlayer.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);

  const timestamps = [
    latestTtblSeasonCompat?.scrapeDate.getTime() ?? 0,
    latestTtblMatchCompat?.updatedAt.getTime() ?? 0,
    latestWttMatch?.updatedAt.getTime() ?? 0,
    latestWttPlayer?.updatedAt.getTime() ?? 0,
  ];

  return Math.max(0, ...timestamps);
}

async function isRegistryStale(): Promise<boolean> {
  const [registry, sourceTimestamp] = await Promise.all([
    getPlayerRegistrySnapshot(),
    latestSourceTimestamp(),
  ]);

  const registryTimestamp = toTimestamp(registry?.generatedAt);
  return sourceTimestamp > registryTimestamp;
}

async function collectTTBLPlayersFromDb(
  ttblProfiles: Record<string, TTBLPlayerProfile>,
  log?: RegistryLogFn,
): Promise<SourcePlayerInput[]> {
  const prisma = getRegistryPrismaClient();

  try {
    const seasonStats = await prisma.ttblPlayerSeasonStat.findMany({
      select: {
        season: true,
        playerId: true,
        name: true,
      },
    });
    if (seasonStats.length === 0) {
      emit(log, "TTBL player registry source: Postgres (0 season stats).");
      return [];
    }

    const playerIds = [...new Set(seasonStats.map((row) => row.playerId).filter(Boolean))];
    const players = await prisma.ttblPlayer.findMany({
      where: {
        id: { in: playerIds },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        fullName: true,
      },
    });
    const playerById = new Map(players.map((row) => [row.id, row]));

    const out: SourcePlayerInput[] = [];
    const dedupe = new Set<string>();
    for (const row of seasonStats) {
      const sourceId = row.playerId.trim();
      if (!sourceId) {
        continue;
      }

      const profileRow = playerById.get(sourceId);
      const displayName =
        cleanName(profileRow?.fullName ?? "") ||
        cleanName(
          `${profileRow?.firstName ?? ""} ${profileRow?.lastName ?? ""}`,
        ) ||
        cleanName(row.name) ||
        sourceId;
      const normalizedName = normalizeName(displayName);
      if (!normalizedName || normalizedName === "unknown") {
        continue;
      }

      const dedupeKey = `ttbl:${sourceId}:${row.season}`;
      if (dedupe.has(dedupeKey)) {
        continue;
      }
      dedupe.add(dedupeKey);

      const sourceProfile = ttblProfiles[sourceId] ?? null;
      out.push({
        source: "ttbl",
        sourceId,
        displayName,
        normalizedName,
        canonicalHint: buildTTBLCanonicalHint(normalizedName, sourceProfile),
        season: row.season,
        country: normalizeCountry(sourceProfile?.nationality ?? null),
        ttblClub: cleanName(sourceProfile?.currentClub ?? "") || null,
        dobIso: unixSecondsToIsoDate(sourceProfile?.birthdayUnix ?? null),
      });
    }

    emit(log, `TTBL player registry source: Postgres (${out.length} rows).`);
    return out;
  } catch (error) {
    throw new Error(
      `TTBL player registry Postgres read failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

async function collectWTTPlayersFromDb(
  log?: RegistryLogFn,
): Promise<SourcePlayerInput[]> {
  const prisma = getRegistryPrismaClient();

  try {
    const [players, matches] = await Promise.all([
      prisma.wttPlayer.findMany({
        select: {
          id: true,
          firstName: true,
          lastName: true,
          fullName: true,
          dob: true,
          nationality: true,
          gender: true,
        },
      }),
      prisma.wttMatch.findMany({
        select: {
          year: true,
          event: true,
          playerAId: true,
          playerXId: true,
        },
      }),
    ]);

    const yearsByPlayer = new Map<string, Set<string>>();
    const gendersByPlayer = new Map<string, Set<PlayerGender>>();

    for (const match of matches) {
      if (!isWTTGenderedSinglesEvent(match.event ?? null)) {
        continue;
      }

      const year = match.year ? String(match.year) : "";
      if (!year) {
        continue;
      }
      const inferredGender = inferWTTEventGender(match.event ?? null);
      const genderFromEvent =
        inferredGender === "M" || inferredGender === "W" ? inferredGender : null;

      const aId = (match.playerAId ?? "").trim();
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

      const xId = (match.playerXId ?? "").trim();
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

    const out: SourcePlayerInput[] = [];
    for (const row of players) {
      const displayName =
        cleanName(row.fullName ?? "") ||
        cleanName(`${row.firstName ?? ""} ${row.lastName ?? ""}`) ||
        row.id;
      const normalizedName = normalizeName(displayName);
      if (!normalizedName) {
        continue;
      }

      const profileGender = normalizeSourceGender(row.gender ?? null);
      const genderSet = gendersByPlayer.get(row.id) ?? new Set<PlayerGender>();
      const eventGender =
        genderSet.size === 1
          ? [...genderSet][0]
          : genderSet.size > 1
            ? "mixed"
            : null;
      const mergedGender = profileGender ?? eventGender ?? null;

      const years = [...(yearsByPlayer.get(row.id) ?? new Set<string>())].sort((a, b) =>
        b.localeCompare(a),
      );
      if (years.length === 0) {
        out.push({
          source: "wtt",
          sourceId: row.id,
          displayName,
          normalizedName,
          dobIso: normalizeDateToIso(row.dob),
          country: normalizeCountry(row.nationality),
          gender: mergedGender,
        });
        continue;
      }

      for (const season of years) {
        out.push({
          source: "wtt",
          sourceId: row.id,
          displayName,
          normalizedName,
          season,
          dobIso: normalizeDateToIso(row.dob),
          country: normalizeCountry(row.nationality),
          gender: mergedGender,
        });
      }
    }

    emit(log, `WTT player registry source: Postgres (${out.length} rows).`);
    return out;
  } catch (error) {
    throw new Error(
      `WTT player registry Postgres read failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

async function collectTTBLPlayers(log?: RegistryLogFn): Promise<SourcePlayerInput[]> {
  const ttblProfiles = await readTTBLPlayerProfiles();
  const out = await collectTTBLPlayersFromDb(ttblProfiles, log);

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

async function collectWTTPlayers(log?: RegistryLogFn): Promise<SourcePlayerInput[]> {
  return await collectWTTPlayersFromDb(log);
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
    const clubValues = [
      ...new Set(rows.map((row) => normalizeName(row.ttblClub ?? "")).filter(Boolean)),
    ];
    const seasonValues = [...new Set(rows.map((row) => row.season ?? "").filter(Boolean))];
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
    const canMergeByProfileFingerprint =
      dobValues.length === 0 &&
      countryValues.length <= 1 &&
      clubValues.length === 1 &&
      seasonValues.length <= 1;
    const canMerge = canMergeByDob || canMergeByNameCountryOnly || canMergeByProfileFingerprint;

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
            : clubValues.length > 1
              ? "conflicting clubs"
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

function autoConsolidateWTTIdentityHints(
  sourcePlayers: SourcePlayerInput[],
  log?: RegistryLogFn,
): PlayerMergeCandidate[] {
  interface WTTIdentity {
    sourceId: string;
    displayName: string;
    countries: Set<string>;
    dobIsoValues: Set<string>;
    genders: Set<PlayerGender>;
  }

  const byNameKey = new Map<string, Map<string, WTTIdentity>>();
  for (const row of sourcePlayers) {
    if (row.source !== "wtt") {
      continue;
    }

    const nameKey = buildNameKey(row.displayName, row.country);
    if (!nameKey) {
      continue;
    }

    const byId = byNameKey.get(nameKey) ?? new Map<string, WTTIdentity>();
    const existing = byId.get(row.sourceId) ?? {
      sourceId: row.sourceId,
      displayName: row.displayName,
      countries: new Set<string>(),
      dobIsoValues: new Set<string>(),
      genders: new Set<PlayerGender>(),
    };
    if (row.country) {
      existing.countries.add(row.country);
    }
    if (row.dobIso) {
      existing.dobIsoValues.add(row.dobIso);
    }
    if (row.gender && row.gender !== "unknown") {
      existing.genders.add(row.gender);
    }
    byId.set(row.sourceId, existing);
    byNameKey.set(nameKey, byId);
  }

  let mergedGroups = 0;
  let reassignedRows = 0;
  const issues: PlayerMergeCandidate[] = [];
  const issueDedupe = new Set<string>();

  for (const [nameKey, groupedBySourceId] of byNameKey.entries()) {
    const identities = [...groupedBySourceId.values()];
    if (identities.length <= 1) {
      continue;
    }

    const dobValues = [
      ...new Set(
        identities.flatMap((row) => [...row.dobIsoValues]).filter(Boolean),
      ),
    ];
    const countryValues = [
      ...new Set(
        identities.flatMap((row) => [...row.countries]).filter(Boolean),
      ),
    ];
    const genderValues = [
      ...new Set(
        identities.flatMap((row) => [...row.genders]).filter(Boolean),
      ),
    ];

    const dobYears = [...new Set(dobValues.map((value) => extractBirthYear(value)).filter(Number.isFinite))] as number[];
    const nearDobMergeEligible =
      identities.length === 2 &&
      dobValues.length === 2 &&
      dobYears.length === 2 &&
      countryValues.length <= 1 &&
      genderValues.length <= 1 &&
      Math.abs(dobYears[0] - dobYears[1]) <= 3;
    const canMergeByExactDob = dobValues.length === 1;
    const canMerge = canMergeByExactDob || nearDobMergeEligible;

    if (!canMerge) {
      const dedupeKey = `wtt:${nameKey}:dob:${dobValues.sort().join("|")}`;
      if (!issueDedupe.has(dedupeKey)) {
        issueDedupe.add(dedupeKey);
        issues.push({
          leftCanonicalKey: `wtt:${identities[0]?.sourceId ?? "unknown"}`,
          rightCanonicalKey: `wtt:${identities[1]?.sourceId ?? identities[0]?.sourceId ?? "unknown"}`,
          leftName: identities[0]?.displayName ?? nameKey,
          rightName: identities[1]?.displayName ?? identities[0]?.displayName ?? nameKey,
          reason: `WTT internal split unresolved for name key (${nameKey}): DOB mismatch or missing DOB across IDs.`,
        });
      }
      continue;
    }

    if (countryValues.length > 1 || genderValues.length > 1) {
      const dedupeKey = `wtt:${nameKey}:profile-conflict`;
      if (!issueDedupe.has(dedupeKey)) {
        issueDedupe.add(dedupeKey);
        issues.push({
          leftCanonicalKey: `wtt:${identities[0]?.sourceId ?? "unknown"}`,
          rightCanonicalKey: `wtt:${identities[1]?.sourceId ?? identities[0]?.sourceId ?? "unknown"}`,
          leftName: identities[0]?.displayName ?? nameKey,
          rightName: identities[1]?.displayName ?? identities[0]?.displayName ?? nameKey,
          reason: `WTT internal split unresolved for name key (${nameKey}): conflicting country/gender across IDs.`,
        });
      }
      continue;
    }

    const canonicalHint = canMergeByExactDob
      ? `wtt-profile:${nameKey}:dob:${dobValues[0]}`
      : `wtt-profile:${nameKey}:country:${countryValues[0] ?? "unk"}:near-dob`;
    let groupChanged = false;
    for (const row of sourcePlayers) {
      if (row.source !== "wtt") {
        continue;
      }
      if (!groupedBySourceId.has(row.sourceId)) {
        continue;
      }
      if (row.canonicalHint !== canonicalHint) {
        row.canonicalHint = canonicalHint;
        reassignedRows += 1;
        groupChanged = true;
      }
    }
    if (groupChanged) {
      mergedGroups += 1;
    }
  }

  emit(
    log,
    `Auto-consolidated WTT identity hints: groups=${mergedGroups}, rowReassignments=${reassignedRows}.`,
  );
  if (issues.length > 0) {
    emit(log, `WTT internal split issues (unresolved): ${issues.length}.`);
  }

  return issues;
}

function autoLinkWTTToTTBL(
  sourcePlayers: SourcePlayerInput[],
  log?: RegistryLogFn,
): PlayerMergeCandidate[] {
  type TTBLCandidate = {
    identityKey: string;
    displayName: string;
    countries: Set<string>;
    dobIsoValues: Set<string>;
    genders: Set<PlayerGender>;
  };

  const ttblByNameKey = new Map<string, Map<string, TTBLCandidate>>();
  const wttByNameKey = new Map<string, SourcePlayerInput[]>();
  const rowsByWttSourceId = new Map<string, SourcePlayerInput[]>();

  for (const player of sourcePlayers) {
    const nameKey = buildNameKey(player.displayName, player.country);
    if (!nameKey) {
      continue;
    }

    if (
      player.source === "ttbl" &&
      (player.canonicalHint?.startsWith("ttbl-stable:") ||
        player.canonicalHint?.startsWith("ttbl-profile:"))
    ) {
      const byStable = ttblByNameKey.get(nameKey) ?? new Map<string, TTBLCandidate>();
      const existing = byStable.get(player.canonicalHint) ?? {
        identityKey: player.canonicalHint,
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

      const bySourceId = rowsByWttSourceId.get(player.sourceId) ?? [];
      bySourceId.push(player);
      rowsByWttSourceId.set(player.sourceId, bySourceId);
    }
  }

  let autoLinkedWTTIds = 0;
  let autoLinkedWTTIdsFuzzy = 0;
  const issues: PlayerMergeCandidate[] = [];
  const issueDedupe = new Set<string>();

  const scoreSourceRow = (row: SourcePlayerInput): number =>
    (row.dobIso ? 4 : 0) + (row.country ? 2 : 0) + (row.gender ? 1 : 0);

  for (const [nameKey, wttRows] of wttByNameKey.entries()) {
    const ttblRows = [...(ttblByNameKey.get(nameKey)?.values() ?? [])];
    if (ttblRows.length === 0) {
      continue;
    }

    const ttblStableCount = new Set(ttblRows.map((row) => row.identityKey)).size;
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
          .sort((a, b) => scoreSourceRow(b) - scoreSourceRow(a))
          .at(0) ?? null;
      if (!wtt || wtt.canonicalHint) {
        continue;
      }

      const compatible = ttblRows.filter((ttbl) => {
        const countryCompatible =
          !wtt.country ||
          ttbl.countries.size === 0 ||
          [...ttbl.countries].some((country) => areCountriesCompatible(country, wtt.country));
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
        const oneToOne = wttSourceCount === 1 && ttblStableCount === 1;
        const closeBirthYear = hasCloseBirthYearMatch(wtt.dobIso, ttbl.dobIsoValues);

        if (!genderCompatible) {
          return false;
        }

        if (dobMatch) {
          return true;
        }

        if (dobConflict) {
          return countryCompatible && oneToOne && closeBirthYear;
        }

        if (!wtt.dobIso || ttbl.dobIsoValues.size === 0) {
          return countryCompatible && oneToOne;
        }

        if (countryCompatible && oneToOne && closeBirthYear) {
          return true;
        }

        return false;
      });

      const stableKeys = [...new Set(compatible.map((row) => row.identityKey))];
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
            reason: `Auto-link ambiguity: ${stableKeys.length} TTBL identity matches for name key (${nameKey}).`,
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
          (ttbl) =>
            ttbl.countries.size > 0 &&
            ![...ttbl.countries].some((country) => areCountriesCompatible(country, wtt.country)),
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
          rightCanonicalKey: ttblRows[0]?.identityKey ?? "ttbl:unknown",
          leftName: wtt.displayName,
          rightName: ttblRows[0]?.displayName ?? "TTBL candidate",
          reason: `Auto-link blocked for name key (${nameKey}): ${detail}.`,
        });
      }
    }
  }

  type TTBLSurnameCandidate = {
    identityKey: string;
    displayName: string;
    surnames: Set<string>;
    givenNames: Set<string>;
    countries: Set<string>;
    dobIsoValues: Set<string>;
    genders: Set<PlayerGender>;
  };

  const ttblByIdentity = new Map<string, TTBLSurnameCandidate>();
  for (const row of sourcePlayers) {
    if (
      row.source !== "ttbl" ||
      !row.canonicalHint ||
      (!row.canonicalHint.startsWith("ttbl-stable:") &&
        !row.canonicalHint.startsWith("ttbl-profile:"))
    ) {
      continue;
    }

    const parts = parseNameParts(row.displayName, row.country);
    if (!parts) {
      continue;
    }

    const existing = ttblByIdentity.get(row.canonicalHint) ?? {
      identityKey: row.canonicalHint,
      displayName: row.displayName,
      surnames: new Set<string>(),
      givenNames: new Set<string>(),
      countries: new Set<string>(),
      dobIsoValues: new Set<string>(),
      genders: new Set<PlayerGender>(),
    };

    existing.surnames.add(parts.surname);
    if (parts.given) {
      existing.givenNames.add(parts.given);
    }
    if (row.country) {
      existing.countries.add(row.country);
    }
    if (row.dobIso) {
      existing.dobIsoValues.add(row.dobIso);
    }
    if (row.gender && row.gender !== "unknown") {
      existing.genders.add(row.gender);
    }
    if (!existing.displayName || existing.displayName === "Unknown") {
      existing.displayName = row.displayName;
    }

    ttblByIdentity.set(row.canonicalHint, existing);
  }

  const unresolvedWttBySourceId = new Map<string, SourcePlayerInput[]>();
  for (const [sourceId, rows] of rowsByWttSourceId.entries()) {
    const unresolvedRows = rows.filter((row) => !row.canonicalHint);
    if (unresolvedRows.length > 0) {
      unresolvedWttBySourceId.set(sourceId, unresolvedRows);
    }
  }

  const potentialTtblByWtt = new Map<string, Set<string>>();
  const potentialWttByTtbl = new Map<string, Set<string>>();

  for (const [wttSourceId, rows] of unresolvedWttBySourceId.entries()) {
    const wtt = rows.slice().sort((a, b) => scoreSourceRow(b) - scoreSourceRow(a)).at(0) ?? null;
    if (!wtt) {
      continue;
    }

    const wttParts = parseNameParts(wtt.displayName, wtt.country);
    if (!wttParts || !wttParts.surname || !wttParts.given) {
      continue;
    }

    const candidates = [...ttblByIdentity.values()].filter((ttbl) => {
      const surnameMatch = [...ttbl.surnames].some((surname) => surname === wttParts.surname);
      if (!surnameMatch) {
        return false;
      }

      const givenMatch = [...ttbl.givenNames].some((given) => givenNamesSimilar(given, wttParts.given));
      if (!givenMatch) {
        return false;
      }

      const countryCompatible =
        !wtt.country ||
        ttbl.countries.size === 0 ||
        [...ttbl.countries].some((country) => areCountriesCompatible(country, wtt.country));
      if (!countryCompatible) {
        return false;
      }

      const genderCompatible =
        !wtt.gender ||
        wtt.gender === "unknown" ||
        ttbl.genders.size === 0 ||
        ttbl.genders.has(wtt.gender);
      if (!genderCompatible) {
        return false;
      }

      const hasHardDobConflict =
        Boolean(wtt.dobIso) &&
        ttbl.dobIsoValues.size > 0 &&
        !ttbl.dobIsoValues.has(wtt.dobIso ?? "");
      if (hasHardDobConflict) {
        return false;
      }

      return true;
    });

    if (candidates.length === 0) {
      continue;
    }

    const ttblKeys = new Set(candidates.map((candidate) => candidate.identityKey));
    potentialTtblByWtt.set(wttSourceId, ttblKeys);
    for (const ttblKey of ttblKeys) {
      const wttKeys = potentialWttByTtbl.get(ttblKey) ?? new Set<string>();
      wttKeys.add(wttSourceId);
      potentialWttByTtbl.set(ttblKey, wttKeys);
    }
  }

  for (const [wttSourceId, ttblKeys] of potentialTtblByWtt.entries()) {
    if (ttblKeys.size !== 1) {
      continue;
    }

    const ttblKey = [...ttblKeys][0];
    if (!ttblKey) {
      continue;
    }

    const reverse = potentialWttByTtbl.get(ttblKey);
    if (!reverse || reverse.size !== 1 || !reverse.has(wttSourceId)) {
      continue;
    }

    const rows = unresolvedWttBySourceId.get(wttSourceId) ?? [];
    if (rows.length === 0) {
      continue;
    }

    for (const row of rows) {
      row.canonicalHint = ttblKey;
    }
    autoLinkedWTTIds += 1;
    autoLinkedWTTIdsFuzzy += 1;
  }

  emit(log, `Auto-linked WTT->TTBL players: ${autoLinkedWTTIds}.`);
  if (autoLinkedWTTIdsFuzzy > 0) {
    emit(log, `Auto-linked WTT->TTBL players via fuzzy name matching: ${autoLinkedWTTIdsFuzzy}.`);
  }
  if (issues.length > 0) {
    emit(log, `Auto-link issues (unresolved): ${issues.length}.`);
  }

  return issues;
}

async function loadManualConfig(): Promise<PlayerRegistryManualConfig> {
  const prisma = getRegistryPrismaClient();
  const prismaAny = prisma as unknown as {
    playerManualAlias?: {
      findMany: (args: unknown) => Promise<Array<{ key: string; canonicalKey: string }>>;
    };
  };
  if (!prismaAny.playerManualAlias?.findMany) {
    return DEFAULT_MANUAL_CONFIG;
  }
  const rows = await prismaAny.playerManualAlias.findMany({
    select: {
      key: true,
      canonicalKey: true,
    },
  });

  if (rows.length === 0) {
    return DEFAULT_MANUAL_CONFIG;
  }

  return {
    aliases: Object.fromEntries(rows.map((row) => [row.key, row.canonicalKey])),
  };
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

    const countryKey = parsed.country
      ? getCountryCompatibilityCodes(parsed.country).sort((a, b) => a.localeCompare(b)).join("|")
      : "UNK";
    const signature = `${parsed.surname}|${countryKey}|${parsed.givenInitial}`;
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
          !areCountriesCompatible(left.parts.country, right.parts.country)
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

function dedupeMergeCandidates(candidates: PlayerMergeCandidate[]): PlayerMergeCandidate[] {
  const seen = new Set<string>();
  const seenCrossSourceByNames = new Set<string>();
  const out: PlayerMergeCandidate[] = [];

  for (const row of candidates) {
    const leftKey = row.leftCanonicalKey.trim();
    const rightKey = row.rightCanonicalKey.trim();
    const reason = row.reason.trim().toLowerCase();
    if (!leftKey || !rightKey || !reason) {
      continue;
    }

    const pair = [leftKey, rightKey].sort((a, b) => a.localeCompare(b));
    const signature = `${pair[0]}::${pair[1]}::${reason}`;
    if (seen.has(signature)) {
      continue;
    }

    if (reason.startsWith("same surname +")) {
      const names = [normalizeName(row.leftName), normalizeName(row.rightName)]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      if (names.length === 2) {
        const nameSignature = `${names[0]}::${names[1]}::${reason}`;
        if (seenCrossSourceByNames.has(nameSignature)) {
          continue;
        }
        seenCrossSourceByNames.add(nameSignature);
      }
    }

    seen.add(signature);
    out.push({
      leftCanonicalKey: leftKey,
      rightCanonicalKey: rightKey,
      leftName: row.leftName,
      rightName: row.rightName,
      reason: row.reason.trim(),
    });
  }

  return out;
}

function isInformationalMergeReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return (
    normalized.startsWith("same surname + same given name (cross-source)") ||
    normalized.startsWith("same surname + similar given name (cross-source)")
  );
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

export async function rebuildPlayerRegistry(
  log?: RegistryLogFn,
  options: RebuildPlayerRegistryOptions = {},
): Promise<PlayerRegistrySnapshot> {
  emit(log, "Starting player registry rebuild.");

  const manual = await loadManualConfig();
  emit(log, `Loaded manual aliases: ${Object.keys(manual.aliases ?? {}).length}`);
  const [ttblPlayers, wttPlayers] = await Promise.all([
    collectTTBLPlayers(log),
    collectWTTPlayers(log),
  ]);
  emit(log, `Collected source players: TTBL=${ttblPlayers.length}, WTT=${wttPlayers.length}`);

  const sourcePlayers = [...ttblPlayers, ...wttPlayers];
  const ttblConsolidationIssues = autoConsolidateTTBLStableHints(sourcePlayers, log);
  const wttConsolidationIssues = autoConsolidateWTTIdentityHints(sourcePlayers, log);
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
  const mergeCandidates = dedupeMergeCandidates([
    ...buildMergeCandidates(canonicalPlayers),
    ...ttblConsolidationIssues,
    ...wttConsolidationIssues,
    ...autoLinkIssues,
  ]).slice(0, 300);
  const blockingCandidates = mergeCandidates.filter(
    (row) => !isInformationalMergeReason(row.reason),
  );
  emit(
    log,
    `Built canonical map: canonical=${canonicalPlayers.length}, candidates=${mergeCandidates.length}, blockingCandidates=${blockingCandidates.length}`,
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

  if (options.failOnUnresolvedCandidates && blockingCandidates.length > 0) {
    const sample = blockingCandidates
      .slice(0, 5)
      .map((row) => `${row.leftName} <> ${row.rightName} (${row.reason})`)
      .join(" | ");
    throw new Error(
      `Strict merge failed: ${blockingCandidates.length} blocking unresolved merge candidates remain.${sample ? ` Sample: ${sample}` : ""}`,
    );
  }

  const prisma = getRegistryPrismaClient();
  if (!hasRegistryTables(prisma)) {
    registryGlobal.__playerRegistrySnapshotCompat = snapshot;
    emit(
      log,
      "Registry stored in compatibility memory cache (restart dev server after prisma generate).",
    );
    return snapshot;
  }

  await prisma.$transaction(async (tx) => {
    await tx.playerMergeCandidate.deleteMany({});
    await tx.playerCanonicalMember.deleteMany({});
    await tx.playerCanonical.deleteMany({});
    await tx.playerRegistryState.deleteMany({});

    await tx.playerRegistryState.create({
      data: {
        id: 1,
        generatedAt: new Date(snapshot.generatedAt),
        sourcePlayers: snapshot.totals.sourcePlayers,
        ttblSourcePlayers: snapshot.totals.ttblSourcePlayers,
        wttSourcePlayers: snapshot.totals.wttSourcePlayers,
        canonicalPlayers: snapshot.totals.canonicalPlayers,
        mergedPlayers: snapshot.totals.mergedPlayers,
        candidates: snapshot.totals.candidates,
      },
    });

    if (snapshot.players.length > 0) {
      await tx.playerCanonical.createMany({
        data: snapshot.players.map((row) => ({
          canonicalKey: row.canonicalKey,
          displayName: row.displayName,
          normalizedNames: row.normalizedNames,
          sourceCount: row.sourceCount,
          memberCount: row.memberCount,
        })),
      });
    }

    const members = snapshot.players.flatMap((player) =>
      player.members.map((member) => ({
        canonicalKey: player.canonicalKey,
        source: member.source,
        sourceId: member.sourceId,
        sourceKey: member.sourceKey,
        names: member.names,
        seasons: member.seasons,
      })),
    );
    for (let i = 0; i < members.length; i += 500) {
      const batch = members.slice(i, i + 500);
      if (batch.length > 0) {
        await tx.playerCanonicalMember.createMany({ data: batch });
      }
    }

    if (snapshot.mergeCandidates.length > 0) {
      await tx.playerMergeCandidate.createMany({
        data: snapshot.mergeCandidates.map((row) => ({
          leftCanonicalKey: row.leftCanonicalKey,
          rightCanonicalKey: row.rightCanonicalKey,
          leftName: row.leftName,
          rightName: row.rightName,
          reason: row.reason,
        })),
      });
    }
  });
  emit(log, "Registry persisted to relational tables.");

  return snapshot;
}

export async function getPlayerRegistrySnapshot(): Promise<PlayerRegistrySnapshot | null> {
  const prisma = getRegistryPrismaClient();
  if (!hasRegistryTables(prisma)) {
    return registryGlobal.__playerRegistrySnapshotCompat ?? null;
  }

  const [state, canonicalRows, candidateRows] = await Promise.all([
    prisma.playerRegistryState.findUnique({
      where: { id: 1 },
    }),
    prisma.playerCanonical.findMany({
      include: {
        members: true,
      },
    }),
    prisma.playerMergeCandidate.findMany({}),
  ]);

  if (!state) {
    return null;
  }

  const players: CanonicalPlayer[] = canonicalRows
    .map((row) => ({
      canonicalKey: row.canonicalKey,
      displayName: row.displayName,
      normalizedNames: [...row.normalizedNames].sort((a, b) => a.localeCompare(b)),
      sourceCount: row.sourceCount,
      memberCount: row.memberCount,
      members: row.members
        .map((member) => ({
          source: member.source as "ttbl" | "wtt",
          sourceId: member.sourceId,
          sourceKey: member.sourceKey,
          names: [...member.names].sort((a, b) => a.localeCompare(b)),
          seasons: [...member.seasons].sort((a, b) => a.localeCompare(b)),
        }))
        .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
    }))
    .sort(
      (a, b) => b.memberCount - a.memberCount || a.displayName.localeCompare(b.displayName),
    );

  const mergeCandidates: PlayerMergeCandidate[] = candidateRows
    .map((row) => ({
      leftCanonicalKey: row.leftCanonicalKey,
      rightCanonicalKey: row.rightCanonicalKey,
      leftName: row.leftName,
      rightName: row.rightName,
      reason: row.reason,
    }))
    .sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) ||
        a.leftName.localeCompare(b.leftName) ||
        a.rightName.localeCompare(b.rightName),
    );

  const sourceIndex: Record<string, string> = {};
  for (const player of players) {
    for (const member of player.members) {
      sourceIndex[member.sourceKey] = player.canonicalKey;
    }
  }

  return {
    generatedAt: state.generatedAt.toISOString(),
    totals: {
      sourcePlayers: state.sourcePlayers,
      ttblSourcePlayers: state.ttblSourcePlayers,
      wttSourcePlayers: state.wttSourcePlayers,
      canonicalPlayers: state.canonicalPlayers,
      mergedPlayers: state.mergedPlayers,
      candidates: state.candidates,
    },
    players,
    mergeCandidates,
    sourceIndex,
  };
}

export async function ensurePlayerRegistry(): Promise<PlayerRegistrySnapshot | null> {
  const existing = await getPlayerRegistrySnapshot();
  if (existing && !(await isRegistryStale())) {
    return existing;
  }

  return await rebuildPlayerRegistry();
}
