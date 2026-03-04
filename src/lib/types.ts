export interface TTBLPlayerRef {
  id: string | null;
  name: string;
}

export interface TTBLGameRecord {
  matchId: string;
  gameday: string;
  timestamp: number;
  gameIndex: number;
  format?: "singles" | "doubles";
  isYouth?: boolean;
  gameState: string;
  winnerSide: "Home" | "Away" | null;
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
  isYouth?: boolean;
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
  youthFilteredMatches?: number;
  youthIncludedMatches?: number;
  notFinishedMatches?: number;
  ongoingMatches?: number;
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
  country_name: string | null;
  organization_name: string | null;
  gender: "M" | "W" | "mixed" | "unknown" | null;
  age: number | null;
  handedness: string | null;
  style: string | null;
  world_ranking: number | null;
  world_ranking_points: number | null;
  headshot_url: string | null;
  stats: {
    matches_played: number;
    wins: number;
    losses: number;
  };
  sources: string[];
  is_youth: boolean;
  last_seen: string;
}

export interface WTTMatch {
  match_id: string;
  source_match_id?: string | null;
  event_id?: string | null;
  sub_event_code?: string | null;
  year: string | null;
  last_updated_at?: string | null;
  tournament: string | null;
  event: string | null;
  stage: string | null;
  round: string | null;
  result_status?: string | null;
  not_finished?: boolean;
  ongoing?: boolean;
  is_youth?: boolean;
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

export type PlayerGender = "M" | "W" | "mixed" | "unknown";
export type PlayerGenderSource =
  | "wtt_event_inference"
  | "wtt_profile_gender"
  | "ttbl_league_inference"
  | "ttbl_default_assumption"
  | "unknown";
export type PlayerCountrySource =
  | "wtt_profile_nationality"
  | "ttbl_profile_nationality"
  | "unknown";

export interface PlayerSlugMatchEntry {
  source: "ttbl" | "wtt";
  matchId: string;
  occurredAt: string | null;
  seasonOrYear: string | null;
  event: string | null;
  opponent: string | null;
  opponentSourceId: string | null;
  score: string | null;
  outcome: "W" | "L" | null;
}

export interface PlayerSlugCandidateEntry {
  otherCanonicalKey: string;
  otherName: string;
  reason: string;
}

export interface PlayerSlugRow {
  slug: string;
  canonicalKey: string;
  displayName: string;
  sourceCount: number;
  memberCount: number;
  sources: Array<"ttbl" | "wtt">;
  sourceIds: string[];
  seasons: string[];
  country: string | null;
  countrySource: PlayerCountrySource;
  gender: PlayerGender;
  genderSource: PlayerGenderSource;
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  mergeCandidates: PlayerSlugCandidateEntry[];
  recentMatches: PlayerSlugMatchEntry[];
}

export interface PlayerSlugOverview {
  generatedAt: string;
  totals: {
    players: number;
    withMergeCandidates: number;
    withKnownGender: number;
  };
  players: PlayerSlugRow[];
}

export interface PlayerSourceMemberDetail {
  source: "ttbl" | "wtt";
  sourceId: string;
  sourceKey: string;
  names: string[];
  seasons: string[];
  ttblProfile: TTBLPlayerProfile | null;
  wttProfile: WTTPlayer | null;
}

export interface TTBLPlayerProfile {
  sourcePlayerId: string;
  stablePlayerId: string | null;
  seasonPlayerId: string | null;
  fetchedAt: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  nationality: string | null;
  nationalitySecondary: string | null;
  birthdayUnix: number | null;
  heightCm: number | null;
  weightKg: number | null;
  hand: string | null;
  racketPosture: string | null;
  role: string | null;
  currentClub: string | null;
  outfitter: string | null;
  outfitterWebsite: string | null;
  seasonLabel: string | null;
  imageUrl: string | null;
  actionImageUrl: string | null;
  cardImageUrl: string | null;
  social: {
    instagram: string | null;
    youtube: string | null;
    website: string | null;
    tiktok: string | null;
    facebook: string | null;
  };
  metrics: {
    ttblRank: number | null;
    worldRank: number | null;
    qttrValue: number | null;
    gameWins: number | null;
    gameLosses: number | null;
    setWins: number | null;
    setLosses: number | null;
    ballWins: number | null;
    ballLosses: number | null;
  };
  sampleSize: {
    games: number;
    homeGames: number;
    awayGames: number;
  };
}
