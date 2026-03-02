import { getPrismaClient } from "@/lib/db/prisma";
import { ensurePlayerRegistry } from "@/lib/players/registry";
import { getPlayerSlugOverview } from "@/lib/players/slugs";
import { getTTBLPlayerProfile, readTTBLPlayerProfiles } from "@/lib/ttbl/player-profiles";
import { fetchWTTPublicProfile, mergeWTTPublicProfile } from "@/lib/wtt/public-profile";
import {
  CanonicalPlayer,
  PlayerSlugMatchEntry,
  PlayerSlugRow,
  TTBLPlayerProfile,
  WTTPlayer,
} from "@/lib/types";

export interface PlayerSourceMemberDetail {
  source: "ttbl" | "wtt";
  sourceId: string;
  sourceKey: string;
  names: string[];
  seasons: string[];
  ttblProfile: TTBLPlayerProfile | null;
  wttProfile: WTTPlayer | null;
}

export interface PlayerDetailView {
  player: PlayerSlugRow;
  canonical: CanonicalPlayer;
  members: PlayerSourceMemberDetail[];
  allMatches: PlayerSlugMatchEntry[];
  opponentSlugBySourceId: Record<string, string>;
}

function parseSourceToken(token: string): { source: "ttbl" | "wtt"; sourceId: string } | null {
  const trimmed = token.trim();
  const delimiter = trimmed.indexOf(":");
  if (delimiter <= 0) {
    return null;
  }

  const source = trimmed.slice(0, delimiter);
  const sourceId = trimmed.slice(delimiter + 1).trim();
  if ((source !== "ttbl" && source !== "wtt") || !sourceId) {
    return null;
  }

  return { source, sourceId };
}

function createEmptyWTTPlayer(ittfId: string): WTTPlayer {
  return {
    ittf_id: ittfId,
    first_name: null,
    last_name: null,
    full_name: null,
    dob: null,
    nationality: null,
    team: null,
    country_name: null,
    organization_name: null,
    gender: null,
    age: null,
    handedness: null,
    style: null,
    world_ranking: null,
    world_ranking_points: null,
    headshot_url: null,
    stats: {
      matches_played: 0,
      wins: 0,
      losses: 0,
    },
    sources: [],
    last_seen: new Date().toISOString(),
  };
}

function fromWTTPlayerRow(row: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  dob: string | null;
  nationality: string | null;
  team: string | null;
  countryName: string | null;
  organizationName: string | null;
  gender: string | null;
  age: number | null;
  handedness: string | null;
  style: string | null;
  worldRanking: number | null;
  worldRankingPoints: number | null;
  headshotUrl: string | null;
  matchesPlayed: number;
  wins: number;
  losses: number;
  sources: string[];
  lastSeenAt: Date | null;
}): WTTPlayer {
  const gender =
    row.gender === "M" || row.gender === "W" || row.gender === "mixed" || row.gender === "unknown"
      ? row.gender
      : null;
  return {
    ittf_id: row.id,
    first_name: row.firstName,
    last_name: row.lastName,
    full_name: row.fullName,
    dob: row.dob,
    nationality: row.nationality,
    team: row.team,
    country_name: row.countryName,
    organization_name: row.organizationName,
    gender,
    age: row.age,
    handedness: row.handedness,
    style: row.style,
    world_ranking: row.worldRanking,
    world_ranking_points: row.worldRankingPoints,
    headshot_url: row.headshotUrl,
    stats: {
      matches_played: row.matchesPlayed,
      wins: row.wins,
      losses: row.losses,
    },
    sources: row.sources,
    last_seen: row.lastSeenAt?.toISOString() ?? new Date().toISOString(),
  };
}

async function upsertWTTProfiles(profiles: Record<string, WTTPlayer>): Promise<void> {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required for WTT player persistence.");
  }

  const rows = Object.values(profiles);
  for (const row of rows) {
    await prisma.wttPlayer.upsert({
      where: { id: row.ittf_id },
      create: {
        id: row.ittf_id,
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: row.full_name,
        dob: row.dob,
        nationality: row.nationality,
        team: row.team,
        countryName: row.country_name,
        organizationName: row.organization_name,
        gender: row.gender,
        age: row.age,
        handedness: row.handedness,
        style: row.style,
        worldRanking: row.world_ranking,
        worldRankingPoints: row.world_ranking_points,
        headshotUrl: row.headshot_url,
        matchesPlayed: row.stats.matches_played,
        wins: row.stats.wins,
        losses: row.stats.losses,
        sources: [...new Set(row.sources)],
        lastSeenAt: row.last_seen ? new Date(row.last_seen) : null,
      },
      update: {
        firstName: row.first_name,
        lastName: row.last_name,
        fullName: row.full_name,
        dob: row.dob,
        nationality: row.nationality,
        team: row.team,
        countryName: row.country_name,
        organizationName: row.organization_name,
        gender: row.gender,
        age: row.age,
        handedness: row.handedness,
        style: row.style,
        worldRanking: row.world_ranking,
        worldRankingPoints: row.world_ranking_points,
        headshotUrl: row.headshot_url,
        matchesPlayed: row.stats.matches_played,
        wins: row.stats.wins,
        losses: row.stats.losses,
        sources: [...new Set(row.sources)],
        lastSeenAt: row.last_seen ? new Date(row.last_seen) : null,
      },
    });
  }
}

