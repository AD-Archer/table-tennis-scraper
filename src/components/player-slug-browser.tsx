"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlayerGender, PlayerSlugRow, PlayerSourceMemberDetail } from "@/lib/types";

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

interface SourceProfilesApiResponse {
  ok: boolean;
  canonical?: {
    canonicalKey: string;
    displayName: string;
  };
  members?: PlayerSourceMemberDetail[];
  error?: string;
}

interface LoadedSourceProfiles {
  canonical: {
    canonicalKey: string;
    displayName: string;
  };
  members: PlayerSourceMemberDetail[];
}

interface CountryMatchApiResponse {
  ok: boolean;
  comparison?: {
    compatible: boolean;
  } | null;
}

interface CanonicalSummary {
  canonicalKey: string;
  displayName: string;
  nameKey: string | null;
  sourceIds: string[];
  names: string[];
  seasons: string[];
  countries: string[];
  genders: string[];
  dobs: string[];
}

interface ClosenessCheck {
  label: string;
  status: "match" | "warn" | "block" | "missing";
  detail: string;
}

interface ClosenessEvaluation {
  score: number;
  checks: ClosenessCheck[];
}

interface ComparePayload {
  leftRaw: LoadedSourceProfiles;
  rightRaw: LoadedSourceProfiles;
  left: CanonicalSummary;
  right: CanonicalSummary;
  evaluation: ClosenessEvaluation;
  countryCompatible: boolean | null;
}

function fmtRate(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return `${value.toFixed(1)}%`;
}

