import path from "node:path";
import { ensureDir, readJson, writeJson } from "@/lib/fs";
import { WTT_OUTPUT_DIR } from "@/lib/paths";
import type { WTTMatch, WTTPlayer } from "@/lib/types";
import type { WTTCMSMatchCard, WTTCMSMatchCardCompetitor } from "./wtt-cms";

// ---------------------------------------------------------------------------
// Match card → WTTMatch conversion
// ---------------------------------------------------------------------------

function parseOverallScores(raw: string): { a: number; x: number } {
  const parts = raw.split("-").map((s) => Number.parseInt(s.trim(), 10));
  const a = Number.isFinite(parts[0]) ? (parts[0] as number) : 0;
  const x = Number.isFinite(parts[1]) ? (parts[1] as number) : 0;
  return { a, x };
}

function parseGameScores(
  raw: string,
): Array<{ game_number: number; a_points: number; x_points: number }> {
  if (!raw || !raw.trim()) {
    return [];
  }

  const games: Array<{
    game_number: number;
    a_points: number;
    x_points: number;
  }> = [];

  const tokens = raw.split(",");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]?.trim();
    if (!token) {
      continue;
    }

    const [aRaw, xRaw] = token.split("-");
    const a = Number.parseInt(aRaw ?? "", 10);
    const x = Number.parseInt(xRaw ?? "", 10);

    if (!Number.isFinite(a) || !Number.isFinite(x)) {
      continue;
    }

    if (a === 0 && x === 0) {
      continue;
    }

    games.push({ game_number: games.length + 1, a_points: a, x_points: x });
  }

  return games;
}

function parseYearFromDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) {
    return null;
  }

  const match = dateStr.match(/(\d{4})/);
  return match?.[1] ?? null;
}

function parseStageAndRound(description: string): {
  stage: string | null;
  round: string | null;
} {
  if (!description) {
    return { stage: null, round: null };
  }

  const lastDash = description.lastIndexOf(" - ");
  if (lastDash < 0) {
    return { stage: description, round: null };
  }

  return {
    stage: description.substring(0, lastDash).trim() || null,
    round: description.substring(lastDash + 3).trim() || null,
  };
}

function findCompetitor(
  competitors: WTTCMSMatchCardCompetitor[],
  type: "H" | "A",
): WTTCMSMatchCardCompetitor | null {
  return competitors.find((c) => c.competitorType === type) ?? null;
}

function competitorToPlayer(
  c: WTTCMSMatchCardCompetitor | null,
): WTTMatch["players"]["a"] {
  if (!c) {
    return { ittf_id: null, name: null, association: null };
  }

  return {
    ittf_id: c.competitiorId || null,
    name: c.competitiorName || null,
    association: c.competitiorOrg || null,
  };
}

export function matchCardToWTTMatch(card: WTTCMSMatchCard): WTTMatch {
  const finalSets = parseOverallScores(card.overallScores);
  const games = parseGameScores(card.gameScores);
  const { stage, round } = parseStageAndRound(card.subEventDescription);

  const home = findCompetitor(card.competitiors, "H");
  const away = findCompetitor(card.competitiors, "A");

  const hasWalkover = card.competitiors.some(
    (c) => c.irm !== null && c.irm !== "",
  );

  let winnerInferred: "A" | "X" | null = null;
  if (finalSets.a !== finalSets.x) {
    winnerInferred = finalSets.a > finalSets.x ? "A" : "X";
  }

  return {
    match_id: card.documentCode,
    year: parseYearFromDate(card.matchDateTime?.startDateUTC),
    tournament: null,
    event: card.subEventName || null,
    stage,
    round,
    walkover: hasWalkover,
    winner_raw: null,
    winner_inferred: winnerInferred,
    final_sets: finalSets,
    games,
    players: {
      a: competitorToPlayer(home),
      x: competitorToPlayer(away),
    },
    source: {
      type: "wtt_cms",
      base_url: "https://wttapigateway.azure-api.net/prod/api",
      list_id: "cms",
    },
  };
}

// ---------------------------------------------------------------------------
// Player upsert
// ---------------------------------------------------------------------------

