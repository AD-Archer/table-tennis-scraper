import { readJson, writeJson } from "@/lib/fs";
import { TTBL_PLAYER_PROFILES_FILE } from "@/lib/paths";
import { TTBLPlayerProfile } from "@/lib/types";

const TTBL_BASE_URL = "https://www.ttbl.de";
const NEXT_DATA_REGEX = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

interface ProfileFetchOptions {
  onLog?: (message: string) => void;
}

interface HydrateProfilesOptions {
  delayMs?: number;
  onLog?: (message: string) => void;
}

interface TTBLProfilesHydrationResult {
  requested: number;
  fetched: number;
  cached: number;
  failed: number;
}

interface NextDataPayload {
  props?: {
    pageProps?: {
      player?: Record<string, unknown>;
      season?: Record<string, unknown>;
    };
  };
}

type TTBLProfilesMap = Record<string, TTBLPlayerProfile>;

function emit(log: ((message: string) => void) | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] [TTBL_PROFILE] ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function buildSeasonLabel(season: Record<string, unknown> | null): string | null {
  if (!season) {
    return null;
  }

  const startYear = toNullableNumber(season.startYear);
  const endYear = toNullableNumber(season.endYear);
  if (startYear === null || endYear === null) {
    return null;
  }

  return `${Math.trunc(startYear)}-${Math.trunc(endYear)}`;
}

function buildFullName(firstName: string | null, lastName: string | null): string {
  const parts = [firstName ?? "", lastName ?? ""].map((value) => value.trim()).filter(Boolean);
  return parts.join(" ") || "Unknown";
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "TTBL-NextJS-Scraper/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return await response.text();
}

function extractProfileFromPayload(sourcePlayerId: string, payload: NextDataPayload): TTBLPlayerProfile {
  const pageProps = payload.props?.pageProps ?? {};
  const player = asRecord(pageProps.player);
  const season = asRecord(pageProps.season);
  const seasonPlayer = asRecord(player?.seasonPlayer);
  const seasonTeam = asRecord(seasonPlayer?.seasonTeam);
  const outfitter = asRecord(seasonPlayer?.outfitter);

  const firstName = toNullableString(seasonPlayer?.firstName);
  const lastName = toNullableString(seasonPlayer?.lastName);

  return {
    sourcePlayerId,
    stablePlayerId: toNullableString(seasonPlayer?.playerId),
    seasonPlayerId: toNullableString(seasonPlayer?.id),
    fetchedAt: new Date().toISOString(),
    fullName: buildFullName(firstName, lastName),
    firstName,
    lastName,
    nationality: toNullableString(seasonPlayer?.nationality),
    nationalitySecondary: toNullableString(seasonPlayer?.nationalitySecondary),
    birthdayUnix: toNullableNumber(seasonPlayer?.birthday),
    heightCm: toNullableNumber(seasonPlayer?.height),
    weightKg: toNullableNumber(seasonPlayer?.weight),
    hand: toNullableString(seasonPlayer?.hand),
    racketPosture: toNullableString(seasonPlayer?.racketPosture),
    role: toNullableString(seasonPlayer?.role),
    currentClub: toNullableString(seasonTeam?.name),
    outfitter: toNullableString(outfitter?.company),
    outfitterWebsite: toNullableString(outfitter?.website),
    seasonLabel: buildSeasonLabel(season),
    imageUrl: toNullableString(seasonPlayer?.imageUrl),
    actionImageUrl: toNullableString(seasonPlayer?.actionImageUrl),
    cardImageUrl: toNullableString(seasonPlayer?.cardImageUrl),
    social: {
      instagram: toNullableString(seasonPlayer?.instagramLink),
      youtube: toNullableString(seasonPlayer?.youtubeLink),
      website: toNullableString(seasonPlayer?.websiteLink),
      tiktok: toNullableString(seasonPlayer?.tiktokLink),
      facebook: toNullableString(seasonPlayer?.facebookLink),
    },
    metrics: {
      ttblRank: toNullableNumber(player?.rank) ?? toNullableNumber(seasonPlayer?.rank),
      worldRank: toNullableNumber(seasonPlayer?.worldRank),
      qttrValue: toNullableNumber(seasonPlayer?.qttrValue),
      gameWins: toNullableNumber(player?.gameWins),
      gameLosses: toNullableNumber(player?.gameLosses),
      setWins: toNullableNumber(player?.setWins),
      setLosses: toNullableNumber(player?.setLosses),
      ballWins: toNullableNumber(player?.ballWins),
      ballLosses: toNullableNumber(player?.ballLosses),
    },
    sampleSize: {
      games: Array.isArray(player?.games) ? player.games.length : 0,
      homeGames: Array.isArray(player?.homeGames) ? player.homeGames.length : 0,
      awayGames: Array.isArray(player?.awayGames) ? player.awayGames.length : 0,
    },
  };
}

