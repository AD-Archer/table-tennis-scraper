import {
  resolveCanonicalCountry,
  resolveCanonicalGender,
} from "@/lib/normalization/field-mapping";
import { getPrismaClient } from "@/lib/db/prisma";
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
} from "@/lib/types";

interface TTBLAggregate {
  matchesPlayed: number;
  wins: number;
  losses: number;
  seasons: Set<string>;
  leagueIds: Set<string>;
  leagueNames: Set<string>;
  recentMatches: PlayerSlugMatchEntry[];
}

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

function toNullableInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  return null;
}

type TTBLScoreSource = {
  homeSets?: number | null;
  awaySets?: number | null;
  set1HomeScore?: number | null;
  set1AwayScore?: number | null;
  set2HomeScore?: number | null;
  set2AwayScore?: number | null;
  set3HomeScore?: number | null;
  set3AwayScore?: number | null;
  set4HomeScore?: number | null;
  set4AwayScore?: number | null;
  set5HomeScore?: number | null;
  set5AwayScore?: number | null;
};

type TTBLGameRowCompat = TTBLScoreSource & {
  matchId: string;
  gameIndex: number;
  season: string;
  gameday: string;
  timestampMs: bigint;
  winnerSide: string | null;
  format: string | null;
  homePlayerId: string | null;
  homePlayerName: string | null;
  awayPlayerId: string | null;
  awayPlayerName: string | null;
};

function deriveTTBLSets(game: TTBLScoreSource): { home: number; away: number } | null {
  const homeSets = toNullableInt(game.homeSets);
  const awaySets = toNullableInt(game.awaySets);
  if (homeSets !== null && awaySets !== null) {
    return { home: homeSets, away: awaySets };
  }

  const setRows: Array<[number | null | undefined, number | null | undefined]> = [
    [game.set1HomeScore, game.set1AwayScore],
    [game.set2HomeScore, game.set2AwayScore],
    [game.set3HomeScore, game.set3AwayScore],
    [game.set4HomeScore, game.set4AwayScore],
    [game.set5HomeScore, game.set5AwayScore],
  ];

  let derivedHome = 0;
  let derivedAway = 0;
  let foundSetScore = false;
  for (const [homeScoreRaw, awayScoreRaw] of setRows) {
    const homeScore = toNullableInt(homeScoreRaw);
    const awayScore = toNullableInt(awayScoreRaw);
    if (homeScore === null || awayScore === null) {
      continue;
    }

    foundSetScore = true;
    if (homeScore > awayScore) {
      derivedHome += 1;
    } else if (awayScore > homeScore) {
      derivedAway += 1;
    }
  }

  if (!foundSetScore) {
    return null;
  }

  return { home: derivedHome, away: derivedAway };
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
  const prisma = getPrismaClient();
  if (!prisma) {
    return new Map();
  }

  const where = {
    isYouth: false,
    gameState: "Finished",
    homePlayerId: { not: null },
    awayPlayerId: { not: null },
  } as const;

  const selectWithScores = {
    matchId: true,
    gameIndex: true,
    season: true,
    gameday: true,
    timestampMs: true,
    winnerSide: true,
    format: true,
    homePlayerId: true,
    homePlayerName: true,
    awayPlayerId: true,
    awayPlayerName: true,
    homeSets: true,
    awaySets: true,
    set1HomeScore: true,
    set1AwayScore: true,
    set2HomeScore: true,
    set2AwayScore: true,
    set3HomeScore: true,
    set3AwayScore: true,
    set4HomeScore: true,
    set4AwayScore: true,
    set5HomeScore: true,
    set5AwayScore: true,
  } as const;

  const selectLegacy = {
    matchId: true,
    gameIndex: true,
    season: true,
    gameday: true,
    timestampMs: true,
    winnerSide: true,
    format: true,
    homePlayerId: true,
    homePlayerName: true,
    awayPlayerId: true,
    awayPlayerName: true,
  } as const;

  let games: TTBLGameRowCompat[] = [];
  try {
    games = (await prisma.ttblGame.findMany({
      where,
      select: selectWithScores,
    })) as TTBLGameRowCompat[];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/set\d(home|away)score|homesets|awaysets|column/i.test(message)) {
      throw error;
    }

    games = (await prisma.ttblGame.findMany({
      where,
      select: selectLegacy,
    })) as TTBLGameRowCompat[];
  }

  const map = new Map<string, TTBLAggregate>();

  for (const game of games) {
    if (game.format === "doubles") {
      continue;
    }

    const homeId = game.homePlayerId?.trim() ?? "";
    const awayId = game.awayPlayerId?.trim() ?? "";
    if (!homeId || !awayId) {
      continue;
    }

    const occurredAt = toIsoFromUnixSeconds(Number(game.timestampMs));
    const sets = deriveTTBLSets(game);
    const homeScore = sets ? `${sets.home}-${sets.away}` : null;
    const awayScore = sets ? `${sets.away}-${sets.home}` : null;

    const home = map.get(homeId) ?? {
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      seasons: new Set<string>(),
      leagueIds: new Set<string>(),
      leagueNames: new Set<string>(),
      recentMatches: [],
    };
    home.matchesPlayed += 1;
    if (game.winnerSide === "Home") {
      home.wins += 1;
    } else if (game.winnerSide === "Away") {
      home.losses += 1;
    }
    home.seasons.add(game.season);
    home.recentMatches = pushUniqueRecentMatches(home.recentMatches, [
      {
        source: "ttbl",
        matchId: `${game.matchId}:${game.gameIndex}`,
        occurredAt,
        seasonOrYear: game.season,
        event: game.gameday,
        opponent: game.awayPlayerName,
        opponentSourceId: awayId,
        score: homeScore,
        outcome:
          game.winnerSide === "Home" ? "W" : game.winnerSide === "Away" ? "L" : null,
      },
    ]);
    map.set(homeId, home);

    const away = map.get(awayId) ?? {
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      seasons: new Set<string>(),
      leagueIds: new Set<string>(),
      leagueNames: new Set<string>(),
      recentMatches: [],
    };
    away.matchesPlayed += 1;
    if (game.winnerSide === "Away") {
      away.wins += 1;
    } else if (game.winnerSide === "Home") {
      away.losses += 1;
    }
    away.seasons.add(game.season);
    away.recentMatches = pushUniqueRecentMatches(away.recentMatches, [
      {
        source: "ttbl",
        matchId: `${game.matchId}:${game.gameIndex}`,
        occurredAt,
        seasonOrYear: game.season,
        event: game.gameday,
        opponent: game.homePlayerName,
        opponentSourceId: homeId,
        score: awayScore,
        outcome:
          game.winnerSide === "Away" ? "W" : game.winnerSide === "Home" ? "L" : null,
      },
    ]);
    map.set(awayId, away);
  }

  return map;
}

