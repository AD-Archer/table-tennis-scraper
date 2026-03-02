import { getDataStoreMode, shouldUsePostgres } from "@/lib/db/config";
import { getPrismaClient } from "@/lib/db/prisma";
import { TTBLGameRecord, TTBLMatchSummary, TTBLMetadata, TTBLPlayerStats, WTTMatch, WTTPlayer } from "@/lib/types";

const CHUNK_SIZE = 250;
const UPSERT_CONCURRENCY = 12;

interface TTBLSnapshotInput {
  metadata: TTBLMetadata;
  matchSummaries: TTBLMatchSummary[];
  gamesData: TTBLGameRecord[];
  uniquePlayers: Array<{
    id?: string;
    firstName?: string;
    lastName?: string;
    imageUrl?: string;
  }>;
  playerStatsFinal: TTBLPlayerStats[];
  onLog?: (message: string) => void;
}

interface WTTSnapshotInput {
  years: number[];
  players: WTTPlayer[];
  matches: WTTMatch[];
  onLog?: (message: string) => void;
}

function emit(log: ((message: string) => void) | undefined, message: string): void {
  if (!log) {
    return;
  }

  const timestamp = new Date().toISOString();
  log(`[${timestamp}] [DB] ${message}`);
}

function chunk<T>(rows: T[], size: number): T[][] {
  if (rows.length === 0) {
    return [];
  }

  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

async function runWithConcurrency<T>(
  rows: T[],
  limit: number,
  task: (row: T) => Promise<void>,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, rows.length)) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= rows.length) {
        return;
      }

      const row = rows[index];
      if (!row) {
        continue;
      }

      await task(row);
    }
  });

  await Promise.all(workers);
}

function resolveOptionalClient() {
  const mode = getDataStoreMode();
  if (!shouldUsePostgres(mode)) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma && mode === "postgres") {
    throw new Error("Postgres mode enabled but Prisma client is unavailable.");
  }

  return prisma;
}

function toBigIntMs(value: number | null | undefined): bigint {
  if (!Number.isFinite(value)) {
    return BigInt(0);
  }

  return BigInt(Math.trunc(value as number));
}

