import path from "node:path";
import { readJson } from "@/lib/fs";
import { DashboardOverview, EndpointRow, FileLocationRow } from "@/lib/dashboard-types";
import {
  PLAYERS_MANUAL_FILE,
  PLAYERS_REGISTRY_FILE,
  TTBL_LEGACY_INDEX_FILE,
  TTBL_OUTPUT_DIR,
  TTBL_SEASONS_DIR,
  WTT_OUTPUT_DIR,
  getTTBLReadDir,
  toProjectRelative,
} from "@/lib/paths";
import { ensurePlayerRegistry } from "@/lib/players/registry";
import {
  TTBLLegacyIndex,
  TTBLGameRecord,
  TTBLMetadata,
  TTBLPlayerStats,
  WTTMatch,
} from "@/lib/types";
import { isWTTGenderedSinglesEvent } from "@/lib/wtt/events";

const appEndpoints: EndpointRow[] = [
  {
    method: "GET",
    path: "/api/overview",
    description: "Dashboard summary, data locations, and endpoint catalog.",
  },
  {
    method: "POST",
    path: "/api/scrape/ttbl",
    description:
      "Run TTBL scraper for one or more seasons (supports 2025 or 2025-2026 style inputs).",
  },
  {
    method: "POST",
    path: "/api/scrape/ttbl/all",
    description:
      "Run all-time TTBL scrape (discover seasons + scrape + rebuild players) without deleting WTT data.",
  },
  {
    method: "POST",
    path: "/api/scrape/wtt",
    description: "Run ITTF/WTT Fabrik scraper for one or more years.",
  },
  {
    method: "POST",
    path: "/api/scrape/wtt/all",
    description:
      "Run all-time WTT scrape (discover years + scrape + rebuild players) without deleting TTBL data.",
  },
  {
    method: "POST",
    path: "/api/scrape/clean",
    description:
      "Delete local scraper data and run a full all-time scrape for TTBL + ITTF/WTT.",
  },
  {
    method: "POST",
    path: "/api/data/destroy",
    description: "Delete local data root and recreate an empty local data folder.",
  },
  {
    method: "GET",
    path: "/api/players/registry",
    description: "Read deduped player registry and merge candidates.",
  },
  {
    method: "POST",
    path: "/api/players/registry",
    description: "Rebuild deduped player registry from scraped data.",
  },
  {
    method: "GET",
    path: "/api/players/slugs",
    description:
      "Read flattened canonical player rows with merge candidates, match stats, scores, and inferred gender.",
  },
  {
    method: "GET",
    path: "/api/endpoints",
    description: "List scraper and registry endpoint references.",
  },
  {
    method: "POST",
    path: "/api/mcp",
    description: "MCP JSON-RPC endpoint exposing scrape controls, diagnostics, matches, and places.",
  },
  {
    method: "GET",
    path: "/api/mcp",
    description: "MCP endpoint metadata and tool catalog.",
  },
];

export function getEndpointCatalog(): EndpointRow[] {
  return [...appEndpoints];
}

export async function getDashboardOverview(): Promise<DashboardOverview> {
  const ttblReadDir = getTTBLReadDir();

  const [ttblMetadata, ttblTopPlayers, ttblGames, ttblLegacy, wttDataset, registry] =
    await Promise.all([
      readJson<TTBLMetadata>(path.join(ttblReadDir, "metadata.json"), null),
      readJson<TTBLPlayerStats[]>(
        path.join(ttblReadDir, "stats", "top_players.json"),
        [],
      ),
      readJson<TTBLGameRecord[]>(
        path.join(ttblReadDir, "stats", "games_data.json"),
        [],
      ),
      readJson<TTBLLegacyIndex>(TTBL_LEGACY_INDEX_FILE, null),
      readJson<{
        metadata?: { years?: number[]; matches?: number; players?: number };
        matches?: WTTMatch[];
      }>(path.join(WTT_OUTPUT_DIR, "dataset.json"), null),
      ensurePlayerRegistry(),
    ]);

  const validFinishedGames = (ttblGames ?? []).filter(
    (game) =>
      game.gameState === "Finished" &&
      Boolean(game.winnerSide) &&
      Boolean(game.homePlayer.id) &&
      Boolean(game.awayPlayer.id),
  ).length;
  const filteredWTTMatches = (wttDataset?.matches ?? []).filter((row) =>
    isWTTGenderedSinglesEvent(row.event),
  );
  const wttTotalMatches =
    (wttDataset?.matches?.length ?? 0) > 0
      ? filteredWTTMatches.length
      : (wttDataset?.metadata?.matches ?? 0);

  const fileLocations: FileLocationRow[] = [
    {
      label: "TTBL active read dir",
      path: ttblReadDir,
      exists: Boolean(ttblMetadata),
    },
    {
      label: "TTBL current alias dir",
      path: TTBL_OUTPUT_DIR,
      exists: true,
    },
    {
      label: "TTBL seasons root",
      path: TTBL_SEASONS_DIR,
      exists: Boolean(ttblLegacy?.seasons?.length),
    },
    {
      label: "TTBL legacy index",
      path: TTBL_LEGACY_INDEX_FILE,
      exists: Boolean(ttblLegacy),
    },
    {
      label: "WTT dataset",
      path: path.join(WTT_OUTPUT_DIR, "dataset.json"),
      exists: Boolean(wttDataset),
    },
    {
      label: "Player registry",
      path: PLAYERS_REGISTRY_FILE,
      exists: Boolean(registry),
    },
    {
      label: "Manual merge aliases",
      path: PLAYERS_MANUAL_FILE,
      exists: true,
    },
  ].map((row) => ({ ...row, path: toProjectRelative(row.path) }));

  return {
    generatedAt: new Date().toISOString(),
    ttbl: {
      metadata: ttblMetadata,
      legacy: ttblLegacy,
      topPlayers: ttblTopPlayers ?? [],
      totalGames: (ttblGames ?? []).length,
      validFinishedGames,
    },
    wtt: {
      years: wttDataset?.metadata?.years ?? [],
      totalMatches: wttTotalMatches,
      totalPlayers: wttDataset?.metadata?.players ?? 0,
      sampleMatches: filteredWTTMatches.slice(0, 8),
    },
    players: registry,
    fileLocations,
    endpoints: getEndpointCatalog(),
  };
}