async function collectWTTAggregates(): Promise<Map<string, WTTAggregate>> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return new Map();
  }

  const [players, matches] = await Promise.all([
    prisma.wttPlayer.findMany(),
    prisma.wttMatch.findMany({
      where: { isYouth: false },
      select: {
        id: true,
        year: true,
        tournament: true,
        event: true,
        playerAId: true,
        playerAName: true,
        playerXId: true,
        playerXName: true,
        finalSetsA: true,
        finalSetsX: true,
        winnerInferred: true,
      },
    }),
  ]);

  const map = new Map<string, WTTAggregate>();

  for (const row of players) {
    map.set(row.id, {
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      nationality: row.nationality,
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

    const aId = match.playerAId?.trim();
    const xId = match.playerXId?.trim();
    if (!aId || !xId) {
      continue;
    }

    const year = Number.isFinite(match.year) ? String(match.year) : null;
    const occurredAt = toIsoFromYear(year);
    const scoreA = `${match.finalSetsA}-${match.finalSetsX}`;
    const scoreX = `${match.finalSetsX}-${match.finalSetsA}`;
    const gender = inferWTTEventGender(match.event ?? null);

    const a =
      map.get(aId) ??
      ({
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        nationality: null,
        profileGender: "unknown",
        genderCounts: { M: 0, W: 0, mixed: 0, unknown: 0 },
        recentMatches: [],
      } as WTTAggregate);
    a.matchesPlayed += 1;
    if (match.winnerInferred === "A") {
      a.wins += 1;
    } else if (match.winnerInferred === "X") {
      a.losses += 1;
    }
    a.genderCounts[gender] += 1;
    a.recentMatches = pushUniqueRecentMatches(a.recentMatches, [
      {
        source: "wtt",
        matchId: match.id,
        occurredAt,
        seasonOrYear: year,
        event: match.event ?? match.tournament ?? null,
        opponent: match.playerXName ?? xId,
        opponentSourceId: xId,
        score: scoreA,
        outcome:
          match.winnerInferred === "A" ? "W" : match.winnerInferred === "X" ? "L" : null,
      },
    ]);
    map.set(aId, a);

    const x =
      map.get(xId) ??
      ({
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        nationality: null,
        profileGender: "unknown",
        genderCounts: { M: 0, W: 0, mixed: 0, unknown: 0 },
        recentMatches: [],
      } as WTTAggregate);
    x.matchesPlayed += 1;
    if (match.winnerInferred === "X") {
      x.wins += 1;
    } else if (match.winnerInferred === "A") {
      x.losses += 1;
    }
    x.genderCounts[gender] += 1;
    x.recentMatches = pushUniqueRecentMatches(x.recentMatches, [
      {
        source: "wtt",
        matchId: match.id,
        occurredAt,
        seasonOrYear: year,
        event: match.event ?? match.tournament ?? null,
        opponent: match.playerAName ?? aId,
        opponentSourceId: aId,
        score: scoreX,
        outcome:
          match.winnerInferred === "X" ? "W" : match.winnerInferred === "A" ? "L" : null,
      },
    ]);
    map.set(xId, x);
  }

  return map;
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

function resolveWTTGenderForCanonicalPlayer(
  player: CanonicalPlayer,
  wttById: Map<string, WTTAggregate>,
): PlayerGender {
  let wttProfileGender: PlayerGender = "unknown";
  const genderCounts: Record<PlayerGender, number> = {
    M: 0,
    W: 0,
    mixed: 0,
    unknown: 0,
  };

  for (const member of player.members) {
    if (member.source !== "wtt") {
      continue;
    }

    const wtt = wttById.get(member.sourceId);
    if (!wtt) {
      continue;
    }

    if (wttProfileGender === "unknown" && wtt.profileGender !== "unknown") {
      wttProfileGender = wtt.profileGender;
    }

    for (const key of Object.keys(genderCounts) as PlayerGender[]) {
      genderCounts[key] += wtt.genderCounts[key];
    }
  }

  const eventInferredGender = inferGenderFromCounts(genderCounts);
  if (eventInferredGender !== "unknown") {
    return eventInferredGender;
  }

  return wttProfileGender;
}

function buildTTBLLeagueGenderMap(
  players: CanonicalPlayer[],
  ttblById: Map<string, TTBLAggregate>,
  wttById: Map<string, WTTAggregate>,
): Map<string, PlayerGender> {
  const votes = new Map<string, { M: number; W: number }>();

  for (const player of players) {
    const wttGender = resolveWTTGenderForCanonicalPlayer(player, wttById);
    if (wttGender !== "M" && wttGender !== "W") {
      continue;
    }

    const leagueIds = new Set<string>();
    for (const member of player.members) {
      if (member.source !== "ttbl" || member.sourceId.startsWith("name:")) {
        continue;
      }

      const ttbl = ttblById.get(member.sourceId);
      if (!ttbl) {
        continue;
      }

      for (const leagueId of ttbl.leagueIds) {
        leagueIds.add(leagueId);
      }
    }

    for (const leagueId of leagueIds) {
      const row = votes.get(leagueId) ?? { M: 0, W: 0 };
      if (wttGender === "M") {
        row.M += 1;
      } else {
        row.W += 1;
      }
      votes.set(leagueId, row);
    }
  }

  const out = new Map<string, PlayerGender>();
  for (const [leagueId, row] of votes.entries()) {
    const inferred =
      row.M > 0 && row.W > 0 ? "mixed" : row.M > 0 ? "M" : row.W > 0 ? "W" : "unknown";
    out.set(leagueId, inferred);
  }

  return out;
}

function combineCanonicalRow(
  player: CanonicalPlayer,
  ttblById: Map<string, TTBLAggregate>,
  wttById: Map<string, WTTAggregate>,
  ttblProfilesById: Record<string, { nationality: string | null }>,
  mergeMap: Map<string, PlayerSlugCandidateEntry[]>,
  ttblLeagueGenderById: Map<string, PlayerGender>,
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
  const ttblLeagueIds = new Set<string>();
  const ttblLeagueNames = new Set<string>();
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
        for (const leagueId of ttbl.leagueIds) {
          ttblLeagueIds.add(leagueId);
        }
        for (const leagueName of ttbl.leagueNames) {
          ttblLeagueNames.add(leagueName);
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
  const ttblInferredGender = ttblLeagueIds.size > 0 || ttblLeagueNames.size > 0
    ? ttblLeagueIds.size > 0
      ? [...ttblLeagueIds]
          .map((leagueId) => ttblLeagueGenderById.get(leagueId) ?? "unknown")
          .find((value) => value === "M" || value === "W") ?? "unknown"
      : "unknown"
    : "unknown";
  const { country, source: countrySource } = resolveCanonicalCountry({
    wttNationality: wttCountry,
    ttblNationality: ttblCountry,
  });
  const { gender, source: genderSource } = resolveCanonicalGender({
    eventInferredGender: inferredGender,
    wttProfileGender,
    ttblInferredGender,
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
  const ttblLeagueGenderById = buildTTBLLeagueGenderMap(registry.players, ttblById, wttById);

  const players = registry.players
    .map((player) =>
      combineCanonicalRow(
        player,
        ttblById,
        wttById,
        ttblProfilesById,
        mergeMap,
        ttblLeagueGenderById,
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
