interface CanonicalCountryRow {
  code: string;
  name: string;
  aliases: string[];
  names: string[];
}

const CANONICAL_COUNTRIES: CanonicalCountryRow[] = [
  { code: "AIN", name: "Authorised Neutral Athlete", aliases: ["AIN"], names: ["AUTHORIZED NEUTRAL ATHLETE", "AUTHORISED NEUTRAL ATHLETE", "NEUTRAL ATHLETE"] },
  { code: "AUT", name: "Austria", aliases: ["AUT"], names: ["AUSTRIA"] },
  { code: "BRA", name: "Brazil", aliases: ["BRA"], names: ["BRAZIL"] },
  { code: "BEL", name: "Belgium", aliases: ["BEL"], names: ["BELGIUM"] },
  { code: "BLR", name: "Belarus", aliases: ["BLR"], names: ["BELARUS"] },
  { code: "CHE", name: "Switzerland", aliases: ["CHE", "SUI"], names: ["SWITZERLAND"] },
  { code: "CHN", name: "China", aliases: ["CHN"], names: ["CHINA"] },
  { code: "CZE", name: "Czechia", aliases: ["CZE"], names: ["CZECHIA", "CZECH REPUBLIC"] },
  { code: "DEU", name: "Germany", aliases: ["DEU", "GER"], names: ["GERMANY", "DEUTSCHLAND"] },
  { code: "DNK", name: "Denmark", aliases: ["DNK", "DEN"], names: ["DENMARK"] },
  { code: "EGY", name: "Egypt", aliases: ["EGY"], names: ["EGYPT"] },
  { code: "ENG", name: "England", aliases: ["ENG"], names: ["ENGLAND"] },
  { code: "ESP", name: "Spain", aliases: ["ESP"], names: ["SPAIN"] },
  { code: "FRA", name: "France", aliases: ["FRA"], names: ["FRANCE"] },
  { code: "GBR", name: "Great Britain", aliases: ["GBR", "UK"], names: ["UNITED KINGDOM", "GREAT BRITAIN"] },
  { code: "GRC", name: "Greece", aliases: ["GRC", "GRE"], names: ["GREECE"] },
  { code: "HRV", name: "Croatia", aliases: ["HRV", "CRO"], names: ["CROATIA"] },
  { code: "HKG", name: "Hong Kong, China", aliases: ["HKG"], names: ["HONG KONG", "HONG KONG CHINA"] },
  { code: "ITA", name: "Italy", aliases: ["ITA"], names: ["ITALY"] },
  { code: "JPN", name: "Japan", aliases: ["JPN"], names: ["JAPAN"] },
  { code: "KOR", name: "Korea Republic", aliases: ["KOR"], names: ["KOREA", "KOREA REPUBLIC", "REPUBLIC OF KOREA", "SOUTH KOREA"] },
  { code: "MAC", name: "Macao, China", aliases: ["MAC"], names: ["MACAO", "MACAO CHINA"] },
  { code: "MLT", name: "Malta", aliases: ["MLT"], names: ["MALTA"] },
  { code: "NGA", name: "Nigeria", aliases: ["NGA", "NGR"], names: ["NIGERIA"] },
  { code: "NLD", name: "Netherlands", aliases: ["NLD", "NED"], names: ["NETHERLANDS"] },
  { code: "POL", name: "Poland", aliases: ["POL"], names: ["POLAND"] },
  { code: "PRY", name: "Paraguay", aliases: ["PRY", "PAR"], names: ["PARAGUAY"] },
  { code: "PRT", name: "Portugal", aliases: ["PRT", "POR"], names: ["PORTUGAL"] },
  { code: "ROU", name: "Romania", aliases: ["ROU"], names: ["ROMANIA"] },
  { code: "RUS", name: "Russia", aliases: ["RUS"], names: ["RUSSIA", "RUSSIAN FEDERATION"] },
  { code: "SGP", name: "Singapore", aliases: ["SGP"], names: ["SINGAPORE"] },
  { code: "SVN", name: "Slovenia", aliases: ["SVN", "SLO"], names: ["SLOVENIA"] },
  { code: "SWE", name: "Sweden", aliases: ["SWE"], names: ["SWEDEN", "SVERIGE"] },
  { code: "TUR", name: "Turkey", aliases: ["TUR"], names: ["TURKEY", "TURKIYE"] },
  { code: "TWN", name: "Chinese Taipei", aliases: ["TWN", "TPE"], names: ["TAIWAN", "CHINESE TAIPEI"] },
  { code: "UKR", name: "Ukraine", aliases: ["UKR"], names: ["UKRAINE"] },
  { code: "USA", name: "United States", aliases: ["USA"], names: ["UNITED STATES", "UNITED STATES OF AMERICA", "USA"] },
  { code: "VEN", name: "Venezuela", aliases: ["VEN"], names: ["VENEZUELA"] },
];

