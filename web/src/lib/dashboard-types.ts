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
}

export interface FileLocationRow {
  label: string;
  path: string;
  exists: boolean;
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
  players: PlayerRegistrySnapshot | null;
  fileLocations: FileLocationRow[];
  endpoints: EndpointRow[];
}