function toDateOrNull(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toYearInt(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function persistTTBLSnapshotToDb(input: TTBLSnapshotInput): Promise<void> {
  const prisma = resolveOptionalClient();
  if (!prisma) {
    return;
  }

  const season = input.metadata.season;
  emit(input.onLog, `Persisting TTBL season ${season} to relational tables.`);

  await prisma.$transaction([
    prisma.ttblGame.deleteMany({ where: { season } }),
    prisma.ttblMatch.deleteMany({ where: { season } }),
    prisma.ttblPlayerSeasonStat.deleteMany({ where: { season } }),
  ]);

  const playersById = new Map<string, { id: string; firstName: string | null; lastName: string | null; fullName: string | null; imageUrl: string | null }>();
  for (const player of input.uniquePlayers) {
    const id = (player.id ?? "").trim();
    if (!id) {
      continue;
    }

    const firstName = (player.firstName ?? "").trim() || null;
    const lastName = (player.lastName ?? "").trim() || null;
    const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim() || null;
    const current = playersById.get(id);
    if (!current) {
      playersById.set(id, {
        id,
        firstName,
        lastName,
        fullName,
        imageUrl: (player.imageUrl ?? "").trim() || null,
      });
      continue;
    }

    if (!current.firstName && firstName) {
      current.firstName = firstName;
    }
    if (!current.lastName && lastName) {
      current.lastName = lastName;
    }
    if (!current.fullName && fullName) {
      current.fullName = fullName;
    }
    if (!current.imageUrl && player.imageUrl) {
      current.imageUrl = player.imageUrl;
    }
  }

  await runWithConcurrency(
    [...playersById.values()],
    UPSERT_CONCURRENCY,
    async (row) => {
      await prisma.ttblPlayer.upsert({
        where: { id: row.id },
        create: {
          id: row.id,
          firstName: row.firstName,
          lastName: row.lastName,
          fullName: row.fullName,
          imageUrl: row.imageUrl,
        },
        update: {
          firstName: row.firstName,
          lastName: row.lastName,
          fullName: row.fullName,
          imageUrl: row.imageUrl,
        },
      });
    },
  );

  const matchRows = input.matchSummaries.map((match) => ({
    id: match.matchId,
    season,
    gameday: match.gameday,
    timestampMs: toBigIntMs(match.timestamp),
    matchState: match.matchState,
    isYouth: Boolean(match.isYouth),
    homeTeamId: match.homeTeam.id || null,
    homeTeamName: match.homeTeam.name || null,
    homeTeamRank: Number.isFinite(match.homeTeam.rank) ? match.homeTeam.rank : null,
    homeGameWins: Number.isFinite(match.homeTeam.gameWins) ? match.homeTeam.gameWins : null,
    homeSetWins: Number.isFinite(match.homeTeam.setWins) ? match.homeTeam.setWins : null,
    awayTeamId: match.awayTeam.id || null,
    awayTeamName: match.awayTeam.name || null,
    awayTeamRank: Number.isFinite(match.awayTeam.rank) ? match.awayTeam.rank : null,
    awayGameWins: Number.isFinite(match.awayTeam.gameWins) ? match.awayTeam.gameWins : null,
    awaySetWins: Number.isFinite(match.awayTeam.setWins) ? match.awayTeam.setWins : null,
    gamesCount: match.gamesCount,
    venue: match.venue || null,
  }));

  for (const matchChunk of chunk(matchRows, CHUNK_SIZE)) {
    await prisma.ttblMatch.createMany({
      data: matchChunk,
      skipDuplicates: true,
    });
  }

  const gameRows = input.gamesData.map((game) => ({
    matchId: game.matchId,
    season,
    gameday: game.gameday,
    timestampMs: toBigIntMs(game.timestamp),
    gameIndex: game.gameIndex,
    format: game.format ?? null,
    isYouth: Boolean(game.isYouth),
    gameState: game.gameState,
    winnerSide: game.winnerSide ?? null,
    homePlayerId: game.homePlayer.id ?? null,
    homePlayerName: game.homePlayer.name ?? null,
    awayPlayerId: game.awayPlayer.id ?? null,
    awayPlayerName: game.awayPlayer.name ?? null,
  }));

  for (const gameChunk of chunk(gameRows, CHUNK_SIZE)) {
    await prisma.ttblGame.createMany({
      data: gameChunk,
      skipDuplicates: true,
    });
  }

  const statRows = input.playerStatsFinal.map((row) => ({
    season,
    playerId: row.id,
    name: row.name,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    losses: row.losses,
    winRate: row.winRate,
    lastMatchId: row.lastMatch,
  }));

  for (const statChunk of chunk(statRows, CHUNK_SIZE)) {
    await prisma.ttblPlayerSeasonStat.createMany({
      data: statChunk,
      skipDuplicates: true,
    });
  }

  await prisma.ttblSeasonSummary.upsert({
    where: { season },
    create: {
      season,
      scrapeDate: toDateOrNull(input.metadata.scrapeDate) ?? new Date(),
      totalMatches: input.metadata.totalMatches,
      totalGamedays: input.metadata.totalGamedays,
      youthFilteredMatches: input.metadata.youthFilteredMatches ?? 0,
      youthIncludedMatches: input.metadata.youthIncludedMatches ?? 0,
      notFinishedMatches: input.metadata.notFinishedMatches ?? 0,
      ongoingMatches: input.metadata.ongoingMatches ?? 0,
      uniquePlayers: input.metadata.uniquePlayers,
      playersWithStats: input.metadata.playersWithStats,
      totalGamesProcessed: input.metadata.totalGamesProcessed,
      source: input.metadata.source,
      version: input.metadata.version,
    },
    update: {
      scrapeDate: toDateOrNull(input.metadata.scrapeDate) ?? new Date(),
      totalMatches: input.metadata.totalMatches,
      totalGamedays: input.metadata.totalGamedays,
      youthFilteredMatches: input.metadata.youthFilteredMatches ?? 0,
      youthIncludedMatches: input.metadata.youthIncludedMatches ?? 0,
      notFinishedMatches: input.metadata.notFinishedMatches ?? 0,
      ongoingMatches: input.metadata.ongoingMatches ?? 0,
      uniquePlayers: input.metadata.uniquePlayers,
      playersWithStats: input.metadata.playersWithStats,
      totalGamesProcessed: input.metadata.totalGamesProcessed,
      source: input.metadata.source,
      version: input.metadata.version,
    },
  });

  emit(
    input.onLog,
    `TTBL relational persistence complete (season=${season}, matches=${matchRows.length}, games=${gameRows.length}, players=${playersById.size}).`,
  );
}

export async function persistWTTSnapshotToDb(input: WTTSnapshotInput): Promise<void> {
  const prisma = resolveOptionalClient();
  if (!prisma) {
    return;
  }

  const yearsFromMatches = input.matches
    .map((row) => toYearInt(row.year))
    .filter((value): value is number => value !== null);
  const years = [...new Set([...input.years, ...yearsFromMatches])]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);

  emit(
    input.onLog,
    `Persisting WTT scrape to relational tables (years=${years.join(",") || "none"}).`,
  );

  await runWithConcurrency(
    input.players,
    UPSERT_CONCURRENCY,
    async (player) => {
      await prisma.wttPlayer.upsert({
        where: { id: player.ittf_id },
        create: {
          id: player.ittf_id,
          firstName: player.first_name,
          lastName: player.last_name,
          fullName: player.full_name,
          dob: player.dob,
          nationality: player.nationality,
          team: player.team,
          countryName: player.country_name,
          organizationName: player.organization_name,
          gender: player.gender,
          age: player.age,
          handedness: player.handedness,
          style: player.style,
          worldRanking: player.world_ranking,
          worldRankingPoints: player.world_ranking_points,
          headshotUrl: player.headshot_url,
          matchesPlayed: player.stats.matches_played,
          wins: player.stats.wins,
          losses: player.stats.losses,
          sources: [...new Set(player.sources)],
          lastSeenAt: toDateOrNull(player.last_seen),
        },
        update: {
          firstName: player.first_name,
          lastName: player.last_name,
          fullName: player.full_name,
          dob: player.dob,
          nationality: player.nationality,
          team: player.team,
          countryName: player.country_name,
          organizationName: player.organization_name,
          gender: player.gender,
          age: player.age,
          handedness: player.handedness,
          style: player.style,
          worldRanking: player.world_ranking,
          worldRankingPoints: player.world_ranking_points,
          headshotUrl: player.headshot_url,
          matchesPlayed: player.stats.matches_played,
          wins: player.stats.wins,
          losses: player.stats.losses,
          sources: [...new Set(player.sources)],
          lastSeenAt: toDateOrNull(player.last_seen),
        },
      });
    },
  );

  const yearsToReplace = [...new Set(yearsFromMatches)].sort((a, b) => b - a);
  if (yearsToReplace.length > 0) {
    await prisma.wttMatch.deleteMany({
      where: { year: { in: yearsToReplace } },
    });
  } else if (years.length > 0) {
    emit(
      input.onLog,
      `WTT persistence skipped match replacement for years=${years.join(",")} because scrape returned 0 matches.`,
    );
  }

  const matchRows = input.matches.map((match) => ({
    id: match.match_id,
    sourceMatchId: match.source_match_id ?? null,
    eventId: match.event_id ?? null,
    subEventCode: match.sub_event_code ?? null,
    year: toYearInt(match.year),
    lastUpdatedAt: toDateOrNull(match.last_updated_at ?? null),
    tournament: match.tournament ?? null,
    event: match.event ?? null,
    stage: match.stage ?? null,
    round: match.round ?? null,
    resultStatus: match.result_status ?? null,
    notFinished: Boolean(match.not_finished),
    ongoing: Boolean(match.ongoing),
    isYouth: Boolean(match.is_youth),
    walkover: Boolean(match.walkover),
    winnerRaw: match.winner_raw ?? null,
    winnerInferred: match.winner_inferred ?? null,
    finalSetsA: match.final_sets.a,
    finalSetsX: match.final_sets.x,
    playerAId: match.players.a.ittf_id ?? null,
    playerAName: match.players.a.name ?? null,
    playerAAssoc: match.players.a.association ?? null,
    playerXId: match.players.x.ittf_id ?? null,
    playerXName: match.players.x.name ?? null,
    playerXAssoc: match.players.x.association ?? null,
    sourceType: match.source.type ?? null,
    sourceBaseUrl: match.source.base_url ?? null,
    sourceListId: match.source.list_id ?? null,
  }));

  for (const matchChunk of chunk(matchRows, CHUNK_SIZE)) {
    await prisma.wttMatch.createMany({
      data: matchChunk,
      skipDuplicates: true,
    });
  }

  const gameRows = input.matches.flatMap((match) =>
    match.games.map((game) => ({
      matchId: match.match_id,
      gameNumber: game.game_number,
      aPoints: game.a_points,
      xPoints: game.x_points,
    })),
  );

  for (const gameChunk of chunk(gameRows, CHUNK_SIZE)) {
    await prisma.wttMatchGame.createMany({
      data: gameChunk,
      skipDuplicates: true,
    });
  }

  emit(
    input.onLog,
    `WTT relational persistence complete (matches=${matchRows.length}, games=${gameRows.length}, players=${input.players.length}).`,
  );
}
