import { randomUUID } from "node:crypto";
import { ensureDir, removeDir } from "@/lib/fs";
import { DATA_ROOT, toProjectRelative } from "@/lib/paths";
import { getManualMergeFilePath, rebuildPlayerRegistry } from "@/lib/players/registry";
import {
  scrapeTTBLAllTime,
  scrapeTTBLLegacySeasons,
  scrapeTTBLSeason,
} from "@/lib/scrapers/ttbl";
import { scrapeWTTAllTime, scrapeWTTMatches } from "@/lib/scrapers/wtt";

export type ActionJobType =
  | "ttbl"
  | "ttbl-legacy"
  | "ttbl-all-time"
  | "wtt"
  | "wtt-all-time"
  | "players-registry"
  | "destroy-data";
export type ActionJobState = "queued" | "running" | "completed" | "failed";

export interface ActionJobStatus {
  jobId: string;
  type: ActionJobType;
  state: ActionJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  logs: string[];
  result: unknown;
  error: string | null;
}

export interface StartTTBLActionJobOptions {
  season?: string;
  numGamedays?: number;
  delayMs?: number;
}

export interface StartTTBLLegacyActionJobOptions {
  seasons: string[];
  numGamedays?: number;
  delayMs?: number;
}

export interface StartTTBLAllTimeActionJobOptions {
  startYear?: number;
  endYear?: number;
  numGamedays?: number;
  delayMs?: number;
}

export interface StartWTTActionJobOptions {
  years?: number[];
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  tournamentScope?: "wtt_only" | "all";
  eventScope?: "singles_only" | "all";
  includeYouth?: boolean;
  profileEnrichMaxPlayers?: number;
  profileEnrichMinMatches?: number;
}

export interface StartWTTAllTimeActionJobOptions {
  startYear?: number;
  endYear?: number;
  pageSize?: number;
  maxPages?: number;
  delayMs?: number;
  tournamentScope?: "wtt_only" | "all";
  eventScope?: "singles_only" | "all";
  includeYouth?: boolean;
  profileEnrichMaxPlayers?: number;
  profileEnrichMinMatches?: number;
}

type ActionJobOptionsByType = {
  ttbl: StartTTBLActionJobOptions;
  "ttbl-legacy": StartTTBLLegacyActionJobOptions;
  "ttbl-all-time": StartTTBLAllTimeActionJobOptions;
  wtt: StartWTTActionJobOptions;
  "wtt-all-time": StartWTTAllTimeActionJobOptions;
  "players-registry": Record<string, never>;
  "destroy-data": Record<string, never>;
};

interface JobsStore {
  jobs: Map<string, ActionJobStatus>;
}

const ACTION_JOB_STALE_MS = 2 * 60 * 1000;

const globalStore = globalThis as typeof globalThis & {
  __actionJobs?: JobsStore;
};

