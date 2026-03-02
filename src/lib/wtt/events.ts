import { PlayerGender } from "@/lib/types";

export type WTTEventClass =
  | "singles"
  | "doubles"
  | "mixed"
  | "team"
  | "other";

export function normalizeWTTEventCode(event: string | null | undefined): string {
  return (event ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function isWTTTournamentName(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized.startsWith("WTT ");
}

export function isWTTYouthTournamentName(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized.includes("YOUTH");
}

export function isWTTYouthEvent(event: string | null | undefined): boolean {
  const normalized = normalizeWTTEventCode(event);
  return /^U\d+/.test(normalized);
}

function hasEventCode(normalized: string, codes: string[]): boolean {
  return codes.some((code) => normalized.includes(code));
}

function classifyByCode(normalized: string): WTTEventClass | null {
  if (hasEventCode(normalized, ["XD"])) {
    return "mixed";
  }
  if (hasEventCode(normalized, ["MD", "WD"])) {
    return "doubles";
  }
  if (hasEventCode(normalized, ["MS", "WS"])) {
    return "singles";
  }
  if (hasEventCode(normalized, ["MT", "WT", "XT"])) {
    return "team";
  }

  return null;
}

export function classifyWTTEvent(event: string | null | undefined): WTTEventClass {
  const normalized = normalizeWTTEventCode(event);
  if (!normalized) {
    return "other";
  }

  const fromCode = classifyByCode(normalized);
  if (fromCode) {
    return fromCode;
  }

  if (normalized.includes("SINGLES")) {
    return "singles";
  }
  if (normalized.includes("DOUBLES")) {
    return "doubles";
  }
  if (normalized.includes("MIXED")) {
    return "mixed";
  }
  if (normalized.includes("TEAM")) {
    return "team";
  }

  return "other";
}

export function inferWTTEventGender(event: string | null | undefined): PlayerGender {
  const normalized = normalizeWTTEventCode(event);
  if (!normalized) {
    return "unknown";
  }

  if (hasEventCode(normalized, ["XD", "XT"]) || normalized.includes("MIXED")) {
    return "mixed";
  }

  if (
    hasEventCode(normalized, ["WS", "WD", "WT"]) ||
    normalized.includes("WOMEN") ||
    normalized.includes("GIRL")
  ) {
    return "W";
  }

  if (
    hasEventCode(normalized, ["MS", "MD", "MT"]) ||
    normalized.includes("MEN") ||
    normalized.includes("BOY")
  ) {
    return "M";
  }

  return "unknown";
}

export function isWTTGenderedSinglesEvent(event: string | null | undefined): boolean {
  if (classifyWTTEvent(event) !== "singles") {
    return false;
  }

  const gender = inferWTTEventGender(event);
  return gender === "M" || gender === "W";
}
