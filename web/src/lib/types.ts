export interface TTBLPlayerRef {
  id: string | null;
  name: string;
}

export interface TTBLGameRecord {
  matchId: string;
  gameday: string;
  timestamp: number;
  gameIndex: number;
  gameState: string;
  winnerSide: "Home" | "Away" | null;
  homePlayer: TTBLPlayerRef;
  awayPlayer: TTBLPlayerRef;
}

export interface TTBLPlayerStats {
  id: string;
  name: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  lastMatch: string;
  winRate: number;
}

export interface TTBLMatchSummary {
  matchId: string;
  matchState: string;
  gameday: string;
  timestamp: number;
  homeTeam: {
    id: string;
    name: string;
    rank: number;
    gameWins: number;
    setWins: number;
  };
  awayTeam: {
    id: string;
    name: string;
    rank: number;
    gameWins: number;
    setWins: number;
  };
  gamesCount: number;
  venue: string;
}

export interface TTBLMetadata {
  scrapeDate: string;
  season: string;
  totalMatches: number;
  totalGamedays: number;
  uniquePlayers: number;
  playersWithStats: number;
  totalGamesProcessed: number;
  source: string;
  version: string;
}

export interface WTTPlayer {
  ittf_id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  dob: string | null;
  nationality: string | null;
  team: string | null;
  stats: {
    matches_played: number;
    wins: number;
    losses: number;
  };
  sources: string[];
  last_seen: string;
}

export interface WTTMatch {
  match_id: string;
  year: string | null;
  tournament: string | null;
  event: string | null;
  stage: string | null;
  round: string | null;
  walkover: boolean;
  winner_raw: number | null;
  winner_inferred: "A" | "X" | null;
  final_sets: {
    a: number;
    x: number;
  };
  games: Array<{ game_number: number; a_points: number; x_points: number }>;
  players: {
    a: {
      ittf_id: string | null;
      name: string | null;
      association: string | null;
    };
    x: {
      ittf_id: string | null;
      name: string | null;
      association: string | null;
    };
  };
  source: {
    type: string;
    base_url: string;
    list_id: string;
  };
}

export interface NormalizedResult {
  source: "ttbl" | "wtt";
  occurredAt: string;
  matchKey: string;
  eventName: string;
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  winnerId: string;
}

export interface TTBLLegacyIndexRow {
  season: string;
  outputDir: string;
  totalMatches: number;
  uniquePlayers: number;
  totalGamesProcessed: number;
  scrapeDate: string;
}

export interface TTBLLegacyIndex {
  generatedAt: string;
  seasons: string[];
  results: TTBLLegacyIndexRow[];
}

export interface PlayerRegistryMember {
  source: "ttbl" | "wtt";
  sourceId: string;
  sourceKey: string;
  names: string[];
  seasons: string[];
}

export interface CanonicalPlayer {
  canonicalKey: string;
  displayName: string;
  normalizedNames: string[];
  sourceCount: number;
  memberCount: number;
  members: PlayerRegistryMember[];
}

export interface PlayerMergeCandidate {
  leftCanonicalKey: string;
  rightCanonicalKey: string;
  leftName: string;
  rightName: string;
  reason: string;
}

export interface PlayerRegistrySnapshot {
  generatedAt: string;
  totals: {
    sourcePlayers: number;
    ttblSourcePlayers: number;
    wttSourcePlayers: number;
    canonicalPlayers: number;
    mergedPlayers: number;
    candidates: number;
  };
  players: CanonicalPlayer[];
  mergeCandidates: PlayerMergeCandidate[];
  sourceIndex: Record<string, string>;
}

export interface PlayerRegistryManualConfig {
  aliases: Record<string, string>;
}