function getStore(): JobsStore {
  if (!globalStore.__actionJobs) {
    globalStore.__actionJobs = {
      jobs: new Map<string, ActionJobStatus>(),
    };
  }

  return globalStore.__actionJobs;
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendLog(status: ActionJobStatus, message: string): void {
  status.logs.push(message);
  if (status.logs.length > 2000) {
    status.logs.splice(0, status.logs.length - 2000);
  }
  status.updatedAt = nowIso();
}

function emit(status: ActionJobStatus, source: "API" | "SYSTEM", message: string): void {
  appendLog(status, `[${nowIso()}] [${source}] ${message}`);
}

function markStaleActiveJobs(): void {
  const now = Date.now();
  for (const job of getStore().jobs.values()) {
    if (job.state !== "queued" && job.state !== "running") {
      continue;
    }

    const ageMs = now - new Date(job.updatedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs <= ACTION_JOB_STALE_MS) {
      continue;
    }

    job.state = "failed";
    job.error = `Job marked stale after ${Math.floor(ageMs / 1000)}s without updates.`;
    job.finishedAt = nowIso();
    job.updatedAt = job.finishedAt;
    emit(job, "SYSTEM", job.error);
  }
}

function getActiveActionJob(type?: ActionJobType): ActionJobStatus | null {
  markStaleActiveJobs();
  const rows = [...getStore().jobs.values()]
    .filter((job) => (type ? job.type === type : true))
    .filter((job) => job.state === "queued" || job.state === "running")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return rows[0] ?? null;
}

export function getActionJob(jobId: string): ActionJobStatus | null {
  return getStore().jobs.get(jobId) ?? null;
}

export function getLatestActionJob(type: ActionJobType): ActionJobStatus | null {
  const rows = [...getStore().jobs.values()]
    .filter((job) => job.type === type)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return rows[0] ?? null;
}

async function runActionJob<T extends ActionJobType>(
  status: ActionJobStatus,
  options: ActionJobOptionsByType[T],
): Promise<void> {
  status.state = "running";
  status.startedAt = nowIso();
  status.updatedAt = status.startedAt;
  emit(status, "SYSTEM", `Job started for action type=${status.type}.`);

  try {
    if (status.type === "ttbl") {
      const opts = options as ActionJobOptionsByType["ttbl"];
      emit(
        status,
        "API",
        `Starting TTBL scrape (season=${opts.season ?? "default"}, gamedays=${opts.numGamedays ?? "default"}).`,
      );
      const result = await scrapeTTBLSeason({
        season: opts.season,
        numGamedays: opts.numGamedays,
        delayMs: opts.delayMs,
        onLog: (message) => appendLog(status, message),
      });
      emit(status, "API", "Rebuilding player registry after TTBL scrape.");
      const players = await rebuildPlayerRegistry((message) => appendLog(status, message));
      status.result = { result, players };
    } else if (status.type === "ttbl-legacy") {
      const opts = options as ActionJobOptionsByType["ttbl-legacy"];
      emit(
        status,
        "API",
        `Starting TTBL scrape (multi-season, seasons=${opts.seasons.length}, gamedays=${opts.numGamedays ?? "default"}).`,
      );
      const result = await scrapeTTBLLegacySeasons({
        seasons: opts.seasons,
        numGamedays: opts.numGamedays,
        delayMs: opts.delayMs,
        onLog: (message) => appendLog(status, message),
      });
      emit(status, "API", "Rebuilding player registry after TTBL scrape.");
      const players = await rebuildPlayerRegistry((message) => appendLog(status, message));
      status.result = { result, players };
    } else if (status.type === "ttbl-all-time") {
      const opts = options as ActionJobOptionsByType["ttbl-all-time"];
      emit(
        status,
        "API",
        `Starting TTBL all-time scrape (range=${opts.startYear ?? "default"}-${opts.endYear ?? "default"}, gamedays=${opts.numGamedays ?? "auto"}).`,
      );
      const result = await scrapeTTBLAllTime({
        startYear: opts.startYear,
        endYear: opts.endYear,
        numGamedays: opts.numGamedays,
        delayMs: opts.delayMs,
        onLog: (message) => appendLog(status, message),
      });
      emit(status, "API", "Rebuilding player registry after TTBL all-time scrape.");
      const players = await rebuildPlayerRegistry((message) => appendLog(status, message));
      status.result = { result, players };
    } else if (status.type === "wtt") {
      const opts = options as ActionJobOptionsByType["wtt"];
      emit(
        status,
        "API",
        `Starting WTT scrape (years=${opts.years?.join(",") || "default"}, pageSize=${opts.pageSize ?? "default"}, maxPages=${opts.maxPages ?? "default"}, tournamentScope=${opts.tournamentScope ?? "wtt_only"}, eventScope=${opts.eventScope ?? "singles_only"}, includeYouth=${opts.includeYouth ?? false}).`,
      );
      const result = await scrapeWTTMatches({
        years: opts.years,
        pageSize: opts.pageSize,
        maxPages: opts.maxPages,
        delayMs: opts.delayMs,
        tournamentScope: opts.tournamentScope,
        eventScope: opts.eventScope,
        includeYouth: opts.includeYouth,
        profileEnrichMaxPlayers: opts.profileEnrichMaxPlayers,
        profileEnrichMinMatches: opts.profileEnrichMinMatches,
        onLog: (message) => appendLog(status, message),
      });
      emit(status, "API", "Rebuilding player registry after WTT scrape.");
      const players = await rebuildPlayerRegistry((message) => appendLog(status, message));
      status.result = { result, players };
    } else if (status.type === "wtt-all-time") {
      const opts = options as ActionJobOptionsByType["wtt-all-time"];
      emit(
        status,
        "API",
        `Starting WTT all-time scrape (range=${opts.startYear ?? "default"}-${opts.endYear ?? "default"}, pageSize=${opts.pageSize ?? "default"}, maxPages=${opts.maxPages ?? "default"}, tournamentScope=${opts.tournamentScope ?? "all"}, eventScope=${opts.eventScope ?? "singles_only"}, includeYouth=${opts.includeYouth ?? false}).`,
      );
      const result = await scrapeWTTAllTime({
        startYear: opts.startYear,
        endYear: opts.endYear,
        pageSize: opts.pageSize,
        maxPages: opts.maxPages,
        delayMs: opts.delayMs,
        tournamentScope: opts.tournamentScope,
        eventScope: opts.eventScope,
        includeYouth: opts.includeYouth,
        profileEnrichMaxPlayers: opts.profileEnrichMaxPlayers,
        profileEnrichMinMatches: opts.profileEnrichMinMatches,
        onLog: (message) => appendLog(status, message),
      });
      emit(status, "API", "Rebuilding player registry after WTT all-time scrape.");
      const players = await rebuildPlayerRegistry((message) => appendLog(status, message));
      status.result = { result, players };
    } else if (status.type === "players-registry") {
      emit(status, "API", "Starting player registry rebuild.");
      const registry = await rebuildPlayerRegistry((message) => appendLog(status, message));
      const manualPath = await getManualMergeFilePath();
      status.result = {
        registry,
        manualMergeFile: toProjectRelative(manualPath),
      };
    } else {
      emit(status, "API", `Destroying local scraper data root ${DATA_ROOT}.`);
      await removeDir(DATA_ROOT);
      await ensureDir(DATA_ROOT);
      emit(status, "API", "Data root recreated.");
      status.result = {
        dataRoot: DATA_ROOT,
      };
    }

    status.state = "completed";
    status.finishedAt = nowIso();
    status.updatedAt = status.finishedAt;
    emit(status, "SYSTEM", "Job completed successfully.");
  } catch (error) {
    status.state = "failed";
    status.error = error instanceof Error ? error.message : "unknown error";
    status.finishedAt = nowIso();
    status.updatedAt = status.finishedAt;
    emit(status, "SYSTEM", `Job failed: ${status.error}`);
  }
}

export function startActionJob<T extends ActionJobType>(
  type: T,
  options: ActionJobOptionsByType[T],
): { alreadyRunning: boolean; status: ActionJobStatus } {
  const activeSameType = getActiveActionJob(type);
  if (activeSameType) {
    return { alreadyRunning: true, status: activeSameType };
  }

  const activeAnyType = getActiveActionJob();
  if (activeAnyType) {
    return { alreadyRunning: true, status: activeAnyType };
  }

  const createdAt = nowIso();
  const status: ActionJobStatus = {
    jobId: randomUUID(),
    type,
    state: "queued",
    createdAt,
    startedAt: null,
    finishedAt: null,
    updatedAt: createdAt,
    logs: [`[${createdAt}] [SYSTEM] Job queued for action type=${type}.`],
    result: null,
    error: null,
  };

  getStore().jobs.set(status.jobId, status);

  void runActionJob(status, options);

  return {
    alreadyRunning: false,
    status,
  };
}
