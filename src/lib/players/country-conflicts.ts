import { areCountriesCompatible, describeCountry, normalizeCountryCode } from "@/lib/normalization/country";
import { getPlayerSlugOverview } from "@/lib/players/slugs";
import { PlayerCountrySource, PlayerGender } from "@/lib/types";

export interface CountryConflictRow {
  key: string;
  reason: string;
  leftCanonicalKey: string;
  rightCanonicalKey: string;
  leftName: string;
  rightName: string;
  leftCountry: string | null;
  rightCountry: string | null;
  leftCountrySource: PlayerCountrySource;
  rightCountrySource: PlayerCountrySource;
  leftGender: PlayerGender;
  rightGender: PlayerGender;
  countriesCompatible: boolean | null;
  leftCountryDetail: ReturnType<typeof describeCountry> | null;
  rightCountryDetail: ReturnType<typeof describeCountry> | null;
}

export interface CountryConflictReport {
  generatedAt: string;
  totals: {
    players: number;
    candidatePairs: number;
    countryConflictPairs: number;
    returned: number;
  };
  conflicts: CountryConflictRow[];
}

interface BuildCountryConflictReportOptions {
  limit?: number;
  includeCompatible?: boolean;
  includeCountryDetail?: boolean;
}

function isCountryConflictReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes("country mismatch") || normalized.includes("conflicting country/gender");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function buildCountryConflictReport(
  options: BuildCountryConflictReportOptions = {},
): Promise<CountryConflictReport> {
  const limit = clamp(Number(options.limit ?? 100), 1, 500);
  const includeCompatible = options.includeCompatible === true;
  const includeCountryDetail = options.includeCountryDetail === true;

  const overview = await getPlayerSlugOverview(0);
  const byCanonicalKey = new Map(overview.players.map((row) => [row.canonicalKey, row]));

  const seen = new Set<string>();
  let candidatePairs = 0;
  const conflicts: CountryConflictRow[] = [];

  for (const left of overview.players) {
    for (const candidate of left.mergeCandidates) {
      candidatePairs += 1;
      if (!isCountryConflictReason(candidate.reason)) {
        continue;
      }

      const right = byCanonicalKey.get(candidate.otherCanonicalKey);
      if (!right) {
        continue;
      }

      const key = [left.canonicalKey, right.canonicalKey].sort().join("::");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const leftCountry = normalizeCountryCode(left.country);
      const rightCountry = normalizeCountryCode(right.country);
      const countriesCompatible =
        leftCountry && rightCountry ? areCountriesCompatible(leftCountry, rightCountry) : null;

      if (!includeCompatible && countriesCompatible === true) {
        continue;
      }

      conflicts.push({
        key,
        reason: candidate.reason,
        leftCanonicalKey: left.canonicalKey,
        rightCanonicalKey: right.canonicalKey,
        leftName: left.displayName,
        rightName: right.displayName,
        leftCountry,
        rightCountry,
        leftCountrySource: left.countrySource,
        rightCountrySource: right.countrySource,
        leftGender: left.gender,
        rightGender: right.gender,
        countriesCompatible,
        leftCountryDetail: includeCountryDetail && leftCountry ? describeCountry(leftCountry) : null,
        rightCountryDetail: includeCountryDetail && rightCountry ? describeCountry(rightCountry) : null,
      });
    }
  }

  conflicts.sort(
    (a, b) =>
      (a.countriesCompatible === false ? 0 : 1) - (b.countriesCompatible === false ? 0 : 1) ||
      a.leftName.localeCompare(b.leftName) ||
      a.rightName.localeCompare(b.rightName),
  );

  return {
    generatedAt: overview.generatedAt,
    totals: {
      players: overview.players.length,
      candidatePairs,
      countryConflictPairs: conflicts.length,
      returned: Math.min(conflicts.length, limit),
    },
    conflicts: conflicts.slice(0, limit),
  };
}
