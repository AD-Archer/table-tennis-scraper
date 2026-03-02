import { NextResponse } from "next/server";
import {
  getActionJob,
  getLatestActionJob,
  startActionJob,
} from "@/lib/jobs/action-job";

function parseYears(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((row) => Number.parseInt(String(row), 10))
      .filter((row) => Number.isFinite(row));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((row) => Number.parseInt(row.trim(), 10))
      .filter((row) => Number.isFinite(row));
  }

  return [];
}

function parseSeasons(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((row) => String(row).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeSeasonTokens(rawSeasons: string[], rawYears: number[]): string[] {
  const set = new Set<string>();

  for (const raw of rawSeasons) {
    const seasonMatch = raw.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
    if (seasonMatch?.[1] && seasonMatch[2]) {
      const start = Number.parseInt(seasonMatch[1], 10);
      const end = Number.parseInt(seasonMatch[2], 10);
      if (Number.isFinite(start) && Number.isFinite(end) && end === start + 1) {
        set.add(`${start}-${end}`);
      }
      continue;
    }

    const yearMatch = raw.match(/^(\d{4})$/);
    if (yearMatch?.[1]) {
      const start = Number.parseInt(yearMatch[1], 10);
      if (Number.isFinite(start)) {
        set.add(`${start}-${start + 1}`);
      }
    }
  }

  for (const year of rawYears) {
    set.add(`${year}-${year + 1}`);
  }

  return [...set].sort((a, b) => {
    const aStart = Number.parseInt(a.split("-")[0] ?? "0", 10);
    const bStart = Number.parseInt(b.split("-")[0] ?? "0", 10);
    return bStart - aStart;
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      season?: string;
      seasons?: string[] | string;
      years?: number[] | string;
      numGamedays?: number;
      delayMs?: number;
    };

    const seasons = normalizeSeasonTokens(
      parseSeasons(body.seasons ?? body.season ?? []),
      parseYears(body.years),
    );

    if (seasons.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Provide TTBL input as 2025 or 2025-2026 (comma separated).",
        },
        { status: 400 },
      );
    }

    const isMultiSeason = seasons.length > 1;
    const { alreadyRunning, status } = isMultiSeason
      ? startActionJob("ttbl-legacy", {
          seasons,
          numGamedays: body.numGamedays,
          delayMs: body.delayMs,
        })
      : startActionJob("ttbl", {
          season: seasons[0],
          numGamedays: body.numGamedays,
          delayMs: body.delayMs,
        });

    return NextResponse.json({
      ok: true,
      alreadyRunning,
      jobId: status.jobId,
      status,
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim();
    const status = jobId
      ? getActionJob(jobId)
      : getLatestActionJob("ttbl") ?? getLatestActionJob("ttbl-legacy");

    return NextResponse.json({
      ok: true,
      status: status ?? null,
      message: status
        ? undefined
        : jobId
          ? `No TTBL scrape job found for jobId=${jobId}`
          : "No TTBL scrape job has been started yet.",
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
