"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PlayerGender, PlayerSlugOverview } from "@/lib/types";

interface PlayerSlugBrowserProps {
  initialOverview: PlayerSlugOverview;
}

type SourceFilter = "all" | "ttbl" | "wtt" | "cross-source";
type MergeFilter = "all" | "with-candidates" | "without-candidates";
type SortMode = "matches-desc" | "name-asc" | "merge-desc";

function fmtRate(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return `${value.toFixed(1)}%`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function PlayerSlugBrowser({ initialOverview }: PlayerSlugBrowserProps) {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [genderFilter, setGenderFilter] = useState<"all" | PlayerGender>("all");
  const [mergeFilter, setMergeFilter] = useState<MergeFilter>("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [seasonFilter, setSeasonFilter] = useState("all");
  const [minMatches, setMinMatches] = useState("0");
  const [sortMode, setSortMode] = useState<SortMode>("matches-desc");
  const [rowLimit, setRowLimit] = useState("200");

  const countries = useMemo(() => {
    return [...new Set(initialOverview.players.map((row) => row.country).filter(Boolean))]
      .map((row) => row as string)
      .sort((a, b) => a.localeCompare(b));
  }, [initialOverview.players]);

  const seasonsAndYears = useMemo(() => {
    const rows = new Set<string>();
    for (const player of initialOverview.players) {
      for (const season of player.seasons) {
        rows.add(season);
      }
      for (const match of player.recentMatches) {
        if (match.seasonOrYear) {
          rows.add(match.seasonOrYear);
        }
      }
    }

    return [...rows].sort((a, b) => b.localeCompare(a));
  }, [initialOverview.players]);

  const filtered = useMemo(() => {
    const queryNorm = normalize(query);
    const minMatchesValue = Math.max(0, Number.parseInt(minMatches, 10) || 0);

    const rows = initialOverview.players.filter((player) => {
      if (player.matchesPlayed < minMatchesValue) {
        return false;
      }

      if (sourceFilter === "ttbl" && !player.sources.includes("ttbl")) {
        return false;
      }
      if (sourceFilter === "wtt" && !player.sources.includes("wtt")) {
        return false;
      }
      if (sourceFilter === "cross-source" && player.sources.length < 2) {
        return false;
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

      if (countryFilter !== "all" && player.country !== countryFilter) {
        return false;
      }

      if (seasonFilter !== "all") {
        const inSeasons = player.seasons.includes(seasonFilter);
        const inRecent = player.recentMatches.some(
          (match) => match.seasonOrYear === seasonFilter,
        );
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
        player.gender,
        player.sourceIds.join(" "),
        player.seasons.join(" "),
        player.mergeCandidates.map((row) => row.otherName).join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(queryNorm);
    });

    if (sortMode === "name-asc") {
      rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    } else if (sortMode === "merge-desc") {
      rows.sort(
        (a, b) =>
          b.mergeCandidates.length - a.mergeCandidates.length ||
          b.matchesPlayed - a.matchesPlayed ||
          a.displayName.localeCompare(b.displayName),
      );
    } else {
      rows.sort(
        (a, b) =>
          b.matchesPlayed - a.matchesPlayed ||
          b.wins - a.wins ||
          a.displayName.localeCompare(b.displayName),
      );
    }

    return rows;
  }, [
    countryFilter,
    genderFilter,
    initialOverview.players,
    mergeFilter,
    minMatches,
    query,
    seasonFilter,
    sortMode,
    sourceFilter,
  ]);

  const limit = Number.parseInt(rowLimit, 10);
  const appliedLimit = Number.isFinite(limit) && limit > 0 ? limit : filtered.length;
  const visibleRows = filtered.slice(0, appliedLimit);

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
              Search and filter canonical players with merge candidates, matches, scores,
              and inferred gender.
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
          <strong className="text-2xl leading-tight text-slate-900">
            {initialOverview.totals.players}
          </strong>
          <small className="text-sm text-slate-600">from TTBL + WTT sources</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            With Merge Candidates
          </span>
          <strong className="text-2xl leading-tight text-slate-900">
            {initialOverview.totals.withMergeCandidates}
          </strong>
          <small className="text-sm text-slate-600">needs manual review</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Known Gender
          </span>
          <strong className="text-2xl leading-tight text-slate-900">
            {initialOverview.totals.withKnownGender}
          </strong>
          <small className="text-sm text-slate-600">inferred from WTT event labels</small>
        </article>
        <article className="grid gap-1 rounded-2xl border border-slate-300 bg-slate-50 p-4">
          <span className="font-mono text-xs uppercase tracking-[0.08em] text-slate-500">
            Filtered Rows
          </span>
          <strong className="text-2xl leading-tight text-slate-900">{visibleRows.length}</strong>
          <small className="text-sm text-slate-600">
            of {filtered.length}
            {filtered.length > visibleRows.length ? " (limited)" : ""}
          </small>
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
              type="number"
              min={0}
              value={minMatches}
              onChange={(e) => setMinMatches(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Sort
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
            >
              <option value="matches-desc">Most matches</option>
              <option value="merge-desc">Most merge candidates</option>
              <option value="name-asc">Name A-Z</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            Row Limit
            <select
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              value={rowLimit}
              onChange={(e) => setRowLimit(e.target.value)}
            >
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="500">500</option>
              <option value="-1">All</option>
            </select>
          </label>
        </div>
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
              {visibleRows.map((player) => (
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
      </section>
    </main>
  );
}
