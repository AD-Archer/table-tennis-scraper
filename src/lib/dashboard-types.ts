import {
  PlayerRegistrySnapshot,
  TTBLLegacyIndex,
  TTBLMetadata,
  TTBLPlayerStats,
  WTTMatch,
} from "@/lib/types";

export interface EndpointRow {
  method: "GET" | "POST" | "PATCH";
  path: string;
  description: string;
  category: string;
}

export interface DashboardOverview {
  generatedAt: string;
  ttbl: {
    metadata: TTBLMetadata | null;
    legacy: TTBLLegacyIndex | null;
    topPlayers: TTBLPlayerStats[];
    totalGames: number;
    validFinishedGames: number;
  };
  wtt: {
    years: number[];
    totalMatches: number;
    totalPlayers: number;
    sampleMatches: WTTMatch[];
  };
  sync: {
    activity: Array<{
      id: string;
      timestamp: string;
      source: "wtt" | "ttbl";
      level: "info" | "warn" | "error";
      message: string;
      details?: Record<string, unknown> | null;
    }>;
    ttblFollowup: {
      scheduled: boolean;
      scheduledFor: string | null;
      lastTriggeredAt: string | null;
      lastOutcome: "started" | "busy" | "failed" | null;
      lastError: string | null;
    };
    wttFollowup: {
      scheduled: boolean;
      scheduledFor: string | null;
      lastTriggeredAt: string | null;
      lastOutcome: "started" | "busy" | "failed" | null;
      lastError: string | null;
    };
  };
  players: PlayerRegistrySnapshot | null;
  endpoints: EndpointRow[];
}
