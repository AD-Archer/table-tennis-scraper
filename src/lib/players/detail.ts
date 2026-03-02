import path from "node:path";
import { readJson, writeJson } from "@/lib/fs";
import { WTT_OUTPUT_DIR } from "@/lib/paths";
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

  const [overview, registry, wttPlayers, ttblProfiles] = await Promise.all([
    getPlayerSlugOverview(Number.MAX_SAFE_INTEGER),
    ensurePlayerRegistry(),
    readJson<Record<string, WTTPlayer>>(path.join(WTT_OUTPUT_DIR, "players.json"), {}),
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
  const wttById = wttPlayers ?? {};
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
    await writeJson(path.join(WTT_OUTPUT_DIR, "players.json"), wttById);
  }

  return {
    player,
    canonical,
    members,
    allMatches: player.recentMatches,
    opponentSlugBySourceId,
  };
}
