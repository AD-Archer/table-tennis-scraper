import type { TtblPlayerProfile as TtblPlayerProfileRow } from "@prisma/client";
import { getPrismaClient } from "@/lib/db/prisma";
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

function getRequiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required for TTBL player profile storage.");
  }

  return prisma;
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

function toNullableInt(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value as number);
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

function toProfileFromRow(row: TtblPlayerProfileRow): TTBLPlayerProfile {
  return {
    sourcePlayerId: row.sourcePlayerId,
    stablePlayerId: row.stablePlayerId,
    seasonPlayerId: row.seasonPlayerId,
    fetchedAt: row.fetchedAt.toISOString(),
    fullName: row.fullName,
    firstName: row.firstName,
    lastName: row.lastName,
    nationality: row.nationality,
    nationalitySecondary: row.nationalitySecondary,
    birthdayUnix: row.birthdayUnix,
    heightCm: row.heightCm,
    weightKg: row.weightKg,
    hand: row.hand,
    racketPosture: row.racketPosture,
    role: row.role,
    currentClub: row.currentClub,
    outfitter: row.outfitter,
    outfitterWebsite: row.outfitterWebsite,
    seasonLabel: row.seasonLabel,
    imageUrl: row.imageUrl,
    actionImageUrl: row.actionImageUrl,
    cardImageUrl: row.cardImageUrl,
    social: {
      instagram: row.socialInstagram,
      youtube: row.socialYoutube,
      website: row.socialWebsite,
      tiktok: row.socialTiktok,
      facebook: row.socialFacebook,
    },
    metrics: {
      ttblRank: row.metricsTtblRank,
      worldRank: row.metricsWorldRank,
      qttrValue: row.metricsQttrValue,
      gameWins: row.metricsGameWins,
      gameLosses: row.metricsGameLosses,
      setWins: row.metricsSetWins,
      setLosses: row.metricsSetLosses,
      ballWins: row.metricsBallWins,
      ballLosses: row.metricsBallLosses,
    },
    sampleSize: {
      games: row.sampleGames,
      homeGames: row.sampleHomeGames,
      awayGames: row.sampleAwayGames,
    },
  };
}

