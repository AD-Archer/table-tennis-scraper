import { PlayerCountrySource, PlayerGender, PlayerGenderSource } from "@/lib/types";

export const PLAYER_FIELD_MAPPING_VERSION = "2026-02-27";

export type CanonicalNormalizerName =
  | "text_trim"
  | "country_code"
  | "gender_code"
  | "date_iso"
  | "height_cm"
  | "weight_kg";

export interface CanonicalFieldMappingEntry {
  field: string;
  description: string;
  normalizer: CanonicalNormalizerName;
  valueType: string;
  sourcePaths: Record<string, string[]>;
  preferredSourceOrder: string[];
  notes?: string;
}

export interface CanonicalFieldNormalizationResult {
  field: string;
  normalizer: CanonicalNormalizerName | "unknown";
  input: unknown;
  source: string | null;
  unit: string | null;
  normalized: unknown;
  warnings: string[];
}

interface NormalizeFieldOptions {
  source?: string | null;
  unit?: string | null;
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  germany: "DEU",
  deutschland: "DEU",
  sweden: "SWE",
  sverige: "SWE",
  france: "FRA",
  japan: "JPN",
  china: "CHN",
  korea: "KOR",
  "south korea": "KOR",
  "korea republic": "KOR",
  austria: "AUT",
  poland: "POL",
  portugal: "POR",
  spain: "ESP",
  belgium: "BEL",
  england: "ENG",
  "united kingdom": "GBR",
  "great britain": "GBR",
  "united states": "USA",
  usa: "USA",
};

const COUNTRY_2_TO_3: Record<string, string> = {
  DE: "DEU",
  SE: "SWE",
  FR: "FRA",
  JP: "JPN",
  CN: "CHN",
  KR: "KOR",
  AT: "AUT",
  PL: "POL",
  PT: "POR",
  ES: "ESP",
  BE: "BEL",
  GB: "GBR",
  UK: "GBR",
  US: "USA",
};

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const compact = value.replace(/,/g, ".").trim();
  const match = compact.match(/-?\d+(\.\d+)?/);
  if (!match?.[0]) {
    return null;
  }

  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const upper = cleaned.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) {
    return upper;
  }
  if (/^[A-Z]{2}$/.test(upper)) {
    return COUNTRY_2_TO_3[upper] ?? upper;
  }

  const code = COUNTRY_NAME_TO_CODE[cleaned.toLowerCase()];
  if (code) {
    return code;
  }

  return upper;
}

function normalizeGenderCode(value: unknown): PlayerGender | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = cleanText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/^(m|male|men|man)$/.test(normalized)) {
    return "M";
  }
  if (/^(w|f|female|women|woman)$/.test(normalized)) {
    return "W";
  }
  if (/^(mixed|x|xd)$/.test(normalized)) {
    return "mixed";
  }
  if (normalized === "unknown") {
    return "unknown";
  }

  return null;
}

function normalizeDateIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value >= 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date.toISOString().slice(0, 10);
  }

  if (typeof value !== "string") {
    return null;
  }

  const cleaned = cleanText(value.replace(/^\*\s*/, ""));
  if (!cleaned) {
    return null;
  }

  const dotted = cleaned.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    const day = Number.parseInt(dotted[1] ?? "", 10);
    const month = Number.parseInt(dotted[2] ?? "", 10);
    const year = Number.parseInt(dotted[3] ?? "", 10);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  const slashed = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashed) {
    const left = Number.parseInt(slashed[1] ?? "", 10);
    const middle = Number.parseInt(slashed[2] ?? "", 10);
    const year = Number.parseInt(slashed[3] ?? "", 10);
    const month = left > 12 ? middle : left;
    const day = left > 12 ? left : middle;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function normalizeUnitToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeHeightCm(value: unknown, explicitUnit?: string | null): number | null {
  const unit = normalizeUnitToken(explicitUnit);

  if (typeof value === "string") {
    const feetInches = value.match(/(\d+)\s*(?:ft|')\s*(\d+(?:\.\d+)?)?\s*(?:in|\"|”)?/i);
    if (feetInches?.[1]) {
      const feet = Number.parseFloat(feetInches[1]);
      const inches = Number.parseFloat(feetInches[2] ?? "0");
      if (Number.isFinite(feet) && Number.isFinite(inches)) {
        return Math.round((feet * 30.48 + inches * 2.54) * 10) / 10;
      }
    }
  }

  const raw = parseNumberish(value);
  if (raw === null) {
    return null;
  }

  if (unit === "m" || unit === "meter" || unit === "meters") {
    return Math.round(raw * 1000) / 10;
  }
  if (unit === "in" || unit === "inch" || unit === "inches") {
    return Math.round(raw * 25.4) / 10;
  }
  if (unit === "ft" || unit === "foot" || unit === "feet") {
    return Math.round(raw * 304.8) / 10;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized.includes("cm")) {
      return Math.round(raw * 10) / 10;
    }
    if (normalized.includes("in")) {
      return Math.round(raw * 25.4) / 10;
    }
    if (normalized.includes("ft")) {
      return Math.round(raw * 304.8) / 10;
    }
    if (/\d+\s*m\b/.test(normalized)) {
      return Math.round(raw * 1000) / 10;
    }
  }

  if (raw <= 3.5) {
    return Math.round(raw * 1000) / 10;
  }

  return Math.round(raw * 10) / 10;
}

function normalizeWeightKg(value: unknown, explicitUnit?: string | null): number | null {
  const unit = normalizeUnitToken(explicitUnit);
  const raw = parseNumberish(value);
  if (raw === null) {
    return null;
  }

  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    return Math.round(raw * 0.45359237 * 10) / 10;
  }
  if (unit === "st" || unit === "stone") {
    return Math.round(raw * 6.35029318 * 10) / 10;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized.includes("lb") || normalized.includes("pound")) {
      return Math.round(raw * 0.45359237 * 10) / 10;
    }
    if (normalized.includes("stone") || normalized.includes("st")) {
      return Math.round(raw * 6.35029318 * 10) / 10;
    }
  }

  return Math.round(raw * 10) / 10;
}

export const PLAYER_FIELD_MAPPING: CanonicalFieldMappingEntry[] = [
  {
    field: "displayName",
    description: "Canonical player display name",
    normalizer: "text_trim",
    valueType: "string",
    sourcePaths: {
      ttbl: ["seasonPlayer.firstName + seasonPlayer.lastName", "player.name"],
      wtt: ["full_name", "first_name + last_name"],
    },
    preferredSourceOrder: ["wtt", "ttbl"],
  },
  {
    field: "country",
    description: "Country / association normalized to uppercase code",
    normalizer: "country_code",
    valueType: "string|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.nationality"],
      wtt: ["nationality"],
    },
    preferredSourceOrder: ["wtt", "ttbl"],
  },
  {
    field: "gender",
    description: "Gender code",
    normalizer: "gender_code",
    valueType: "M|W|mixed|unknown",
    sourcePaths: {
      ttbl: ["(no explicit field, fallback rule)"],
      wtt: ["inferred from match event labels"],
    },
    preferredSourceOrder: ["wtt", "ttbl"],
    notes: "TTBL currently has no explicit gender field in our scrape payload.",
  },
  {
    field: "birthDate",
    description: "Birth date normalized to YYYY-MM-DD",
    normalizer: "date_iso",
    valueType: "string|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.birthday (unix seconds)"],
      wtt: ["dob"],
    },
    preferredSourceOrder: ["wtt", "ttbl"],
  },
  {
    field: "heightCm",
    description: "Height in centimeters",
    normalizer: "height_cm",
    valueType: "number|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.height"],
      wtt: ["(future source)"],
    },
    preferredSourceOrder: ["ttbl", "wtt"],
  },
  {
    field: "weightKg",
    description: "Weight in kilograms",
    normalizer: "weight_kg",
    valueType: "number|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.weight"],
      wtt: ["(future source)"],
    },
    preferredSourceOrder: ["ttbl", "wtt"],
  },
  {
    field: "hand",
    description: "Playing hand",
    normalizer: "text_trim",
    valueType: "string|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.hand"],
      wtt: ["(future source)"],
    },
    preferredSourceOrder: ["ttbl", "wtt"],
  },
  {
    field: "racketPosture",
    description: "Racket posture (grip style)",
    normalizer: "text_trim",
    valueType: "string|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.racketPosture"],
      wtt: ["(future source)"],
    },
    preferredSourceOrder: ["ttbl", "wtt"],
  },
  {
    field: "currentClub",
    description: "Current club/team",
    normalizer: "text_trim",
    valueType: "string|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.seasonTeam.name"],
      wtt: ["team"],
    },
    preferredSourceOrder: ["ttbl", "wtt"],
  },
  {
    field: "outfitter",
    description: "Outfitter / equipment sponsor",
    normalizer: "text_trim",
    valueType: "string|null",
    sourcePaths: {
      ttbl: ["seasonPlayer.outfitter.company"],
      wtt: ["(future source)"],
    },
    preferredSourceOrder: ["ttbl", "wtt"],
  },
];