function formatNullable(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function formatBirthday(unixSeconds: number | null | undefined): string {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) {
    return "-";
  }

  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toISOString().slice(0, 10);
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((row) => (row ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function normalizeNameToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(displayName: string): { given: string; surname: string } {
  const parts = normalizeNameToken(displayName).split(" ").filter(Boolean);
  if (parts.length === 0) {
    return { given: "", surname: "" };
  }

  if (parts.length === 1) {
    return { given: "", surname: parts[0] ?? "" };
  }

  return {
    given: parts.slice(0, -1).join(" "),
    surname: parts[parts.length - 1] ?? "",
  };
}

function normalizeDob(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) {
    return null;
  }

  const direct = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct?.[0]) {
    return direct[0];
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function summarizeCanonicalProfile(payload: LoadedSourceProfiles): CanonicalSummary {
  const sourceIds = payload.members.map((member) => `${member.source}:${member.sourceId}`);
  const names = payload.members.flatMap((member) => member.names);
  const seasons = payload.members.flatMap((member) => member.seasons);
  const countries: Array<string | null | undefined> = [];
  const genders: Array<string | null | undefined> = [];
  const dobs: Array<string | null | undefined> = [];

  for (const member of payload.members) {
    if (member.ttblProfile) {
      countries.push(member.ttblProfile.nationality, member.ttblProfile.nationalitySecondary);
      genders.push("M");
      const ttblDob = formatBirthday(member.ttblProfile.birthdayUnix);
      if (ttblDob !== "-") {
        dobs.push(ttblDob);
      }
    }

    if (member.wttProfile) {
      countries.push(member.wttProfile.nationality, member.wttProfile.country_name);
      genders.push(member.wttProfile.gender);
      dobs.push(normalizeDob(member.wttProfile.dob));
    }
  }

  const canonicalNameParts = splitName(payload.canonical.displayName);

  return {
    canonicalKey: payload.canonical.canonicalKey,
    displayName: payload.canonical.displayName,
    nameKey:
      canonicalNameParts.surname && canonicalNameParts.given
        ? `${canonicalNameParts.surname}|${canonicalNameParts.given}`
        : null,
    sourceIds: uniqueSorted(sourceIds),
    names: uniqueSorted(names),
    seasons: uniqueSorted(seasons),
    countries: uniqueSorted(countries),
    genders: uniqueSorted(genders),
    dobs: uniqueSorted(dobs),
  };
}

function evaluateCloseness(
  left: CanonicalSummary,
  right: CanonicalSummary,
  countryCompatible: boolean | null,
): ClosenessEvaluation {
  const checks: ClosenessCheck[] = [];
  let score = 40;

  const leftName = splitName(left.displayName);
  const rightName = splitName(right.displayName);
  const sameSurname = leftName.surname && leftName.surname === rightName.surname;
  const sameGiven = leftName.given && leftName.given === rightName.given;
  const exactDisplay = normalizeNameToken(left.displayName) === normalizeNameToken(right.displayName);

  if (exactDisplay || (sameSurname && sameGiven)) {
    score += 30;
    checks.push({
      label: "Name",
      status: "match",
      detail: "Same surname + given name.",
    });
  } else if (sameSurname) {
    score += 10;
    checks.push({
      label: "Name",
      status: "warn",
      detail: "Same surname but given name differs.",
    });
  } else {
    score -= 20;
    checks.push({
      label: "Name",
      status: "block",
      detail: "Surname differs.",
    });
  }

  if (left.countries.length === 0 || right.countries.length === 0) {
    checks.push({
      label: "Country",
      status: "missing",
      detail: "One side has no country value.",
    });
  } else if (countryCompatible === true) {
    score += 15;
    checks.push({
      label: "Country",
      status: "match",
      detail: "Country values are alias-compatible.",
    });
  } else if (countryCompatible === false) {
    score -= 25;
    checks.push({
      label: "Country",
      status: "block",
      detail: "Country values conflict.",
    });
  } else {
    checks.push({
      label: "Country",
      status: "warn",
      detail: "Compatibility check unavailable.",
    });
  }

  const leftGender = left.genders[0] ?? null;
  const rightGender = right.genders[0] ?? null;
  if (!leftGender || !rightGender) {
    checks.push({
      label: "Gender",
      status: "missing",
      detail: "One side has no gender value.",
    });
  } else if (leftGender === rightGender) {
    score += 10;
    checks.push({
      label: "Gender",
      status: "match",
      detail: `Both resolve to ${leftGender}.`,
    });
  } else {
    score -= 15;
    checks.push({
      label: "Gender",
      status: "block",
      detail: `${leftGender} vs ${rightGender}.`,
    });
  }

  const leftDobSet = new Set(left.dobs);
  const rightDobSet = new Set(right.dobs);
  const dobOverlap = [...leftDobSet].some((row) => rightDobSet.has(row));
  if (left.dobs.length === 0 || right.dobs.length === 0) {
    checks.push({
      label: "DOB",
      status: "missing",
      detail: "One side has no DOB value.",
    });
  } else if (dobOverlap) {
    score += 10;
    checks.push({
      label: "DOB",
      status: "match",
      detail: "At least one DOB value matches.",
    });
  } else {
    score -= 20;
    checks.push({
      label: "DOB",
      status: "block",
      detail: "DOB values do not overlap.",
    });
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    checks,
  };
}

function statusChipClass(status: ClosenessCheck["status"]): string {
  if (status === "match") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800";
  }

  if (status === "block") {
    return "border-rose-300 bg-rose-50 text-rose-800";
  }

  if (status === "warn") {
    return "border-amber-300 bg-amber-50 text-amber-800";
  }

  return "border-slate-300 bg-slate-50 text-slate-700";
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

  const [profileTarget, setProfileTarget] = useState<PlayerSlugRow | null>(null);
  const [profileMembers, setProfileMembers] = useState<PlayerSourceMemberDetail[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [compareTarget, setCompareTarget] = useState<{
    leftPlayer: PlayerSlugRow;
    rightCandidate: PlayerSlugRow["mergeCandidates"][number];
  } | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparePayload, setComparePayload] = useState<ComparePayload | null>(null);
  const [compareCopyStatus, setCompareCopyStatus] = useState<string | null>(null);

  const latestRequestRef = useRef(0);

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const requestId = latestRequestRef.current + 1;
      latestRequestRef.current = requestId;
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

        if (requestId !== latestRequestRef.current) {
          return;
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
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setError(fetchError instanceof Error ? fetchError.message : "unknown error");
      } finally {
        if (requestId === latestRequestRef.current) {
          setLoading(false);
        }
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

  const loadSourceProfiles = useCallback(async (canonicalKey: string): Promise<LoadedSourceProfiles> => {
    const params = new URLSearchParams({
      canonicalKey,
    });
    const response = await fetch(`/api/players/source-profiles?${params.toString()}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as SourceProfilesApiResponse;
    if (!response.ok || !payload.ok || !payload.canonical) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }

    return {
      canonical: payload.canonical,
      members: payload.members ?? [],
    };
  }, []);

  const openProfileModal = useCallback(async (player: PlayerSlugRow) => {
    setProfileTarget(player);
    setProfileMembers([]);
    setProfileError(null);
    setProfileLoading(true);

    try {
      const payload = await loadSourceProfiles(player.canonicalKey);
      setProfileMembers(payload.members);
    } catch (fetchError) {
      setProfileError(fetchError instanceof Error ? fetchError.message : "unknown error");
    } finally {
      setProfileLoading(false);
    }
  }, [loadSourceProfiles]);

  const openCompareModal = useCallback(
    async (leftPlayer: PlayerSlugRow, rightCandidate: PlayerSlugRow["mergeCandidates"][number]) => {
      setCompareTarget({ leftPlayer, rightCandidate });
      setCompareLoading(true);
      setCompareError(null);
      setComparePayload(null);
      setCompareCopyStatus(null);

      try {
        const [leftRaw, rightRaw] = await Promise.all([
          loadSourceProfiles(leftPlayer.canonicalKey),
          loadSourceProfiles(rightCandidate.otherCanonicalKey),
        ]);

        const left = summarizeCanonicalProfile(leftRaw);
        const right = summarizeCanonicalProfile(rightRaw);

        let countryCompatible: boolean | null = null;
        const leftCountry = left.countries[0] ?? null;
        const rightCountry = right.countries[0] ?? null;
        if (leftCountry && rightCountry) {
          const params = new URLSearchParams({ left: leftCountry, right: rightCountry });
          const response = await fetch(`/api/countries/match?${params.toString()}`, {
            cache: "no-store",
          });
          const payload = (await response.json()) as CountryMatchApiResponse;
          if (response.ok && payload.ok) {
            countryCompatible = payload.comparison?.compatible ?? null;
          }
        }

        const evaluation = evaluateCloseness(left, right, countryCompatible);
        setComparePayload({
          leftRaw,
          rightRaw,
          left,
          right,
          evaluation,
          countryCompatible,
        });
      } catch (fetchError) {
        setCompareError(fetchError instanceof Error ? fetchError.message : "unknown error");
      } finally {
        setCompareLoading(false);
      }
    },
    [loadSourceProfiles],
  );

  const copyCompareJson = useCallback(async (label: string, value: unknown) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      setCompareCopyStatus(`${label} copied`);
      window.setTimeout(() => {
        setCompareCopyStatus((prev) => (prev === `${label} copied` ? null : prev));
      }, 1500);
    } catch {
      setCompareCopyStatus("Copy failed");
      window.setTimeout(() => {
        setCompareCopyStatus((prev) => (prev === "Copy failed" ? null : prev));
      }, 1500);
    }
  }, []);

  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  return (
    <main className="mx-auto my-8 grid w-[min(1400px,calc(100%-2rem))] gap-4">
      <section className="rounded-2xl border border-slate-300 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-teal-700">
              TTBL + WTT Players
            </p>
            <h1 className="m-0 text-3xl font-semibold leading-tight text-slate-900">
              Player Explorer & Source Audit
            </h1>
            <p className="mt-2 mb-0 max-w-3xl text-sm text-slate-600">
              Server-side filters + sorting, loaded in pages of {PAGE_SIZE}. Country matching is
              alias-aware (for example DEU/GER, NGA/NGR, and AIN/RUS compatibility).
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
                    <div className="mt-1">
                      <button
                        className="h-7 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-100"
                        onClick={() => void openProfileModal(player)}
                        type="button"
                      >
                        Source profiles
                      </button>
                    </div>
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
                        {player.mergeCandidates.slice(0, 4).map((candidate, index) => (
                          <div key={`${candidate.otherCanonicalKey}:${candidate.reason}:${index}`}>
                            <strong>{candidate.otherName}</strong>
                            <div className="text-xs text-slate-500">{candidate.reason}</div>
                            <button
                              className="mt-1 h-7 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-100"
                              onClick={() => void openCompareModal(player, candidate)}
                              type="button"
                            >
                              Compare closeness
                            </button>
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
                              {match.outcome ?? "-"} {match.score ?? "-"} vs {" "}
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

      {profileTarget ? (
        <section className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4">
          <div className="max-h-[90vh] w-[min(980px,100%)] overflow-auto rounded-2xl border border-slate-300 bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-teal-700">
                  Source Profiles
                </p>
                <h3 className="m-0 text-2xl font-semibold text-slate-900">{profileTarget.displayName}</h3>
                <p className="m-0 text-xs text-slate-600">
                  <code>{profileTarget.canonicalKey}</code>
                </p>
              </div>
              <button
                className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 hover:bg-slate-100"
                onClick={() => {
                  setProfileTarget(null);
                  setProfileMembers([]);
                  setProfileError(null);
                }}
                type="button"
              >
                Close
              </button>
            </div>

            {profileLoading ? <p className="mt-4 mb-0 text-sm text-slate-600">Loading source profiles...</p> : null}
            {profileError ? <p className="mt-4 mb-0 text-sm text-rose-700">Error: {profileError}</p> : null}

            {!profileLoading && !profileError ? (
              <div className="mt-4 grid gap-3">
                {profileMembers.length === 0 ? (
                  <p className="m-0 text-sm text-slate-600">No source profiles found.</p>
                ) : (
                  profileMembers.map((member) => (
                    <article
                      key={`${member.source}:${member.sourceId}:${member.sourceKey}`}
                      className="rounded-xl border border-slate-300 bg-slate-50 p-3"
                    >
                      <div className="grid gap-1 text-sm text-slate-700">
                        <div>
                          <strong>Source:</strong> {member.source.toUpperCase()} | <strong>ID:</strong> <code>{member.sourceId}</code>
                        </div>
                        <div>
                          <strong>Names:</strong> {member.names.join(", ")}
                        </div>
                        <div>
                          <strong>Seasons:</strong> {member.seasons.length > 0 ? member.seasons.join(", ") : "-"}
                        </div>
                      </div>

                      {member.source === "ttbl" ? (
                        member.ttblProfile ? (
                          <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
                            <div><strong>Nationality:</strong> {formatNullable(member.ttblProfile.nationality)}</div>
                            <div><strong>Birthday:</strong> {formatBirthday(member.ttblProfile.birthdayUnix)}</div>
                            <div><strong>Current Club:</strong> {formatNullable(member.ttblProfile.currentClub)}</div>
                            <div><strong>Season Label:</strong> {formatNullable(member.ttblProfile.seasonLabel)}</div>
                            <div><strong>Stable Player ID:</strong> {formatNullable(member.ttblProfile.stablePlayerId)}</div>
                          </div>
                        ) : (
                          <p className="mt-3 mb-0 text-sm text-slate-600">TTBL profile fields not yet cached for this source ID.</p>
                        )
                      ) : member.wttProfile ? (
                        <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2">
                          <div><strong>WTT Full Name:</strong> {formatNullable(member.wttProfile.full_name)}</div>
                          <div><strong>Nationality:</strong> {formatNullable(member.wttProfile.nationality)}</div>
                          <div><strong>Country Name:</strong> {formatNullable(member.wttProfile.country_name)}</div>
                          <div><strong>DOB:</strong> {formatNullable(member.wttProfile.dob)}</div>
                          <div><strong>Gender:</strong> {formatNullable(member.wttProfile.gender)}</div>
                          <div><strong>Organization:</strong> {formatNullable(member.wttProfile.organization_name)}</div>
                          <div><strong>World Ranking:</strong> {formatNullable(member.wttProfile.world_ranking)}</div>
                          <div><strong>Career Matches:</strong> {member.wttProfile.stats.matches_played}</div>
                        </div>
                      ) : (
                        <p className="mt-3 mb-0 text-sm text-slate-600">WTT profile fields not found for this source ID.</p>
                      )}
                    </article>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {compareTarget ? (
        <section className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4">
          <div className="max-h-[90vh] w-[min(1100px,100%)] overflow-auto rounded-2xl border border-slate-300 bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="m-0 font-mono text-xs uppercase tracking-[0.12em] text-teal-700">
                  Merge Closeness
                </p>
                <h3 className="m-0 text-2xl font-semibold text-slate-900">
                  {compareTarget.leftPlayer.displayName} vs {compareTarget.rightCandidate.otherName}
                </h3>
                <p className="m-0 text-xs text-slate-600">{compareTarget.rightCandidate.reason}</p>
              </div>
              <button
                className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900 hover:bg-slate-100"
                onClick={() => {
                  setCompareTarget(null);
                  setComparePayload(null);
                  setCompareError(null);
                }}
                type="button"
              >
                Close
              </button>
            </div>

            {compareLoading ? (
              <p className="mt-4 mb-0 text-sm text-slate-600">Loading comparison...</p>
            ) : null}
            {compareError ? (
              <p className="mt-4 mb-0 text-sm text-rose-700">Error: {compareError}</p>
            ) : null}

            {!compareLoading && !compareError && comparePayload ? (
              <div className="mt-4 grid gap-4">
                <article className="rounded-xl border border-slate-300 bg-slate-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <strong className="text-slate-900">Closeness Score</strong>
                    <span className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-sm font-semibold text-slate-900">
                      {comparePayload.evaluation.score}/100
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {comparePayload.evaluation.checks.map((check) => (
                      <span
                        key={`${check.label}:${check.detail}`}
                        className={`rounded-md border px-2 py-1 text-xs ${statusChipClass(check.status)}`}
                      >
                        {check.label}: {check.detail}
                      </span>
                    ))}
                  </div>
                </article>

                <article className="overflow-x-auto rounded-xl border border-slate-300 bg-white">
                  <table className="w-full border-collapse text-sm">
                    <thead className="border-b border-slate-300 bg-slate-50 text-left">
                      <tr>
                        <th className="px-2 py-2">Field</th>
                        <th className="px-2 py-2">{comparePayload.left.displayName}</th>
                        <th className="px-2 py-2">{comparePayload.right.displayName}</th>
                      </tr>
                    </thead>
                    <tbody className="[&_tr]:border-b [&_tr]:border-slate-200">
                      <tr>
                        <td className="px-2 py-2">Canonical Key</td>
                        <td className="px-2 py-2"><code>{comparePayload.left.canonicalKey}</code></td>
                        <td className="px-2 py-2"><code>{comparePayload.right.canonicalKey}</code></td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">Name Key</td>
                        <td className="px-2 py-2">{comparePayload.left.nameKey ?? "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.nameKey ?? "-"}</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">Source IDs</td>
                        <td className="px-2 py-2">{comparePayload.left.sourceIds.join(", ") || "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.sourceIds.join(", ") || "-"}</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">Known Names</td>
                        <td className="px-2 py-2">{comparePayload.left.names.join(", ") || "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.names.join(", ") || "-"}</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">Countries</td>
                        <td className="px-2 py-2">{comparePayload.left.countries.join(", ") || "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.countries.join(", ") || "-"}</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">Genders</td>
                        <td className="px-2 py-2">{comparePayload.left.genders.join(", ") || "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.genders.join(", ") || "-"}</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">DOBs</td>
                        <td className="px-2 py-2">{comparePayload.left.dobs.join(", ") || "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.dobs.join(", ") || "-"}</td>
                      </tr>
                      <tr>
                        <td className="px-2 py-2">Seasons/Years</td>
                        <td className="px-2 py-2">{comparePayload.left.seasons.join(", ") || "-"}</td>
                        <td className="px-2 py-2">{comparePayload.right.seasons.join(", ") || "-"}</td>
                      </tr>
                    </tbody>
                  </table>
                </article>

                <article className="rounded-xl border border-slate-300 bg-slate-50 p-3">
                  <details>
                    <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                      Raw JSON (for debugging/AI)
                    </summary>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      {compareCopyStatus ? (
                        <p className="m-0 text-xs font-medium text-slate-700">{compareCopyStatus}</p>
                      ) : (
                        <span />
                      )}
                      <button
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                        onClick={() => {
                          void copyCompareJson("Both JSON", {
                            left: comparePayload.leftRaw,
                            right: comparePayload.rightRaw,
                          });
                        }}
                        type="button"
                      >
                        Copy both
                      </button>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
                            Left
                          </p>
                          <button
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            onClick={() => {
                              void copyCompareJson("Left JSON", comparePayload.leftRaw);
                            }}
                            type="button"
                          >
                            Copy
                          </button>
                        </div>
                        <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-slate-300 bg-white p-2 text-xs">
                          {JSON.stringify(comparePayload.leftRaw, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
                            Right
                          </p>
                          <button
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                            onClick={() => {
                              void copyCompareJson("Right JSON", comparePayload.rightRaw);
                            }}
                            type="button"
                          >
                            Copy
                          </button>
                        </div>
                        <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-slate-300 bg-white p-2 text-xs">
                          {JSON.stringify(comparePayload.rightRaw, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </details>
                </article>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
