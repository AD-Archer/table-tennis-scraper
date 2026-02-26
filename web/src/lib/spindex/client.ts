import { collectNormalizedResults } from "@/lib/results/normalized";
import { NormalizedResult } from "@/lib/types";

export interface SpindexSyncOptions {
  apiBaseUrl?: string;
  apiPath?: string;
  authToken?: string;
  dryRun?: boolean;
  eventName?: string;
  batchSize?: number;
}

export interface SpindexSyncReport {
  dryRun: boolean;
  target: string;
  attemptedBatches: number;
  successfulBatches: number;
  failedBatches: number;
  totalResults: number;
  eventName: string;
  samplePayload: unknown;
  failures: Array<{ batch: number; status: number; message: string }>;
}

function chunkResults<T>(rows: T[], size: number): T[][] {
  if (size <= 0) {
    return [rows];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

function buildPayload(eventName: string, results: NormalizedResult[]): unknown {
  return {
    eventName,
    generatedAt: new Date().toISOString(),
    source: "ttbl-wtt-nextjs-port",
    results: results.map((result) => ({
      source: result.source,
      sourceMatchId: result.matchKey,
      occurredAt: result.occurredAt,
      eventName: result.eventName,
      playerAId: result.playerAId,
      playerAName: result.playerAName,
      playerBId: result.playerBId,
      playerBName: result.playerBName,
      winnerId: result.winnerId,
    })),
  };
}

function withTrailingSlashRemoved(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export async function syncResultsToSpindex(
  options: SpindexSyncOptions = {},
): Promise<SpindexSyncReport> {
  const dryRun = options.dryRun ?? true;
  const eventName = options.eventName ?? "TTBL/WTT Sync";
  const batchSize = options.batchSize ?? 100;
  const apiPath = options.apiPath ?? "/api/private/batch-results";
  const apiBaseUrl = options.apiBaseUrl ?? process.env.SPINDEX_API_BASE_URL ?? "";
  const authToken = options.authToken ?? process.env.SPINDEX_API_TOKEN ?? "";

  const normalized = await collectNormalizedResults();
  const chunks = chunkResults(normalized, batchSize);

  const target = apiBaseUrl
    ? `${withTrailingSlashRemoved(apiBaseUrl)}${apiPath}`
    : apiPath;

  const samplePayload = buildPayload(eventName, chunks[0] ?? []);

  if (dryRun || !apiBaseUrl) {
    return {
      dryRun: true,
      target,
      attemptedBatches: chunks.length,
      successfulBatches: 0,
      failedBatches: 0,
      totalResults: normalized.length,
      eventName,
      samplePayload,
      failures: [],
    };
  }

  let successfulBatches = 0;
  let failedBatches = 0;
  const failures: Array<{ batch: number; status: number; message: string }> = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const payload = buildPayload(eventName, chunks[i] ?? []);

    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          ...(authToken ? { "x-api-key": authToken } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        successfulBatches += 1;
      } else {
        failedBatches += 1;
        const body = await response.text();
        failures.push({
          batch: i + 1,
          status: response.status,
          message: body.slice(0, 500),
        });
      }
    } catch (error) {
      failedBatches += 1;
      failures.push({
        batch: i + 1,
        status: 0,
        message: error instanceof Error ? error.message : "network error",
      });
    }
  }

  return {
    dryRun: false,
    target,
    attemptedBatches: chunks.length,
    successfulBatches,
    failedBatches,
    totalResults: normalized.length,
    eventName,
    samplePayload,
    failures,
  };
}
