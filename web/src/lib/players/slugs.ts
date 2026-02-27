import path from "node:path";
import { promises as fs } from "node:fs";
import { readJson } from "@/lib/fs";
import {
  resolveCanonicalCountry,
  resolveCanonicalGender,
} from "@/lib/normalization/field-mapping";
import { TTBL_SEASONS_DIR, WTT_OUTPUT_DIR, getTTBLReadDir } from "@/lib/paths";
import { ensurePlayerRegistry } from "@/lib/players/registry";
import { readTTBLPlayerProfiles } from "@/lib/ttbl/player-profiles";
import { inferWTTEventGender, isWTTGenderedSinglesEvent } from "@/lib/wtt/events";
import {
  CanonicalPlayer,
  PlayerMergeCandidate,
  PlayerGender,
  PlayerSlugCandidateEntry,
  PlayerSlugMatchEntry,
  PlayerSlugOverview,
  PlayerSlugRow,
  TTBLGameRecord,
  TTBLMetadata,
  WTTMatch,
  WTTPlayer,
} from "@/lib/types";

interface TTBLAggregate {
  matchesPlayed: number;
  wins: number;
  losses: number;
  seasons: Set<string>;
  recentMatches: PlayerSlugMatchEntry[];
}

interface TTBLGameScoreRow {
  homeSets: number | null;
  awaySets: number | null;
}

type TTBLMatchGameScoreMap = Map<number, TTBLGameScoreRow>;

interface WTTAggregate {
  matchesPlayed: number;
  wins: number;
  losses: number;
  nationality: string | null;
  profileGender: PlayerGender;
  genderCounts: Record<PlayerGender, number>;
  recentMatches: PlayerSlugMatchEntry[];
}

function parseSeasonStart(season: string): number {
  return Number.parseInt(season.split("-")[0] ?? "0", 10) || 0;
}

async function listSeasonDirectories(): Promise<string[]> {
  try {
    const rows = await fs.readdir(TTBL_SEASONS_DIR, { withFileTypes: true });
    return rows
      .filter((row) => row.isDirectory())
      .map((row) => row.name)
      .sort((a, b) => parseSeasonStart(b) - parseSeasonStart(a));
  } catch {
    return [];
  }
}

function toIsoFromUnixSeconds(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

function toIsoFromYear(value: string | null): string | null {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(Date.UTC(parsed, 0, 1)).toISOString();
}

function toSortableTimestamp(iso: string | null): number {
  if (!iso) {
    return 0;
  }

  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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

function toScoreString(left: number | null, right: number | null): string | null {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return null;
  }

  return `${left}-${right}`;
}

function inferWinnerSideFromSets(
  homeSets: number | null,
  awaySets: number | null,
): "Home" | "Away" | null {
  if (!Number.isFinite(homeSets) || !Number.isFinite(awaySets)) {
    return null;
  }

  const home = Number(homeSets);
  const away = Number(awaySets);
  if (home === away) {
    return null;
  }

  return home > away ? "Home" : "Away";
}

async function loadTTBLMatchGameScores(
  seasonDir: string,
  matchId: string,
  cache: Map<string, TTBLMatchGameScoreMap>,
): Promise<TTBLMatchGameScoreMap> {
  const cached = cache.get(matchId);
  if (cached) {
    return cached;
  }

  const payload =
    (await readJson<Record<string, unknown>>(
      path.join(seasonDir, "matches", `match_${matchId}.json`),
      null,
    )) ?? null;
  const games = Array.isArray(payload?.games) ? payload.games : [];
  const rows: TTBLMatchGameScoreMap = new Map();

  for (const rawGame of games) {
    const game = asRecord(rawGame);
    if (!game) {
      continue;
    }

    const gameIndex = toNullableNumber(game.index);
    if (gameIndex === null || !Number.isFinite(gameIndex)) {
      continue;
    }

    rows.set(Math.trunc(gameIndex), {
      homeSets: toNullableNumber(game.homeSets),
      awaySets: toNullableNumber(game.awaySets),
    });
  }

  cache.set(matchId, rows);
  return rows;
}

function inferGenderFromCounts(counts: Record<PlayerGender, number>): PlayerGender {
  if (counts.mixed > 0 || (counts.M > 0 && counts.W > 0)) {
    return "mixed";
  }

  if (counts.M > 0) {
    return "M";
  }

  if (counts.W > 0) {
    return "W";
  }

  return "unknown";
}

function pushUniqueRecentMatches(
  source: PlayerSlugMatchEntry[],
  incoming: PlayerSlugMatchEntry[],
): PlayerSlugMatchEntry[] {
  const dedupe = new Map<string, PlayerSlugMatchEntry>();

  for (const row of [...source, ...incoming]) {
    const key = `${row.source}:${row.matchId}`;
    if (!dedupe.has(key)) {
      dedupe.set(key, row);
    }
  }

  return [...dedupe.values()].sort(
    (a, b) =>
      toSortableTimestamp(b.occurredAt) - toSortableTimestamp(a.occurredAt) ||
      a.matchId.localeCompare(b.matchId),
  );
}

function buildSlug(displayName: string, canonicalKey: string): string {
  const nameSlug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const keySlug = canonicalKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-8);

  if (nameSlug && keySlug) {
    return `${nameSlug}-${keySlug}`;
  }

  return nameSlug || keySlug || "unknown-player";
}