async function upsertProfile(profile: TTBLPlayerProfile): Promise<void> {
  const prisma = getRequiredPrisma();
  await prisma.ttblPlayerProfile.upsert({
    where: { sourcePlayerId: profile.sourcePlayerId },
    create: {
      sourcePlayerId: profile.sourcePlayerId,
      stablePlayerId: profile.stablePlayerId,
      seasonPlayerId: profile.seasonPlayerId,
      fetchedAt: new Date(profile.fetchedAt),
      fullName: profile.fullName,
      firstName: profile.firstName,
      lastName: profile.lastName,
      nationality: profile.nationality,
      nationalitySecondary: profile.nationalitySecondary,
      birthdayUnix: toNullableInt(profile.birthdayUnix),
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      hand: profile.hand,
      racketPosture: profile.racketPosture,
      role: profile.role,
      currentClub: profile.currentClub,
      outfitter: profile.outfitter,
      outfitterWebsite: profile.outfitterWebsite,
      seasonLabel: profile.seasonLabel,
      imageUrl: profile.imageUrl,
      actionImageUrl: profile.actionImageUrl,
      cardImageUrl: profile.cardImageUrl,
      socialInstagram: profile.social.instagram,
      socialYoutube: profile.social.youtube,
      socialWebsite: profile.social.website,
      socialTiktok: profile.social.tiktok,
      socialFacebook: profile.social.facebook,
      metricsTtblRank: toNullableInt(profile.metrics.ttblRank),
      metricsWorldRank: toNullableInt(profile.metrics.worldRank),
      metricsQttrValue: toNullableInt(profile.metrics.qttrValue),
      metricsGameWins: toNullableInt(profile.metrics.gameWins),
      metricsGameLosses: toNullableInt(profile.metrics.gameLosses),
      metricsSetWins: toNullableInt(profile.metrics.setWins),
      metricsSetLosses: toNullableInt(profile.metrics.setLosses),
      metricsBallWins: toNullableInt(profile.metrics.ballWins),
      metricsBallLosses: toNullableInt(profile.metrics.ballLosses),
      sampleGames: profile.sampleSize.games,
      sampleHomeGames: profile.sampleSize.homeGames,
      sampleAwayGames: profile.sampleSize.awayGames,
    },
    update: {
      stablePlayerId: profile.stablePlayerId,
      seasonPlayerId: profile.seasonPlayerId,
      fetchedAt: new Date(profile.fetchedAt),
      fullName: profile.fullName,
      firstName: profile.firstName,
      lastName: profile.lastName,
      nationality: profile.nationality,
      nationalitySecondary: profile.nationalitySecondary,
      birthdayUnix: toNullableInt(profile.birthdayUnix),
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      hand: profile.hand,
      racketPosture: profile.racketPosture,
      role: profile.role,
      currentClub: profile.currentClub,
      outfitter: profile.outfitter,
      outfitterWebsite: profile.outfitterWebsite,
      seasonLabel: profile.seasonLabel,
      imageUrl: profile.imageUrl,
      actionImageUrl: profile.actionImageUrl,
      cardImageUrl: profile.cardImageUrl,
      socialInstagram: profile.social.instagram,
      socialYoutube: profile.social.youtube,
      socialWebsite: profile.social.website,
      socialTiktok: profile.social.tiktok,
      socialFacebook: profile.social.facebook,
      metricsTtblRank: toNullableInt(profile.metrics.ttblRank),
      metricsWorldRank: toNullableInt(profile.metrics.worldRank),
      metricsQttrValue: toNullableInt(profile.metrics.qttrValue),
      metricsGameWins: toNullableInt(profile.metrics.gameWins),
      metricsGameLosses: toNullableInt(profile.metrics.gameLosses),
      metricsSetWins: toNullableInt(profile.metrics.setWins),
      metricsSetLosses: toNullableInt(profile.metrics.setLosses),
      metricsBallWins: toNullableInt(profile.metrics.ballWins),
      metricsBallLosses: toNullableInt(profile.metrics.ballLosses),
      sampleGames: profile.sampleSize.games,
      sampleHomeGames: profile.sampleSize.homeGames,
      sampleAwayGames: profile.sampleSize.awayGames,
    },
  });
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
  const prisma = getRequiredPrisma();
  const rows = await prisma.ttblPlayerProfile.findMany({});
  const out: TTBLProfilesMap = {};
  for (const row of rows) {
    out[row.sourcePlayerId] = toProfileFromRow(row);
  }
  return out;
}

export async function getTTBLPlayerProfile(
  sourcePlayerId: string,
  options: ProfileFetchOptions & { refresh?: boolean } = {},
): Promise<TTBLPlayerProfile | null> {
  const normalizedId = sourcePlayerId.trim();
  if (!normalizedId || normalizedId.startsWith("name:")) {
    return null;
  }

  const prisma = getRequiredPrisma();
  if (!options.refresh) {
    const existing = await prisma.ttblPlayerProfile.findUnique({
      where: { sourcePlayerId: normalizedId },
    });
    if (existing) {
      return toProfileFromRow(existing);
    }
  }

  const profile = await fetchTTBLPlayerProfile(normalizedId, options);
  await upsertProfile(profile);
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

  const prisma = getRequiredPrisma();
  const existingRows = await prisma.ttblPlayerProfile.findMany({
    where: { sourcePlayerId: { in: ids } },
    select: { sourcePlayerId: true },
  });
  const existing = new Set(existingRows.map((row) => row.sourcePlayerId));

  let fetched = 0;
  let cached = 0;
  let failed = 0;
  for (const id of ids) {
    if (existing.has(id)) {
      cached += 1;
      continue;
    }

    try {
      const profile = await fetchTTBLPlayerProfile(id, { onLog: options.onLog });
      await upsertProfile(profile);
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

  return {
    requested: ids.length,
    fetched,
    cached,
    failed,
  };
}
