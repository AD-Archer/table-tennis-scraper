import { WTTPlayer } from "@/lib/types";

const WTT_PUBLIC_CMS_BASE =
  "https://wtt-website-api-prod-3-frontdoor-bddnb2haduafdze9.a01.azurefd.net/api";
const REQUEST_TIMEOUT_MS = 15000;
const REQUEST_RETRIES = 2;

interface WTTPublicProfileResponse {
  ittfid?: number | string;
  fullName?: string;
  nationality?: string;
  orgCode?: string;
  organizationName?: string;
  birthDate?: string;
  gender?: string;
  countryName?: string;
  age?: number;
  ranking?: number;
  rankingPoints?: number;
  headShot?: string;
  additional_data?: {
    PlayerData?: Array<{
      PlayerName?: string;
      PlayerGivenName?: string;
      PlayerFamilyName?: string;
      CountryCode?: string;
      CountryName?: string;
      NationalityCode?: string;
      OrganizationName?: string;
      Gender?: string;
      Age?: number;
      DOB?: string;
      Handedness?: string;
      Style?: string;
      HeadShot?: string;
    }>;
  };
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").trim();
  return cleaned ? cleaned : null;
}

function cleanIsoDate(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeGender(value: string | null | undefined): WTTPlayer["gender"] {
  const normalized = (value ?? "").trim().toUpperCase();
  if (normalized === "M" || normalized === "MALE") {
    return "M";
  }
  if (normalized === "F" || normalized === "W" || normalized === "FEMALE") {
    return "W";
  }
  if (normalized === "X" || normalized === "MIXED") {
    return "mixed";
  }
  if (normalized === "UNKNOWN") {
    return "unknown";
  }

  return null;
}

function splitName(fullName: string | null): { first: string | null; last: string | null } {
  const cleaned = cleanText(fullName);
  if (!cleaned) {
    return { first: null, last: null };
  }

  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) {
    return { first: null, last: parts[0] ?? null };
  }

  return {
    first: parts.slice(1).join(" ") || null,
    last: parts[0] ?? null,
  };
}

export async function fetchWTTPublicProfile(
  ittfId: string,
): Promise<Partial<WTTPlayer> | null> {
  const cleanedId = ittfId.trim();
  if (!cleanedId) {
    return null;
  }

  const url = `${WTT_PUBLIC_CMS_BASE}/cms/GetPlayersDataByID/${encodeURIComponent(cleanedId)}`;

  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "ITTF-WTT-NextJS-Scraper/1.0",
          accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as WTTPublicProfileResponse;
      const playerData = payload.additional_data?.PlayerData?.[0];

      const profileName = cleanText(payload.fullName) ?? cleanText(playerData?.PlayerName);
      const nameParts = splitName(profileName);
      const nationality =
        cleanText(payload.nationality) ??
        cleanText(playerData?.NationalityCode) ??
        cleanText(payload.orgCode) ??
        cleanText(playerData?.CountryCode);

      return {
        first_name: nameParts.first,
        last_name: nameParts.last,
        full_name: profileName,
        dob: cleanIsoDate(payload.birthDate) ?? cleanIsoDate(playerData?.DOB),
        nationality,
        team:
          cleanText(payload.organizationName) ?? cleanText(playerData?.OrganizationName),
        country_name:
          cleanText(payload.countryName) ?? cleanText(playerData?.CountryName),
        organization_name:
          cleanText(payload.organizationName) ?? cleanText(playerData?.OrganizationName),
        gender:
          normalizeGender(payload.gender) ?? normalizeGender(playerData?.Gender) ?? null,
        age: parseNumberish(payload.age) ?? parseNumberish(playerData?.Age),
        handedness: cleanText(playerData?.Handedness),
        style: cleanText(playerData?.Style),
        world_ranking: parseNumberish(payload.ranking),
        world_ranking_points: parseNumberish(payload.rankingPoints),
        headshot_url: cleanText(payload.headShot) ?? cleanText(playerData?.HeadShot),
      };
    } catch {
      if (attempt < REQUEST_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

export function mergeWTTPublicProfile(player: WTTPlayer, profile: Partial<WTTPlayer>): boolean {
  let changed = false;

  const assignString = <K extends keyof WTTPlayer>(key: K, value: WTTPlayer[K]): void => {
    if (value === null || value === undefined || value === "") {
      return;
    }

    if (player[key] !== value) {
      player[key] = value;
      changed = true;
    }
  };

  assignString("first_name", profile.first_name ?? null);
  assignString("last_name", profile.last_name ?? null);
  assignString("full_name", profile.full_name ?? null);
  assignString("dob", profile.dob ?? null);
  assignString("nationality", profile.nationality ?? null);
  assignString("team", profile.team ?? null);
  assignString("country_name", profile.country_name ?? null);
  assignString("organization_name", profile.organization_name ?? null);
  assignString("gender", profile.gender ?? null);
  assignString("age", profile.age ?? null);
  assignString("handedness", profile.handedness ?? null);
  assignString("style", profile.style ?? null);
  assignString("world_ranking", profile.world_ranking ?? null);
  assignString("world_ranking_points", profile.world_ranking_points ?? null);
  assignString("headshot_url", profile.headshot_url ?? null);

  if (!player.sources.includes("wtt_player_profile")) {
    player.sources.push("wtt_player_profile");
    changed = true;
  }

  return changed;
}
