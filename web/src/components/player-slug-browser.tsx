"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PlayerGender, PlayerSlugRow } from "@/lib/types";

const PAGE_SIZE = 30;

type SourceFilter = "all" | "ttbl" | "wtt" | "cross-source";
type MergeFilter = "all" | "with-candidates" | "without-candidates";
type SortBy = "matches" | "name" | "mergeCandidates";
type SortDir = "asc" | "desc";

interface PlayersApiResponse {
  ok: boolean;
  generatedAt: string;
  totals: {
    players: number;
    withMergeCandidates: number;
    withKnownGender: number;
  };
  page: {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    totalAll: number;
    hasMore: boolean;
    sortBy: SortBy;
    sortDir: SortDir;
  };
  filters: {
    sourceFilter: SourceFilter;
    genderFilter: "all" | PlayerGender;
    mergeFilter: MergeFilter;
    countryFilter: string;
    seasonFilter: string;
    minMatches: number;
    query: string;
  };
  filterOptions: {
    countries: string[];
    seasonsAndYears: string[];
  };
  players: PlayerSlugRow[];
  error?: string;
}

function fmtRate(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return `${value.toFixed(1)}%`;
}

export function PlayerSlugBrowser() {
  const [rows, setRows] = useState<PlayerSlugRow[]>([]);

  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [genderFilter, setGenderFilter] = useState<"all" | PlayerGender>("all");
  const [mergeFilter, setMergeFilter] = useState<MergeFilter>("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [seasonFilter, setSeasonFilter] = useState("all");
  const [minMatches, setMinMatches] = useState("0");
  const [sortBy, setSortBy] = useState<SortBy>("matches");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [countries, setCountries] = useState<string[]>([]);
  const [seasonsAndYears, setSeasonsAndYears] = useState<string[]>([]);

  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [totalAllPlayers, setTotalAllPlayers] = useState(0);
  const [totalFilteredPlayers, setTotalFilteredPlayers] = useState(0);
  const [withMergeCandidates, setWithMergeCandidates] = useState(0);
  const [withKnownGender, setWithKnownGender] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      setLoading(true);
      setError(null);

      try {
        const minMatchesNum = Math.max(0, Number.parseInt(minMatches, 10) || 0);
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(offset),
          sortBy,
          sortDir,
          sourceFilter,
          genderFilter,
          mergeFilter,
          countryFilter,
          seasonFilter,
          minMatches: String(minMatchesNum),
          query,
        });

        const response = await fetch(`/api/players/slugs?${params.toString()}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as PlayersApiResponse;
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error ?? `HTTP ${response.status}`);
        }

        setRows((prev) => (append ? [...prev, ...payload.players] : payload.players));
        setGeneratedAt(payload.generatedAt);
        setTotalFilteredPlayers(payload.page.total);
        setTotalAllPlayers(payload.page.totalAll);
        setHasMore(payload.page.hasMore);
        setWithMergeCandidates(payload.totals.withMergeCandidates);
        setWithKnownGender(payload.totals.withKnownGender);
        setCountries(payload.filterOptions.countries);
        setSeasonsAndYears(payload.filterOptions.seasonsAndYears);
      } catch (fetchError) {
        setError(fetchError instanceof Error ? fetchError.message : "unknown error");
      } finally {
        setLoading(false);
      }
    },
    [
      query,
      sourceFilter,
      genderFilter,
      mergeFilter,
      countryFilter,
      seasonFilter,
      minMatches,
      sortBy,
      sortDir,
    ],
  );

  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  return (
    <main className="mx-auto my-8 grid w-[min(1400px,calc(100%-2rem))] gap-4">
      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-teal-700">
              Player Slug View
            </p>
            <h1 className="m-0 text-3xl font-semibold leading-tight text-slate-900">
              Canonical Player Rollup
            </h1>
            <p className="mt-2 mb-0 max-w-3xl text-sm text-slate-600">
              Server-side filters + sorting, loaded in pages of {PAGE_SIZE}.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 no-underline hover:bg-slate-100"
              href="/"
            >
              Back To Control Deck
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Canonical Players
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{totalAllPlayers}</strong>
          <small className="text-sm text-slate-600">full dataset</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Filtered Total
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{totalFilteredPlayers}</strong>
          <small className="text-sm text-slate-600">after filters</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Loaded Rows
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{rows.length}</strong>
          <small className="text-sm text-slate-600">{hasMore ? "more available" : "all loaded"}</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Merge / Gender
          </span>
          <strong className="text-2xl leading-tight text-slate-900">
            {withMergeCandidates} / {withKnownGender}
          </strong>
          <small className="text-sm text-slate-600">{generatedAt ?? "-"}</small>
        </article>
      </section>

      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <h2 className="m-0 text-xl font-semibold text-slate-900">Filters</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Search
            <input
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              placeholder="name, slug, canonical key, source ID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Source
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            >
              <option value="all">All</option>
              <option value="ttbl">TTBL only</option>
              <option value="wtt">WTT only</option>
              <option value="cross-source">Cross-source</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Gender
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={genderFilter}
              onChange={(e) => setGenderFilter(e.target.value as "all" | PlayerGender)}
            >
              <option value="all">All</option>
              <option value="M">M</option>
              <option value="W">W</option>
              <option value="mixed">mixed</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Merge Candidates
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={mergeFilter}
              onChange={(e) => setMergeFilter(e.target.value as MergeFilter)}
            >
              <option value="all">All</option>
              <option value="with-candidates">With candidates</option>
              <option value="without-candidates">Without candidates</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Country
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
            >
              <option value="all">All</option>
              {countries.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Season / Year
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={seasonFilter}
              onChange={(e) => setSeasonFilter(e.target.value)}
            >
              <option value="all">All</option>
              {seasonsAndYears.map((seasonOrYear) => (
                <option key={seasonOrYear} value={seasonOrYear}>
                  {seasonOrYear}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Min Matches
            <input
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              min={0}
              type="number"
              value={minMatches}
              onChange={(e) => setMinMatches(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Sort By
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
            >
              <option value="matches">Matches</option>
              <option value="mergeCandidates">Merge candidates</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Direction
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value as SortDir)}
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
        </div>
        {error ? <p className="mt-2 mb-0 text-sm text-rose-700">Error: {error}</p> : null}
      </section>

      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <h2 className="m-0 text-xl font-semibold text-slate-900">Players</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="border-b border-slate-300">
              <tr className="text-left">
                <th className="px-2 py-2">Slug</th>
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Gender</th>
                <th className="px-2 py-2">Country</th>
                <th className="px-2 py-2">Matches</th>
                <th className="px-2 py-2">Merge Candidates</th>
                <th className="px-2 py-2">Recent Matches (click ID)</th>
              </tr>
            </thead>
            <tbody className="[&_tr]:border-b [&_tr]:border-slate-200">
              {rows.map((player) => (
                <tr key={player.canonicalKey}>
                  <td className="align-top px-2 py-2">
                    <code>{player.slug}</code>
                    <div className="text-xs text-slate-500">
                      <code>{player.canonicalKey}</code>
                    </div>
                  </td>
                  <td className="align-top px-2 py-2">
                    <strong>
                      <Link
                        className="font-semibold text-teal-700 no-underline hover:underline"
                        href={`/players/${encodeURIComponent(player.slug)}`}
                      >
                        {player.displayName}
                      </Link>
                    </strong>
                    <div className="text-xs text-slate-500">
                      {player.sources.join(", ")} | {player.sourceIds.length} source IDs
                    </div>
                    <div className="text-xs text-slate-500">
                      {player.seasons.length > 0 ? player.seasons.join(", ") : "no TTBL seasons"}
                    </div>
                  </td>
                  <td className="align-top px-2 py-2">{player.gender}</td>
                  <td className="align-top px-2 py-2">{player.country ?? "-"}</td>
                  <td className="align-top px-2 py-2">
                    <strong>{player.matchesPlayed}</strong>
                    <div className="text-xs text-slate-500">
                      W {player.wins} / L {player.losses}
                    </div>
                    <div className="text-xs text-slate-500">Win rate {fmtRate(player.winRate)}</div>
                  </td>
                  <td className="align-top px-2 py-2">
                    {player.mergeCandidates.length === 0 ? (
                      <span>-</span>
                    ) : (
                      <div className="grid gap-2">
                        {player.mergeCandidates.slice(0, 4).map((candidate) => (
                          <div key={`${candidate.otherCanonicalKey}:${candidate.reason}`}>
                            <strong>{candidate.otherName}</strong>
                            <div className="text-xs text-slate-500">{candidate.reason}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="align-top px-2 py-2">
                    {player.recentMatches.length === 0 ? (
                      <span>-</span>
                    ) : (
                      <div className="grid gap-2">
                        {player.recentMatches.slice(0, 5).map((match) => (
                          <div key={`${match.source}:${match.matchId}`}>
                            <strong>
                              <Link
                                className="font-semibold text-teal-700 no-underline hover:underline"
                                href={{
                                  pathname: "/players/match",
                                  query: {
                                    source: match.source,
                                    matchId: match.matchId,
                                  },
                                }}
                              >
                                {match.source.toUpperCase()} {match.matchId}
                              </Link>
                            </strong>
                            <div className="text-xs text-slate-500">
                              {match.outcome ?? "-"} {match.score ?? "-"} vs{" "}
                              {match.opponent ?? "unknown opponent"}
                            </div>
                            <div className="text-xs text-slate-500">
                              {match.seasonOrYear ?? "-"} {match.event ?? ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="m-0 text-sm text-slate-600">
            Showing {rows.length} of {totalFilteredPlayers} filtered players
          </p>
          <button
            className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm text-slate-900 hover:bg-slate-100 disabled:opacity-50"
            disabled={loading || !hasMore}
            onClick={() => void fetchPage(rows.length, true)}
            type="button"
          >
            {loading ? "Loading..." : hasMore ? `Load ${PAGE_SIZE} more` : "No more players"}
          </button>
        </div>
      </section>
    </main>
  );
}