const COUNTRY_2_TO_3: Record<string, string> = {
  AT: "AUT",
  BE: "BEL",
  BR: "BRA",
  BY: "BLR",
  CH: "CHE",
  CN: "CHN",
  CZ: "CZE",
  DE: "DEU",
  DK: "DNK",
  EG: "EGY",
  ES: "ESP",
  FR: "FRA",
  GB: "GBR",
  GR: "GRC",
  HR: "HRV",
  HK: "HKG",
  IT: "ITA",
  JP: "JPN",
  KR: "KOR",
  MO: "MAC",
  MT: "MLT",
  NG: "NGA",
  NL: "NLD",
  PL: "POL",
  PT: "PRT",
  PY: "PRY",
  RO: "ROU",
  RU: "RUS",
  SG: "SGP",
  SI: "SVN",
  SE: "SWE",
  TR: "TUR",
  TW: "TWN",
  UA: "UKR",
  UK: "GBR",
  US: "USA",
  VE: "VEN",
};

const COUNTRY_COMPATIBILITY: Record<string, string[]> = {
  AIN: ["AIN", "RUS"],
  PAR: ["PAR", "PRY"],
  PRY: ["PRY", "PAR"],
  RUS: ["RUS", "AIN"],
};

const aliasToCanonical = new Map<string, string>();
const canonicalToNames = new Map<string, string[]>();
const canonicalToAliases = new Map<string, string[]>();

for (const row of CANONICAL_COUNTRIES) {
  canonicalToNames.set(row.code, [...row.names]);
  canonicalToAliases.set(row.code, [...row.aliases]);
  aliasToCanonical.set(row.code, row.code);

  for (const alias of row.aliases) {
    aliasToCanonical.set(alias.toUpperCase(), row.code);
  }

  for (const name of row.names) {
    aliasToCanonical.set(normalizeNameToken(name), row.code);
  }
}

function normalizeNameToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function cleanToken(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function upperLetters(value: string): string {
  return value.toUpperCase().replace(/[^A-Z]/g, "");
}

export function normalizeCountryCode(value: unknown): string | null {
  const cleaned = cleanToken(value);
  if (!cleaned) {
    return null;
  }

  const letters = upperLetters(cleaned);
  if (letters.length === 2) {
    return COUNTRY_2_TO_3[letters] ?? letters;
  }

  if (letters.length === 3) {
    return aliasToCanonical.get(letters) ?? letters;
  }

  const nameKey = normalizeNameToken(cleaned);
  return aliasToCanonical.get(nameKey) ?? cleaned.toUpperCase();
}

export function getCountryCompatibilityCodes(value: unknown): string[] {
  const normalized = normalizeCountryCode(value);
  if (!normalized) {
    return [];
  }

  const compatibility = COUNTRY_COMPATIBILITY[normalized] ?? [normalized];
  return [...new Set(compatibility)];
}

export function areCountriesCompatible(left: unknown, right: unknown): boolean {
  const leftCompat = getCountryCompatibilityCodes(left);
  const rightCompat = getCountryCompatibilityCodes(right);
  if (leftCompat.length === 0 || rightCompat.length === 0) {
    return false;
  }

  return leftCompat.some((code) => rightCompat.includes(code));
}

export function countryMatchesFilter(country: unknown, filter: unknown): boolean {
  const normalizedFilter = normalizeCountryCode(filter);
  if (!normalizedFilter) {
    return false;
  }

  return areCountriesCompatible(country, normalizedFilter);
}

function canonicalCountryName(code: string): string {
  const row = CANONICAL_COUNTRIES.find((entry) => entry.code === code);
  return row?.name ?? code;
}

export interface CountryMatchSummary {
  input: string | null;
  normalizedCode: string | null;
  canonicalName: string | null;
  aliases: string[];
  names: string[];
  compatibilityCodes: string[];
}

export function describeCountry(value: unknown): CountryMatchSummary {
  const input = cleanToken(value) || null;
  const normalizedCode = normalizeCountryCode(value);
  if (!normalizedCode) {
    return {
      input,
      normalizedCode: null,
      canonicalName: null,
      aliases: [],
      names: [],
      compatibilityCodes: [],
    };
  }

  return {
    input,
    normalizedCode,
    canonicalName: canonicalCountryName(normalizedCode),
    aliases: canonicalToAliases.get(normalizedCode) ?? [normalizedCode],
    names: canonicalToNames.get(normalizedCode) ?? [],
    compatibilityCodes: getCountryCompatibilityCodes(normalizedCode),
  };
}

export function countrySearchTokens(value: unknown): string[] {
  const summary = describeCountry(value);
  const tokens = [
    summary.normalizedCode ?? "",
    ...summary.aliases,
    summary.canonicalName ?? "",
    ...summary.names,
  ]
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(tokens)];
}

export function listCountryMappings(): Array<{
  code: string;
  name: string;
  aliases: string[];
  names: string[];
  compatibilityCodes: string[];
}> {
  return CANONICAL_COUNTRIES.map((row) => ({
    code: row.code,
    name: row.name,
    aliases: [...row.aliases],
    names: [...row.names],
    compatibilityCodes: getCountryCompatibilityCodes(row.code),
  })).sort((a, b) => a.code.localeCompare(b.code));
}