export function getPlayerFieldMappingContract(): {
  version: string;
  entity: "player";
  fields: CanonicalFieldMappingEntry[];
} {
  return {
    version: PLAYER_FIELD_MAPPING_VERSION,
    entity: "player",
    fields: PLAYER_FIELD_MAPPING,
  };
}

export function resolveCanonicalCountry(
  signals: {
    wttNationality: string | null;
    ttblNationality: string | null;
  },
): { country: string | null; source: PlayerCountrySource } {
  const fromWtt = normalizeCountryCode(signals.wttNationality);
  if (fromWtt) {
    return { country: fromWtt, source: "wtt_profile_nationality" };
  }

  const fromTtbl = normalizeCountryCode(signals.ttblNationality);
  if (fromTtbl) {
    return { country: fromTtbl, source: "ttbl_profile_nationality" };
  }

  return { country: null, source: "unknown" };
}

export function resolveCanonicalGender(
  signals: {
    eventInferredGender: PlayerGender;
    wttProfileGender: PlayerGender;
    hasTTBLMember: boolean;
  },
): { gender: PlayerGender; source: PlayerGenderSource } {
  if (signals.eventInferredGender !== "unknown") {
    return {
      gender: signals.eventInferredGender,
      source: "wtt_event_inference",
    };
  }

  if (signals.wttProfileGender !== "unknown") {
    return {
      gender: signals.wttProfileGender,
      source: "wtt_profile_gender",
    };
  }

  if (signals.hasTTBLMember) {
    return {
      gender: "M",
      source: "ttbl_default_assumption",
    };
  }

  return {
    gender: "unknown",
    source: "unknown",
  };
}

export function normalizeCanonicalField(
  field: string,
  value: unknown,
  options: NormalizeFieldOptions = {},
): CanonicalFieldNormalizationResult {
  const normalizedField = field.trim();
  const mapping = PLAYER_FIELD_MAPPING.find(
    (row) => row.field.toLowerCase() === normalizedField.toLowerCase(),
  );

  if (!mapping) {
    return {
      field: normalizedField,
      normalizer: "unknown",
      input: value,
      source: options.source ?? null,
      unit: options.unit ?? null,
      normalized: value,
      warnings: [`Unknown field '${normalizedField}'.`],
    };
  }

  let normalized: unknown = null;
  const warnings: string[] = [];

  if (mapping.normalizer === "country_code") {
    normalized = normalizeCountryCode(value);
  } else if (mapping.normalizer === "gender_code") {
    normalized = normalizeGenderCode(value);
  } else if (mapping.normalizer === "date_iso") {
    normalized = normalizeDateIso(value);
  } else if (mapping.normalizer === "height_cm") {
    normalized = normalizeHeightCm(value, options.unit);
  } else if (mapping.normalizer === "weight_kg") {
    normalized = normalizeWeightKg(value, options.unit);
  } else if (mapping.normalizer === "text_trim") {
    normalized = typeof value === "string" ? cleanText(value) || null : null;
  }

  if (normalized === null && value !== null && value !== undefined && value !== "") {
    warnings.push(
      `Value could not be normalized for field '${mapping.field}' using '${mapping.normalizer}'.`,
    );
  }

  return {
    field: mapping.field,
    normalizer: mapping.normalizer,
    input: value,
    source: options.source ?? null,
    unit: options.unit ?? null,
    normalized,
    warnings,
  };
}