function buildCandidateMap(
  candidates: PlayerMergeCandidate[],
): Map<string, PlayerSlugCandidateEntry[]> {
  const map = new Map<string, PlayerSlugCandidateEntry[]>();

  for (const candidate of candidates) {
    const leftRows = map.get(candidate.leftCanonicalKey) ?? [];
    leftRows.push({
      otherCanonicalKey: candidate.rightCanonicalKey,
      otherName: candidate.rightName,
      reason: candidate.reason,
    });
    map.set(candidate.leftCanonicalKey, leftRows);

    const rightRows = map.get(candidate.rightCanonicalKey) ?? [];
    rightRows.push({
      otherCanonicalKey: candidate.leftCanonicalKey,
      otherName: candidate.leftName,
      reason: candidate.reason,
    });
    map.set(candidate.rightCanonicalKey, rightRows);
  }

  for (const [key, rows] of map.entries()) {
    map.set(
      key,
      rows.sort(
        (a, b) =>
          a.reason.localeCompare(b.reason) ||
          a.otherName.localeCompare(b.otherName) ||
          a.otherCanonicalKey.localeCompare(b.otherCanonicalKey),
      ),
    );
  }

  return map;
}

async function collectTTBLAggregates(): Promise<Map<string, TTBLAggregate>> {
  const map = new Map<string, TTBLAggregate>();
  const seasonDirs = new Map<string, string>();

  const seasons = await listSeasonDirectories();
  for (const season of seasons) {
    seasonDirs.set(path.join(TTBL_SEASONS_DIR, season), season);
  }

  const currentDir = getTTBLReadDir();
  const currentMeta = await readJson<TTBLMetadata>(
    path.join(currentDir, "metadata.json"),
    null,
  );
  if (currentMeta?.season) {
    seasonDirs.set(currentDir, currentMeta.season);
  }

  for (const [seasonDir, season] of seasonDirs.entries()) {
    const games =
      (await readJson<TTBLGameRecord[]>(
        path.join(seasonDir, "stats", "games_data.json"),
        [],
      )) ?? [];
    const gameScoresByMatch = new Map<string, TTBLMatchGameScoreMap>();
    for (const game of games) {
      if (
        game.format === "doubles" ||
        game.gameState !== "Finished" ||
        !game.homePlayer.id ||
        !game.awayPlayer.id
      ) {
        continue;
      }

      const occurredAt = toIsoFromUnixSeconds(game.timestamp ?? 0);
      const matchGameScores = await loadTTBLMatchGameScores(
        seasonDir,
        game.matchId,
        gameScoresByMatch,
      );
      const matchGameScore = matchGameScores.get(game.gameIndex);
      const resolvedWinnerSide =
        game.winnerSide ??
        inferWinnerSideFromSets(
          matchGameScore?.homeSets ?? null,
          matchGameScore?.awaySets ?? null,
        );
      const homeScore = toScoreString(matchGameScore?.homeSets ?? null, matchGameScore?.awaySets ?? null);
      const awayScore = toScoreString(matchGameScore?.awaySets ?? null, matchGameScore?.homeSets ?? null);

      const home = map.get(game.homePlayer.id) ?? {
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        seasons: new Set<string>(),
        recentMatches: [],
      };
      home.matchesPlayed += 1;
      if (resolvedWinnerSide === "Home") {
        home.wins += 1;
      } else if (resolvedWinnerSide === "Away") {
        home.losses += 1;
      }
      home.seasons.add(season);
      home.recentMatches = pushUniqueRecentMatches(home.recentMatches, [
        {
          source: "ttbl",
          matchId: `${game.matchId}:${game.gameIndex}`,
          occurredAt,
          seasonOrYear: season,
          event: game.gameday ?? null,
          opponent: game.awayPlayer.name ?? null,
          opponentSourceId: game.awayPlayer.id ?? null,
          score: homeScore,
          outcome:
            resolvedWinnerSide === "Home"
              ? "W"
              : resolvedWinnerSide === "Away"
                ? "L"
                : null,
        },
      ]);
      map.set(game.homePlayer.id, home);

      const away = map.get(game.awayPlayer.id) ?? {
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        seasons: new Set<string>(),
        recentMatches: [],
      };
      away.matchesPlayed += 1;
      if (resolvedWinnerSide === "Away") {
        away.wins += 1;
      } else if (resolvedWinnerSide === "Home") {
        away.losses += 1;
      }
      away.seasons.add(season);
      away.recentMatches = pushUniqueRecentMatches(away.recentMatches, [
        {
          source: "ttbl",
          matchId: `${game.matchId}:${game.gameIndex}`,
          occurredAt,
          seasonOrYear: season,
          event: game.gameday ?? null,
          opponent: game.homePlayer.name ?? null,
          opponentSourceId: game.homePlayer.id ?? null,
          score: awayScore,
          outcome:
            resolvedWinnerSide === "Away"
              ? "W"
              : resolvedWinnerSide === "Home"
                ? "L"
                : null,
        },
      ]);
      map.set(game.awayPlayer.id, away);
    }
  }

  return map;
}

