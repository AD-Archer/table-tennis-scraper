import { getPrismaClient } from "@/lib/db/prisma";
import { NormalizedResult } from "@/lib/types";
import { isWTTGenderedSinglesEvent } from "@/lib/wtt/events";

function toTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadTTBLResults(): Promise<NormalizedResult[]> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return [];
  }

  const games = await prisma.ttblGame.findMany({
    where: {
      isYouth: false,
      gameState: "Finished",
      winnerSide: { not: null },
      homePlayerId: { not: null },
      awayPlayerId: { not: null },
    },
    select: {
      matchId: true,
      gameIndex: true,
      timestampMs: true,
      gameday: true,
      winnerSide: true,
      homePlayerId: true,
      homePlayerName: true,
      awayPlayerId: true,
      awayPlayerName: true,
    },
  });

  return games.map((game) => {
    const homeId = game.homePlayerId as string;
    const awayId = game.awayPlayerId as string;
    return {
      source: "ttbl" as const,
      occurredAt: new Date(Number(game.timestampMs) * 1000).toISOString(),
      matchKey: `ttbl:${game.matchId}:${game.gameIndex}`,
      eventName: game.gameday,
      playerAId: homeId,
      playerAName: game.homePlayerName ?? homeId,
      playerBId: awayId,
      playerBName: game.awayPlayerName ?? awayId,
      winnerId: game.winnerSide === "Home" ? homeId : awayId,
    };
  });
}

async function loadWTTResults(): Promise<NormalizedResult[]> {
  const prisma = getPrismaClient();
  if (!prisma) {
    return [];
  }

  const matches = await prisma.wttMatch.findMany({
    where: {
      isYouth: false,
      playerAId: { not: null },
      playerXId: { not: null },
      winnerInferred: { not: null },
    },
    select: {
      id: true,
      year: true,
      event: true,
      tournament: true,
      playerAId: true,
      playerAName: true,
      playerXId: true,
      playerXName: true,
      winnerInferred: true,
    },
  });

  let fallbackCounter = 0;
  return matches
    .filter((match) => isWTTGenderedSinglesEvent(match.event))
    .map((match) => {
      const year = match.year;
      const baseTimestamp = Number.isFinite(year)
        ? Date.UTC(year as number, 0, 1)
        : Date.now();
      const occurredAt = new Date(baseTimestamp + fallbackCounter * 60_000).toISOString();
      fallbackCounter += 1;

      const aId = match.playerAId as string;
      const xId = match.playerXId as string;

      return {
        source: "wtt" as const,
        occurredAt,
        matchKey: `wtt:${match.id}`,
        eventName: match.event ?? match.tournament ?? "WTT Match",
        playerAId: aId,
        playerAName: match.playerAName ?? aId,
        playerBId: xId,
        playerBName: match.playerXName ?? xId,
        winnerId: match.winnerInferred === "A" ? aId : xId,
      };
    });
}

export async function collectNormalizedResults(): Promise<NormalizedResult[]> {
  const [ttblResults, wttResults] = await Promise.all([
    loadTTBLResults(),
    loadWTTResults(),
  ]);

  return [...ttblResults, ...wttResults].sort(
    (a, b) =>
      toTimestamp(a.occurredAt) - toTimestamp(b.occurredAt) ||
      a.matchKey.localeCompare(b.matchKey),
  );
}