async function fetchTTBLPlayerProfile(
  sourcePlayerId: string,
  options: ProfileFetchOptions = {},
): Promise<TTBLPlayerProfile> {
  const url = `${TTBL_BASE_URL}/bundesliga/players/${sourcePlayerId}`;
  const html = await fetchText(url);
  const match = html.match(NEXT_DATA_REGEX);
  if (!match?.[1]) {
    throw new Error(`Missing __NEXT_DATA__ in TTBL player page for ${sourcePlayerId}`);
  }

  const payload = JSON.parse(match[1]) as NextDataPayload;
  const profile = extractProfileFromPayload(sourcePlayerId, payload);
  emit(
    options.onLog,
    `Fetched profile ${sourcePlayerId} (${profile.fullName}, season=${profile.seasonLabel ?? "unknown"}).`,
  );
  return profile;
}

export async function readTTBLPlayerProfiles(): Promise<TTBLProfilesMap> {
  return (await readJson<TTBLProfilesMap>(TTBL_PLAYER_PROFILES_FILE, {})) ?? {};
}

async function writeTTBLPlayerProfiles(profiles: TTBLProfilesMap): Promise<void> {
  await writeJson(TTBL_PLAYER_PROFILES_FILE, profiles);
}

export async function getTTBLPlayerProfile(
  sourcePlayerId: string,
  options: ProfileFetchOptions & { refresh?: boolean } = {},
): Promise<TTBLPlayerProfile | null> {
  const normalizedId = sourcePlayerId.trim();
  if (!normalizedId || normalizedId.startsWith("name:")) {
    return null;
  }

  const profiles = await readTTBLPlayerProfiles();
  if (!options.refresh && profiles[normalizedId]) {
    return profiles[normalizedId] ?? null;
  }

  const profile = await fetchTTBLPlayerProfile(normalizedId, options);
  profiles[normalizedId] = profile;
  await writeTTBLPlayerProfiles(profiles);
  return profile;
}

export async function hydrateTTBLPlayerProfiles(
  sourcePlayerIds: string[],
  options: HydrateProfilesOptions = {},
): Promise<TTBLProfilesHydrationResult> {
  const delayMs = options.delayMs ?? 120;
  const ids = [...new Set(sourcePlayerIds.map((value) => value.trim()))].filter(
    (value) => value.length > 0 && !value.startsWith("name:"),
  );

  if (ids.length === 0) {
    return {
      requested: 0,
      fetched: 0,
      cached: 0,
      failed: 0,
    };
  }

  const profiles = await readTTBLPlayerProfiles();

  let fetched = 0;
  let cached = 0;
  let failed = 0;
  for (const id of ids) {
    if (profiles[id]) {
      cached += 1;
      continue;
    }

    try {
      const profile = await fetchTTBLPlayerProfile(id, { onLog: options.onLog });
      profiles[id] = profile;
      fetched += 1;
    } catch (error) {
      failed += 1;
      emit(
        options.onLog,
        `Failed profile ${id}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  await writeTTBLPlayerProfiles(profiles);
  return {
    requested: ids.length,
    fetched,
    cached,
    failed,
  };
}