async function collectWTTAggregates(): Promise<Map<string, WTTAggregate>> {
  const map = new Map<string, WTTAggregate>();
  const players =
    (await readJson<Record<string, WTTPlayer>>(
      path.join(WTT_OUTPUT_DIR, "players.json"),
      {},
    )) ?? {};
  const matches =
    (await readJson<WTTMatch[]>(path.join(WTT_OUTPUT_DIR, "matches.json"), [])) ?? [];

  for (const [ittfId, row] of Object.entries(players)) {
    map.set(ittfId, {
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      nationality: row.nationality ?? null,
      profileGender:
        row.gender === "M" || row.gender === "W" || row.gender === "mixed"
          ? row.gender
          : "unknown",
      genderCounts: { M: 0, W: 0, mixed: 0, unknown: 0 },
      recentMatches: [],
    });
  }

  for (const match of matches) {
    if (!isWTTGenderedSinglesEvent(match.event)) {
      continue;
    }

    const aId = match.players.a.ittf_id?.trim();
    const xId = match.players.x.ittf_id?.trim();
    if (!aId || !xId) {
      continue;
    }

    const year = match.year?.trim() ?? null;
    const occurredAt = toIsoFromYear(year);
    const scoreA = `${match.final_sets.a}-${match.final_sets.x}`;
    const scoreX = `${match.final_sets.x}-${match.final_sets.a}`;
    const gender = inferWTTEventGender(match.event ?? null);

    if (aId) {
      const aggregate =
        map.get(aId) ??
        ({
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          nationality: match.players.a.association ?? null,
          profileGender: "unknown",
          genderCounts: { M: 0, W: 0, mixed: 0, unknown: 0 },
          recentMatches: [],
        } as WTTAggregate);
      aggregate.matchesPlayed += 1;
      if (match.winner_inferred === "A") {
        aggregate.wins += 1;
      } else if (match.winner_inferred === "X") {
        aggregate.losses += 1;
      }
      aggregate.genderCounts[gender] += 1;
      aggregate.recentMatches = pushUniqueRecentMatches(aggregate.recentMatches, [
        {
          source: "wtt",
          matchId: match.match_id,
          occurredAt,
          seasonOrYear: year,
          event: match.event ?? match.tournament ?? null,
          opponent: match.players.x.name ?? xId ?? null,
          opponentSourceId: xId ?? null,
          score: scoreA,
          outcome:
            match.winner_inferred === "A"
              ? "W"
              : match.winner_inferred === "X"
                ? "L"
                : null,
        },
      ]);
      map.set(aId, aggregate);
    }

    if (xId) {
      const aggregate =
        map.get(xId) ??
        ({
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          nationality: match.players.x.association ?? null,
          profileGender: "unknown",
          genderCounts: { M: 0, W: 0, mixed: 0, unknown: 0 },
          recentMatches: [],
        } as WTTAggregate);
      aggregate.matchesPlayed += 1;
      if (match.winner_inferred === "X") {
        aggregate.wins += 1;
      } else if (match.winner_inferred === "A") {
        aggregate.losses += 1;
      }
      aggregate.genderCounts[gender] += 1;
      aggregate.recentMatches = pushUniqueRecentMatches(aggregate.recentMatches, [
        {
          source: "wtt",
          matchId: match.match_id,
          occurredAt,
          seasonOrYear: year,
          event: match.event ?? match.tournament ?? null,
          opponent: match.players.a.name ?? aId ?? null,
          opponentSourceId: aId ?? null,
          score: scoreX,
          outcome:
            match.winner_inferred === "X"
              ? "W"
              : match.winner_inferred === "A"
                ? "L"
                : null,
        },
      ]);
      map.set(xId, aggregate);
    }
  }

  return map;
}

