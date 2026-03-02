import { NextResponse } from "next/server";
import {
  getPlayerDetailBySlug,
  getPlayerSourceProfilesByCanonicalKey,
} from "@/lib/players/detail";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const canonicalKey = url.searchParams.get("canonicalKey")?.trim() ?? "";
    const slug = url.searchParams.get("slug")?.trim() ?? "";

    if (!canonicalKey && !slug) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide canonicalKey or slug.",
        },
        { status: 400 },
      );
    }

    if (canonicalKey) {
      const data = await getPlayerSourceProfilesByCanonicalKey(canonicalKey);
      if (!data) {
        return NextResponse.json(
          {
            ok: false,
            error: `No player found for canonicalKey=${canonicalKey}.`,
          },
          { status: 404 },
        );
      }

      return NextResponse.json({
        ok: true,
        canonical: {
          canonicalKey: data.canonical.canonicalKey,
          displayName: data.canonical.displayName,
        },
        members: data.members,
      });
    }

    const detail = await getPlayerDetailBySlug(slug);
    if (!detail) {
      return NextResponse.json(
        {
          ok: false,
          error: `No player found for slug=${slug}.`,
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      canonical: {
        canonicalKey: detail.canonical.canonicalKey,
        displayName: detail.canonical.displayName,
      },
      members: detail.members,
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