function upsertPlayerFromMatch(
  players: Record<string, WTTPlayer>,
  ittfId: string | null,
  name: string | null,
  association: string | null,
): void {
  if (!ittfId) {
    return;
  }

  const existing = players[ittfId];
  if (existing) {
    existing.last_seen = new Date().toISOString();
    if (!existing.sources.includes("wtt_cms")) {
      existing.sources.push("wtt_cms");
    }
    return;
  }

  const nameParts = parseName(name ?? "");

  players[ittfId] = {
    ittf_id: ittfId,
    first_name: nameParts.first,
    last_name: nameParts.last,
    full_name: name || null,
    dob: null,
    nationality: association || null,
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
    stats: { matches_played: 0, wins: 0, losses: 0 },
    sources: ["wtt_cms"],
    last_seen: new Date().toISOString(),
  };
}

function parseName(fullName: string): { first: string | null; last: string | null } {
  const trimmed = fullName.trim();
  if (!trimmed) {
    return { first: null, last: null };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { first: null, last: parts[0] ?? null };
  }

  const caps = parts.filter((p) => p === p.toUpperCase());
  if (caps.length > 0) {
    const last = caps[0]!;
    const first = parts.filter((p) => p !== last).join(" ");
    return { first: first || null, last };
  }

  return {
    first: parts.slice(0, -1).join(" ") || null,
    last: parts.at(-1) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ingestion (append to existing data files)
// ---------------------------------------------------------------------------

export async function ingestMatchCard(
  _eventId: string,
  card: WTTCMSMatchCard,
): Promise<boolean> {
  const match = matchCardToWTTMatch(card);

  await ensureDir(WTT_OUTPUT_DIR);

  const matchesPath = path.join(WTT_OUTPUT_DIR, "matches.json");
  const playersPath = path.join(WTT_OUTPUT_DIR, "players.json");
  const indexPath = path.join(WTT_OUTPUT_DIR, "player_match_index.json");
  const datasetPath = path.join(WTT_OUTPUT_DIR, "dataset.json");

  const existingMatches =
    (await readJson<WTTMatch[]>(matchesPath, null)) ?? [];

  if (existingMatches.some((m) => m.match_id === match.match_id)) {
    return false;
  }

  existingMatches.push(match);

  const players =
    (await readJson<Record<string, WTTPlayer>>(playersPath, null)) ?? {};
  const matchIndex =
    (await readJson<Record<string, string[]>>(indexPath, null)) ?? {};

  upsertPlayerFromMatch(
    players,
    match.players.a.ittf_id,
    match.players.a.name,
    match.players.a.association,
  );
  upsertPlayerFromMatch(
    players,
    match.players.x.ittf_id,
    match.players.x.name,
    match.players.x.association,
  );

  const aId = match.players.a.ittf_id;
  const xId = match.players.x.ittf_id;

  if (aId) {
    const aPlayer = players[aId];
    if (aPlayer) {
      aPlayer.stats.matches_played += 1;
      if (match.winner_inferred === "A") {
        aPlayer.stats.wins += 1;
      } else if (match.winner_inferred === "X") {
        aPlayer.stats.losses += 1;
      }
    }

    if (!matchIndex[aId]) {
      matchIndex[aId] = [];
    }
    matchIndex[aId].push(match.match_id);
  }

  if (xId) {
    const xPlayer = players[xId];
    if (xPlayer) {
      xPlayer.stats.matches_played += 1;
      if (match.winner_inferred === "X") {
        xPlayer.stats.wins += 1;
      } else if (match.winner_inferred === "A") {
        xPlayer.stats.losses += 1;
      }
    }

    if (!matchIndex[xId]) {
      matchIndex[xId] = [];
    }
    matchIndex[xId].push(match.match_id);
  }

  const dataset = (await readJson<Record<string, unknown>>(datasetPath, null)) ?? {};
  const metadata = (dataset.metadata ?? {}) as Record<string, unknown>;
  metadata.scraped_at = new Date().toISOString();
  metadata.matches = existingMatches.length;
  metadata.players = Object.keys(players).length;
  dataset.metadata = metadata;
  dataset.players = players;
  dataset.matches = existingMatches;
  dataset.player_match_index = matchIndex;

  await Promise.all([
    writeJson(matchesPath, existingMatches),
    writeJson(playersPath, players),
    writeJson(indexPath, matchIndex),
    writeJson(datasetPath, dataset),
  ]);

  return true;
}
