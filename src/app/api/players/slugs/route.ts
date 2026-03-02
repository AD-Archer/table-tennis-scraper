import { NextResponse } from "next/server";
import {
  countryMatchesFilter,
  countrySearchTokens,
  normalizeCountryCode,
} from "@/lib/normalization/country";
import { getPlayerSlugOverview } from "@/lib/players/slugs";

type SortBy = "matches" | "name" | "mergeCandidates";
type SortDir = "asc" | "desc";
type SourceFilter = "all" | "ttbl" | "wtt" | "cross-source";
type MergeFilter = "all" | "with-candidates" | "without-candidates";
type GenderFilter = "all" | "M" | "W" | "mixed" | "unknown";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseSortBy(value: string | null): SortBy {
  if (value === "name" || value === "mergeCandidates") {
    return value;
  }
  return "matches";
}

function parseSortDir(value: string | null): SortDir {
  return value === "asc" ? "asc" : "desc";
}

function parseSourceFilter(value: string | null): SourceFilter {
  if (value === "ttbl" || value === "wtt" || value === "cross-source") {
    return value;
  }
  return "all";
}

function parseMergeFilter(value: string | null): MergeFilter {
  if (value === "with-candidates" || value === "without-candidates") {
    return value;
  }
  return "all";
}

function parseGenderFilter(value: string | null): GenderFilter {
  if (value === "M" || value === "W" || value === "mixed" || value === "unknown") {
    return value;
  }
  return "all";
}

function normalize(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
    const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
    const limit = clamp(Number.isFinite(limitRaw) ? limitRaw : 30, 1, 200);
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);
    const sortBy = parseSortBy(url.searchParams.get("sortBy"));
    const sortDir = parseSortDir(url.searchParams.get("sortDir"));
    const sourceFilter = parseSourceFilter(url.searchParams.get("sourceFilter"));
    const genderFilter = parseGenderFilter(url.searchParams.get("genderFilter"));
    const mergeFilter = parseMergeFilter(url.searchParams.get("mergeFilter"));
    const countryFilter = (url.searchParams.get("countryFilter") ?? "all").trim() || "all";
    const normalizedCountryFilter =
      countryFilter === "all" ? null : normalizeCountryCode(countryFilter);
    const seasonFilter = (url.searchParams.get("seasonFilter") ?? "all").trim() || "all";
    const minMatchesRaw = Number.parseInt(url.searchParams.get("minMatches") ?? "0", 10);
    const minMatches = Math.max(0, Number.isFinite(minMatchesRaw) ? minMatchesRaw : 0);
    const query = url.searchParams.get("query") ?? "";
    const queryNorm = normalize(query);

    const overview = await getPlayerSlugOverview();
    const countries = [
      ...new Set(
        overview.players
          .map((row) => normalizeCountryCode(row.country))
          .filter(Boolean),
      ),
    ]
      .map((value) => value as string)
      .sort((a, b) => a.localeCompare(b));
    const seasonsAndYears = [
      ...new Set(
        overview.players.flatMap((row) => [
          ...row.seasons,
          ...row.recentMatches.map((match) => match.seasonOrYear).filter(Boolean),
        ]),
      ),
    ]
      .map((value) => value as string)
      .sort((a, b) => b.localeCompare(a));

    const filteredPlayers = overview.players.filter((player) => {
      if (player.matchesPlayed < minMatches) {
        return false;
      }

      if (sourceFilter === "ttbl") {
        if (!(player.sources.length === 1 && player.sources[0] === "ttbl")) {
          return false;
        }
      }
      if (sourceFilter === "wtt") {
        if (!(player.sources.length === 1 && player.sources[0] === "wtt")) {
          return false;
        }
      }
      if (sourceFilter === "cross-source") {
        if (!(player.sources.includes("ttbl") && player.sources.includes("wtt"))) {
          return false;
        }
      }

      if (genderFilter !== "all" && player.gender !== genderFilter) {
        return false;
      }

      if (mergeFilter === "with-candidates" && player.mergeCandidates.length === 0) {
        return false;
      }
      if (mergeFilter === "without-candidates" && player.mergeCandidates.length > 0) {
        return false;
      }

      if (
        normalizedCountryFilter &&
        !countryMatchesFilter(player.country, normalizedCountryFilter)
      ) {
        return false;
      }

      if (seasonFilter !== "all") {
        const inSeasons = player.seasons.includes(seasonFilter);
        const inRecent = player.recentMatches.some((match) => match.seasonOrYear === seasonFilter);
        if (!inSeasons && !inRecent) {
          return false;
        }
      }

      if (!queryNorm) {
        return true;
      }

      const haystack = [
        player.slug,
        player.canonicalKey,
        player.displayName,
        player.country ?? "",
        countrySearchTokens(player.country).join(" "),
        player.gender,
        player.sourceIds.join(" "),
        player.seasons.join(" "),
        player.mergeCandidates.map((row) => row.otherName).join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(queryNorm);
    });

    const sortedPlayers = [...filteredPlayers].sort((a, b) => {
      let cmp = 0;
      if (sortBy === "name") {
        cmp = a.displayName.localeCompare(b.displayName);
      } else if (sortBy === "mergeCandidates") {
        cmp =
          a.mergeCandidates.length - b.mergeCandidates.length ||
          a.displayName.localeCompare(b.displayName);
      } else {
        cmp =
          a.matchesPlayed - b.matchesPlayed ||
          a.wins - b.wins ||
          a.displayName.localeCompare(b.displayName);
      }

      return sortDir === "asc" ? cmp : -cmp;
    });

    const players = sortedPlayers.slice(offset, offset + limit);
    const totalPlayers = sortedPlayers.length;

    return NextResponse.json({
      ok: true,
      generatedAt: overview.generatedAt,
      totals: overview.totals,
      page: {
        limit,
        offset,
        returned: players.length,
        total: totalPlayers,
        totalAll: overview.players.length,
        hasMore: offset + players.length < totalPlayers,
        sortBy,
        sortDir,
      },
      filters: {
        sourceFilter,
        genderFilter,
        mergeFilter,
        countryFilter,
        seasonFilter,
        minMatches,
        query,
      },
      filterOptions: {
        countries,
        seasonsAndYears,
      },
      players,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
      { status: 500 },
    );
  }
}
