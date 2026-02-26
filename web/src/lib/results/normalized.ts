import path from "node:path";
import { readJson } from "@/lib/fs";
import { WTT_OUTPUT_DIR, getTTBLReadDir } from "@/lib/paths";
import { NormalizedResult, TTBLGameRecord, WTTMatch } from "@/lib/types";

async function loadTTBLResults(): Promise<NormalizedResult[]> {
  const ttblReadDir = getTTBLReadDir();
  const games =
    (await readJson<TTBLGameRecord[]>(
      path.join(ttblReadDir, "stats", "games_data.json"),
      [],
    )) ?? [];

  return games
    .filter(
      (game) =>
        game.gameState === "Finished" &&
        Boolean(game.winnerSide) &&
        Boolean(game.homePlayer.id) &&
        Boolean(game.awayPlayer.id),
    )
    .map((game) => {
      const homeId = game.homePlayer.id as string;
      const awayId = game.awayPlayer.id as string;

      return {
        source: "ttbl" as const,
        occurredAt: new Date((game.timestamp || 0) * 1000).toISOString(),
        matchKey: `ttbl:${game.matchId}:${game.gameIndex}`,
        eventName: game.gameday,
        playerAId: homeId,
        playerAName: game.homePlayer.name,
        playerBId: awayId,
        playerBName: game.awayPlayer.name,
        winnerId: game.winnerSide === "Home" ? homeId : awayId,
      };
    });
}

async function loadWTTResults(): Promise<NormalizedResult[]> {
  const matches =
    (await readJson<WTTMatch[]>(path.join(WTT_OUTPUT_DIR, "matches.json"), [])) ??
    [];

  let fallbackCounter = 0;

  return matches
    .filter(
      (match) =>
        Boolean(match.players.a.ittf_id) &&
        Boolean(match.players.x.ittf_id) &&
        Boolean(match.winner_inferred),
    )
    .map((match) => {
      const year = Number.parseInt(match.year ?? "", 10);
      const baseTimestamp = Number.isFinite(year)
        ? Date.UTC(year, 0, 1)
        : Date.now();
      const occurredAt = new Date(
        baseTimestamp + fallbackCounter * 60_000,
      ).toISOString();
      fallbackCounter += 1;

      const aId = match.players.a.ittf_id as string;
      const xId = match.players.x.ittf_id as string;

      return {
        source: "wtt" as const,
        occurredAt,
        matchKey: `wtt:${match.match_id}`,
        eventName: match.event ?? match.tournament ?? "WTT Match",
        playerAId: aId,
        playerAName: match.players.a.name ?? aId,
        playerBId: xId,
        playerBName: match.players.x.name ?? xId,
        winnerId: match.winner_inferred === "A" ? aId : xId,
      };
    });
}

function toTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
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
