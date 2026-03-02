import { NextResponse } from "next/server";
import { buildCountryConflictReport } from "@/lib/players/country-conflicts";

function parseBoolean(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const includeCompatible = parseBoolean(url.searchParams.get("includeCompatible"));
    const includeCountryDetail = parseBoolean(url.searchParams.get("includeCountryDetail"));

    const report = await buildCountryConflictReport({
      limit: Number.isFinite(limitRaw) ? limitRaw : 100,
      includeCompatible,
      includeCountryDetail,
    });

    return NextResponse.json({
      ok: true,
      ...report,
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