function wttProfileNeedsHydration(profile: WTTPlayer | null): boolean {
  if (!profile) {
    return true;
  }

  if (profile.sources.includes("wtt_player_profile")) {
    return false;
  }

  return (
    !profile.dob ||
    !profile.country_name ||
    !profile.organization_name ||
    !profile.gender ||
    profile.age === null ||
    !profile.handedness ||
    profile.world_ranking === null
  );
}

export async function getPlayerDetailBySlug(slug: string): Promise<PlayerDetailView | null> {
  const targetSlug = slug.trim();
  if (!targetSlug) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("DATABASE_URL is required in Postgres mode.");
  }

  const [overview, registry, wttPlayerRows, ttblProfiles] = await Promise.all([
    getPlayerSlugOverview(Number.MAX_SAFE_INTEGER),
    ensurePlayerRegistry(),
    prisma.wttPlayer.findMany(),
    readTTBLPlayerProfiles(),
  ]);

  const player = overview.players.find((row) => row.slug === targetSlug);
  if (!player || !registry) {
    return null;
  }

  const canonical = registry.players.find((row) => row.canonicalKey === player.canonicalKey);
  if (!canonical) {
    return null;
  }

  const opponentSlugBySourceId: Record<string, string> = {};
  const ambiguousKeys = new Set<string>();
  for (const row of overview.players) {
    for (const token of row.sourceIds) {
      const parsed = parseSourceToken(token);
      if (!parsed || parsed.sourceId.startsWith("name:")) {
        continue;
      }

      const key = `${parsed.source}:${parsed.sourceId}`;
      const existing = opponentSlugBySourceId[key];
      if (existing && existing !== row.slug) {
        ambiguousKeys.add(key);
        delete opponentSlugBySourceId[key];
        continue;
      }

      if (!ambiguousKeys.has(key)) {
        opponentSlugBySourceId[key] = row.slug;
      }
    }
  }

  const members: PlayerSourceMemberDetail[] = [];
  const wttById = Object.fromEntries(
    wttPlayerRows.map((row) => [row.id, fromWTTPlayerRow(row)]),
  );
  const ttblById = { ...ttblProfiles };
  let wttProfilesChanged = false;

  for (const member of canonical.members) {
    let ttblProfile: TTBLPlayerProfile | null = null;
    let wttProfile: WTTPlayer | null = null;

    if (member.source === "ttbl") {
      const sourceId = member.sourceId.trim();
      if (!sourceId.startsWith("name:") && sourceId.length > 0) {
        ttblProfile = ttblById[sourceId] ?? null;
        if (!ttblProfile) {
          ttblProfile = await getTTBLPlayerProfile(sourceId);
          if (ttblProfile) {
            ttblById[sourceId] = ttblProfile;
          }
        }
      }
    } else if (member.source === "wtt") {
      const sourceId = member.sourceId.trim();
      let resolved = wttById[sourceId] ?? null;

      if (wttProfileNeedsHydration(resolved)) {
        const fetched = await fetchWTTPublicProfile(sourceId);
        if (fetched) {
          const target = resolved ?? createEmptyWTTPlayer(sourceId);
          if (mergeWTTPublicProfile(target, fetched)) {
            wttProfilesChanged = true;
          }
          target.last_seen = new Date().toISOString();
          wttById[sourceId] = target;
          resolved = target;
        }
      }

      wttProfile = resolved;
    }

    members.push({
      source: member.source,
      sourceId: member.sourceId,
      sourceKey: member.sourceKey,
      names: [...member.names],
      seasons: [...member.seasons],
      ttblProfile,
      wttProfile,
    });
  }

  if (wttProfilesChanged) {
    await upsertWTTProfiles(wttById);
  }

  return {
    player,
    canonical,
    members,
    allMatches: player.recentMatches,
    opponentSlugBySourceId,
  };
}