function combineCanonicalRow(
  player: CanonicalPlayer,
  ttblById: Map<string, TTBLAggregate>,
  wttById: Map<string, WTTAggregate>,
  ttblProfilesById: Record<string, { nationality: string | null }>,
  mergeMap: Map<string, PlayerSlugCandidateEntry[]>,
  maxRecentMatches: number,
): PlayerSlugRow {
  let matchesPlayed = 0;
  let wins = 0;
  let losses = 0;
  let ttblCountry: string | null = null;
  let wttCountry: string | null = null;
  const seasons = new Set<string>();
  const sources = new Set<"ttbl" | "wtt">();
  const sourceIds: string[] = [];
  const recentMatches: PlayerSlugMatchEntry[] = [];
  let hasTTBLMember = false;
  let wttProfileGender: PlayerGender = "unknown";
  const genderCounts: Record<PlayerGender, number> = {
    M: 0,
    W: 0,
    mixed: 0,
    unknown: 0,
  };

  for (const member of player.members) {
    sources.add(member.source);
    sourceIds.push(`${member.source}:${member.sourceId}`);
    for (const season of member.seasons) {
      seasons.add(season);
    }

    if (member.source === "ttbl" && !member.sourceId.startsWith("name:")) {
      hasTTBLMember = true;
      if (!ttblCountry) {
        ttblCountry = ttblProfilesById[member.sourceId]?.nationality ?? null;
      }

      const ttbl = ttblById.get(member.sourceId);
      if (ttbl) {
        matchesPlayed += ttbl.matchesPlayed;
        wins += ttbl.wins;
        losses += ttbl.losses;
        for (const season of ttbl.seasons) {
          seasons.add(season);
        }
        recentMatches.push(...ttbl.recentMatches);
      }
    }

    if (member.source === "wtt") {
      const wtt = wttById.get(member.sourceId);
      if (wtt) {
        matchesPlayed += wtt.matchesPlayed;
        wins += wtt.wins;
        losses += wtt.losses;
        if (!wttCountry && wtt.nationality) {
          wttCountry = wtt.nationality;
        }
        if (wttProfileGender === "unknown" && wtt.profileGender !== "unknown") {
          wttProfileGender = wtt.profileGender;
        }
        recentMatches.push(...wtt.recentMatches);
        for (const key of Object.keys(genderCounts) as PlayerGender[]) {
          genderCounts[key] += wtt.genderCounts[key];
        }
      }
    }
  }

  const mergedRecent = pushUniqueRecentMatches([], recentMatches).slice(0, maxRecentMatches);
  const mergeCandidates = mergeMap.get(player.canonicalKey) ?? [];
  const inferredGender = inferGenderFromCounts(genderCounts);
  const { country, source: countrySource } = resolveCanonicalCountry({
    wttNationality: wttCountry,
    ttblNationality: ttblCountry,
  });
  const { gender, source: genderSource } = resolveCanonicalGender({
    eventInferredGender: inferredGender,
    wttProfileGender,
    hasTTBLMember,
  });
  const winRate =
    matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 1000) / 10 : null;

  return {
    slug: buildSlug(player.displayName, player.canonicalKey),
    canonicalKey: player.canonicalKey,
    displayName: player.displayName,
    sourceCount: player.sourceCount,
    memberCount: player.memberCount,
    sources: [...sources].sort((a, b) => a.localeCompare(b)),
    sourceIds: sourceIds.sort((a, b) => a.localeCompare(b)),
    seasons: [...seasons].sort((a, b) => parseSeasonStart(b) - parseSeasonStart(a)),
    country,
    countrySource,
    gender,
    genderSource,
    matchesPlayed,
    wins,
    losses,
    winRate,
    mergeCandidates,
    recentMatches: mergedRecent,
  };
}

export async function getPlayerSlugOverview(
  maxRecentMatches = 8,
): Promise<PlayerSlugOverview> {
  const registry = await ensurePlayerRegistry();

  if (!registry) {
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        players: 0,
        withMergeCandidates: 0,
        withKnownGender: 0,
      },
      players: [],
    };
  }

  const [ttblById, wttById, ttblProfilesById] = await Promise.all([
    collectTTBLAggregates(),
    collectWTTAggregates(),
    readTTBLPlayerProfiles(),
  ]);
  const mergeMap = buildCandidateMap(registry.mergeCandidates);

  const players = registry.players
    .map((player) =>
      combineCanonicalRow(
        player,
        ttblById,
        wttById,
        ttblProfilesById,
        mergeMap,
        maxRecentMatches,
      ),
    )
    .sort(
      (a, b) =>
        b.matchesPlayed - a.matchesPlayed ||
        b.mergeCandidates.length - a.mergeCandidates.length ||
        a.displayName.localeCompare(b.displayName),
    );

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      players: players.length,
      withMergeCandidates: players.filter((row) => row.mergeCandidates.length > 0).length,
      withKnownGender: players.filter((row) => row.gender !== "unknown").length,
    },
    players,
  };
}
