import { NextResponse } from "next/server";
import {
  areCountriesCompatible,
  describeCountry,
  listCountryMappings,
} from "@/lib/normalization/country";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const value = url.searchParams.get("value")?.trim() ?? "";
    const left = url.searchParams.get("left")?.trim() ?? "";
    const right = url.searchParams.get("right")?.trim() ?? "";
    const includeCatalog = url.searchParams.get("catalog") === "1";

    if (!value && (!left || !right) && !includeCatalog) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide value, left+right, or catalog=1.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      value: value ? describeCountry(value) : null,
      comparison:
        left && right
          ? {
              left: describeCountry(left),
              right: describeCountry(right),
              compatible: areCountriesCompatible(left, right),
            }
          : null,
      catalog: includeCatalog ? listCountryMappings() : null,
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
