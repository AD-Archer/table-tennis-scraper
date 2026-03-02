const CMS_BASE_URL = "https://wttapigateway.azure-api.net/prod/api";
const REQUEST_TIMEOUT_MS = 15_000;

const CMS_HEADERS: Record<string, string> = {
  Origin: "https://eventresults.ittf.com",
  Referer: "https://eventresults.ittf.com/",
  "User-Agent": "Mozilla/5.0 (compatible; WTT-Pipeline/1.0)",
};

// ---------------------------------------------------------------------------
// Response types (shaped from observed API responses)
// ---------------------------------------------------------------------------

export interface WTTCMSLiveMatch {
  id: string | null;
  eventId: string;
  documentCode: string;
  exclude: number;
  match_card: unknown | null;
  subEventType: string;
}

export interface WTTCMSOfficialMatch {
  id: number;
  eventId: string;
  documentCode: string;
  messagePayload: unknown | null;
  subEventType: string;
  fullResults: string;
  extended_info: unknown | null;
  match_card: unknown | null;
}

export interface WTTCMSMatchCardPlayer {
  playerId: string;
  playerName: string;
  playerGivenName: string | null;
  playerFamilyName: string | null;
  playerOrgCode: string;
  playerPosition: number;
}

export interface WTTCMSMatchCardCompetitor {
  competitorType: "H" | "A";
  competitiorId: string;
  competitiorName: string;
  competitiorOrg: string;
  compCardY: string;
  compCardYR1: string;
  compCardYR2: string;
  compTimeout: string;
  compMedicalTimeout: string;
  players: WTTCMSMatchCardPlayer[];
  scores: string;
  irm: string | null;
}

export interface WTTCMSMatchCard {
  eventId: string;
  documentCode: string;
  subEventName: string;
  subEventDescription: string;
  matchConfig: {
    bestOfXGames: number;
    maxPointsPerGame: number;
    advantagePerGame: number;
    suddenDeathPoint: number;
    maxChallengesPerCompetitor: number;
    yellowCard: boolean;
    yellowRed1: boolean;
    yellowRed2: boolean;
    tTRReview: boolean;
  };
  venueName: string;
  tableNumber: string;
  tableName: string;
  competitiors: WTTCMSMatchCardCompetitor[];
  currentGameNumber: number;
  full_msg: unknown | null;
  gameScores: string;
  resultsGameScores: string;
  overallScores: string;
  resultOverallScores: string;
  resultStatus: string;
  action: unknown;
  resultSet: unknown | null;
  matchDateTime: {
    duration: string;
    startDateLocal: string;
    startDateUTC: string;
  };
  teamParentData: unknown | null;
  playByPlaySequenceNumber: string;
  teamMatchNo: string;
  teamMatchScores: string;
  teamMatchScoresSummary: string;
  matchStartTimeUTC: string | null;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function cmsGet<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${CMS_BASE_URL}${path}`, {
      headers: CMS_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchLiveResult(): Promise<WTTCMSLiveMatch[]> {
  const data = await cmsGet<WTTCMSLiveMatch[]>("/cms/GetLiveResult");
  return Array.isArray(data) ? data : [];
}

export async function fetchOfficialResult(
  eventId: string,
): Promise<WTTCMSOfficialMatch[]> {
  const data = await cmsGet<WTTCMSOfficialMatch[]>(
    `/cms/GetOfficialResult?EventId=${encodeURIComponent(eventId)}`,
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchMatchCard(
  eventId: string,
  documentCode: string,
): Promise<WTTCMSMatchCard | null> {
  return cmsGet<WTTCMSMatchCard>(
    `/cms/GetMatchCardDetails/${encodeURIComponent(eventId)}/${encodeURIComponent(documentCode)}`,
  );
}
