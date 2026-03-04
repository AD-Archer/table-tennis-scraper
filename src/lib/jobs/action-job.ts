import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@/lib/db/prisma";
import { removeDir, sleep } from "@/lib/fs";
import { DATA_ROOT } from "@/lib/paths";
import { rebuildPlayerRegistry } from "@/lib/players/registry";
import {
  appendSyncActivity,
  listSyncActivityEntries,
  replaceSyncActivityEntries,
} from "@/lib/sync/activity-log";
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
  includeYouth?: boolean;
  backgroundReason?: string;
  backgroundSourceJobId?: string;
}

export interface StartTTBLLegacyActionJobOptions {
  seasons: string[];
  numGamedays?: number;
  delayMs?: number;
  includeYouth?: boolean;
  backgroundReason?: string;
  backgroundSourceJobId?: string;
}

export interface StartTTBLAllTimeActionJobOptions {
  startYear?: number;
  endYear?: number;
  numGamedays?: number;
  delayMs?: number;
  includeYouth?: boolean;
  backgroundReason?: string;
  backgroundSourceJobId?: string;
}

export interface StartWTTActionJobOptions {
  years?: number[];
  pageSize?: number;
  maxPages?: number;
  maxEventsPerYear?: number;
  delayMs?: number;
  eventScope?: "singles_only" | "all";
  includeYouth?: boolean;
  profileEnrichMaxPlayers?: number;
  profileEnrichMinMatches?: number;
  backgroundReason?: string;
  backgroundSourceJobId?: string;
}

export interface StartWTTAllTimeActionJobOptions {
  startYear?: number;
  endYear?: number;
  pageSize?: number;
  maxPages?: number;
  maxEventsPerYear?: number;
  delayMs?: number;
  eventScope?: "singles_only" | "all";
  includeYouth?: boolean;
  profileEnrichMaxPlayers?: number;
  profileEnrichMinMatches?: number;
  backgroundReason?: string;
  backgroundSourceJobId?: string;
}

export interface StartPlayersRegistryActionJobOptions {
  failOnUnresolvedCandidates?: boolean;
  backgroundReason?: string;
  backgroundSourceJobId?: string;
}

export interface WTTFollowupStatus {
  scheduled: boolean;
  scheduledAt: string | null;
  scheduledFor: string | null;
  reason: string | null;
  requestedByJobId: string | null;
  attempts: number;
  lastTriggeredAt: string | null;
  lastOutcome: "started" | "busy" | "failed" | null;
  lastError: string | null;
  lastStartedJobId: string | null;
  options: {
    years: number[];
    pageSize: number | null;
    maxPages: number | null;
    maxEventsPerYear: number | null;
    delayMs: number | null;
    eventScope: "singles_only" | "all";
    includeYouth: boolean;
  } | null;
}

export interface TTBLFollowupStatus {
  scheduled: boolean;
  scheduledAt: string | null;
  scheduledFor: string | null;
  reason: string | null;
  requestedByJobId: string | null;
  attempts: number;
  lastTriggeredAt: string | null;
  lastOutcome: "started" | "busy" | "failed" | null;
  lastError: string | null;
  lastStartedJobId: string | null;
  options: {
    season: string | null;
    numGamedays: number | null;
    delayMs: number | null;
    includeYouth: boolean;
  } | null;
}

type ActionJobOptionsByType = {
  ttbl: StartTTBLActionJobOptions;
  "ttbl-legacy": StartTTBLLegacyActionJobOptions;
  "ttbl-all-time": StartTTBLAllTimeActionJobOptions;
  wtt: StartWTTActionJobOptions;
  "wtt-all-time": StartWTTAllTimeActionJobOptions;
  "players-registry": StartPlayersRegistryActionJobOptions;
  "destroy-data": Record<string, never>;
};

interface JobsStore {
  jobs: Map<string, ActionJobStatus>;
  cancelReasons: Map<string, string>;
  cancelControllers: Map<string, AbortController>;
  ttblFollowup: {
    timer: ReturnType<typeof setTimeout> | null;
    pendingOptions: StartTTBLActionJobOptions | null;
    status: TTBLFollowupStatus;
  };
  wttFollowup: {
    timer: ReturnType<typeof setTimeout> | null;
    pendingOptions: StartWTTActionJobOptions | null;
    status: WTTFollowupStatus;
  };
}

const ACTION_JOB_STALE_MS = 30 * 60 * 1000;
const DESTROY_WAIT_POLL_MS = 1500;
const TTBL_FOLLOWUP_DEFAULT_DELAY_MS = 2 * 60 * 1000;
const TTBL_FOLLOWUP_RETRY_DELAY_MS = 30 * 1000;
const WTT_FOLLOWUP_DEFAULT_DELAY_MS = 2 * 60 * 1000;
const WTT_FOLLOWUP_RETRY_DELAY_MS = 30 * 1000;

class ActionJobCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionJobCancelledError";
  }
}

const globalStore = globalThis as typeof globalThis & {
  __actionJobs?: JobsStore;
};

function getStore(): JobsStore {
  if (!globalStore.__actionJobs) {
    globalStore.__actionJobs = {
      jobs: new Map<string, ActionJobStatus>(),
      cancelReasons: new Map<string, string>(),
      cancelControllers: new Map<string, AbortController>(),
      ttblFollowup: {
        timer: null,
        pendingOptions: null,
        status: {
          scheduled: false,
          scheduledAt: null,
          scheduledFor: null,
          reason: null,
          requestedByJobId: null,
          attempts: 0,
          lastTriggeredAt: null,
          lastOutcome: null,
          lastError: null,
          lastStartedJobId: null,
          options: null,
        },
      },
      wttFollowup: {
        timer: null,
        pendingOptions: null,
        status: {
          scheduled: false,
          scheduledAt: null,
          scheduledFor: null,
          reason: null,
          requestedByJobId: null,
          attempts: 0,
          lastTriggeredAt: null,
          lastOutcome: null,
          lastError: null,
          lastStartedJobId: null,
          options: null,
        },
      },
    };
  }

  if (!globalStore.__actionJobs.cancelReasons) {
    globalStore.__actionJobs.cancelReasons = new Map<string, string>();
  }

  if (!globalStore.__actionJobs.cancelControllers) {
    globalStore.__actionJobs.cancelControllers = new Map<string, AbortController>();
  }

  if (!globalStore.__actionJobs.ttblFollowup) {
    globalStore.__actionJobs.ttblFollowup = {
      timer: null,
      pendingOptions: null,
      status: {
        scheduled: false,
        scheduledAt: null,
        scheduledFor: null,
        reason: null,
        requestedByJobId: null,
        attempts: 0,
        lastTriggeredAt: null,
        lastOutcome: null,
        lastError: null,
        lastStartedJobId: null,
        options: null,
      },
    };
  }

  if (!globalStore.__actionJobs.wttFollowup) {
    globalStore.__actionJobs.wttFollowup = {
      timer: null,
      pendingOptions: null,
      status: {
        scheduled: false,
        scheduledAt: null,
        scheduledFor: null,
        reason: null,
        requestedByJobId: null,
        attempts: 0,
        lastTriggeredAt: null,
        lastOutcome: null,
        lastError: null,
        lastStartedJobId: null,
        options: null,
      },
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
  const store = getStore();
  for (const job of store.jobs.values()) {
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
    store.cancelControllers.delete(job.jobId);
    store.cancelReasons.delete(job.jobId);
  }
}

function getActiveActionJobs(type?: ActionJobType): ActionJobStatus[] {
  markStaleActiveJobs();
  return [...getStore().jobs.values()]
    .filter((job) => (type ? job.type === type : true))
    .filter((job) => job.state === "queued" || job.state === "running")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function getActiveActionJob(type?: ActionJobType): ActionJobStatus | null {
  const rows = getActiveActionJobs(type);
  return rows[0] ?? null;
}

function getRunningActionJob(type?: ActionJobType): ActionJobStatus | null {
  const rows = getActiveActionJobs(type).filter((job) => job.state === "running");
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

function getCancellationReason(jobId: string): string | null {
  return getStore().cancelReasons.get(jobId) ?? null;
}

function throwIfJobCancelled(status: ActionJobStatus): void {
  const reason = getCancellationReason(status.jobId);
  if (!reason) {
    return;
  }

  throw new ActionJobCancelledError(reason);
}

function appendWorkerLog(status: ActionJobStatus, message: string): void {
  throwIfJobCancelled(status);
  appendLog(status, message);
}

function normalizeDelayMs(raw: number | undefined, fallback: number): number {
  if (!Number.isFinite(raw)) {
    return fallback;
  }

  return Math.max(5_000, Math.min(30 * 60 * 1000, Math.trunc(raw as number)));
}

function parseDelayEnv(varName: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[varName] ?? "", 10);
  return normalizeDelayMs(parsed, fallback);
}

function normalizeTTBLFollowupOptions(
  options: StartTTBLActionJobOptions,
): StartTTBLActionJobOptions {
  return {
    season: options.season ?? undefined,
    numGamedays: options.numGamedays,
    delayMs: options.delayMs ?? 120,
    includeYouth: options.includeYouth ?? false,
    backgroundReason: options.backgroundReason ?? "ttbl-background-followup",
    backgroundSourceJobId: options.backgroundSourceJobId,
  };
}

function normalizeWTTFollowupOptions(
  options: StartWTTActionJobOptions,
): StartWTTActionJobOptions {
  return {
    years: options.years && options.years.length > 0 ? [...new Set(options.years)] : undefined,
    pageSize: options.pageSize ?? 50,
    maxPages: options.maxPages ?? 80,
    maxEventsPerYear: options.maxEventsPerYear ?? 16,
    delayMs: options.delayMs ?? 150,
    eventScope: options.eventScope ?? "singles_only",
    includeYouth: options.includeYouth ?? false,
    profileEnrichMaxPlayers: options.profileEnrichMaxPlayers ?? 0,
    profileEnrichMinMatches: options.profileEnrichMinMatches ?? 2,
    backgroundReason: options.backgroundReason ?? "wtt-background-followup",
    backgroundSourceJobId: options.backgroundSourceJobId,
  };
}

async function triggerScheduledTTBLFollowup(): Promise<void> {
  const store = getStore();
  const followup = store.ttblFollowup;
  const pending = followup.pendingOptions;
  if (!pending) {
    followup.status.scheduled = false;
    followup.status.scheduledFor = null;
    return;
  }

  followup.timer = null;
  followup.pendingOptions = null;
  followup.status.scheduled = false;
  followup.status.scheduledFor = null;
  followup.status.lastTriggeredAt = nowIso();
  followup.status.attempts += 1;

  await appendSyncActivity("ttbl", "Background follow-up trigger fired.", {
    mode: "ttbl-followup-trigger",
    season: pending.season ?? null,
    includeYouth: pending.includeYouth ?? false,
    backgroundReason: pending.backgroundReason ?? null,
  });

  try {
    const { alreadyRunning, status } = startActionJob("ttbl", pending);
    if (alreadyRunning) {
      followup.status.lastOutcome = "busy";
      followup.status.lastError = `Follow-up blocked by active ${status.type} job ${status.jobId}.`;
      const retryDelay = parseDelayEnv(
        "TTBL_FOLLOWUP_RETRY_DELAY_MS",
        TTBL_FOLLOWUP_RETRY_DELAY_MS,
      );
      scheduleTTBLFollowupInBackground({
        ...pending,
        delayMs: retryDelay,
        reason: "retry-after-active-job",
      });
      await appendSyncActivity("ttbl", "Background follow-up delayed (another job is active).", {
        mode: "ttbl-followup-busy",
        activeJobId: status.jobId,
        activeJobType: status.type,
        retryDelayMs: retryDelay,
      }, "warn");
      return;
    }

    followup.status.lastOutcome = "started";
    followup.status.lastError = null;
    followup.status.lastStartedJobId = status.jobId;
    await appendSyncActivity("ttbl", "Background follow-up started.", {
      mode: "ttbl-followup-started",
      startedJobId: status.jobId,
      season: pending.season ?? null,
      includeYouth: pending.includeYouth ?? false,
    });
  } catch (error) {
    followup.status.lastOutcome = "failed";
    followup.status.lastError =
      error instanceof Error ? error.message : "failed to start follow-up";
    await appendSyncActivity(
      "ttbl",
      "Background follow-up failed to start.",
      {
        mode: "ttbl-followup-failed",
        error: followup.status.lastError,
        season: pending.season ?? null,
      },
      "error",
    );
  }
}

async function triggerScheduledWTTFollowup(): Promise<void> {
  const store = getStore();
  const followup = store.wttFollowup;
  const pending = followup.pendingOptions;
  if (!pending) {
    followup.status.scheduled = false;
    followup.status.scheduledFor = null;
    return;
  }

  followup.timer = null;
  followup.pendingOptions = null;
  followup.status.scheduled = false;
  followup.status.scheduledFor = null;
  followup.status.lastTriggeredAt = nowIso();
  followup.status.attempts += 1;

  await appendSyncActivity("wtt", "Background follow-up trigger fired.", {
    mode: "wtt-followup-trigger",
    years: pending.years ?? [],
    maxEventsPerYear: pending.maxEventsPerYear ?? null,
    includeYouth: pending.includeYouth ?? false,
    backgroundReason: pending.backgroundReason ?? null,
  });

  try {
    const { alreadyRunning, status } = startActionJob("wtt", pending);
    if (alreadyRunning) {
      followup.status.lastOutcome = "busy";
      followup.status.lastError = `Follow-up blocked by active ${status.type} job ${status.jobId}.`;
      const retryDelay = parseDelayEnv(
        "WTT_FOLLOWUP_RETRY_DELAY_MS",
        WTT_FOLLOWUP_RETRY_DELAY_MS,
      );
      scheduleWTTFollowupInBackground({
        ...pending,
        delayMs: retryDelay,
        reason: "retry-after-active-job",
      });
      await appendSyncActivity("wtt", "Background follow-up delayed (another job is active).", {
        mode: "wtt-followup-busy",
        activeJobId: status.jobId,
        activeJobType: status.type,
        retryDelayMs: retryDelay,
      }, "warn");
      return;
    }

    followup.status.lastOutcome = "started";
    followup.status.lastError = null;
    followup.status.lastStartedJobId = status.jobId;
    await appendSyncActivity("wtt", "Background follow-up started.", {
      mode: "wtt-followup-started",
      startedJobId: status.jobId,
      years: pending.years ?? [],
      maxEventsPerYear: pending.maxEventsPerYear ?? null,
      includeYouth: pending.includeYouth ?? false,
    });
  } catch (error) {
    followup.status.lastOutcome = "failed";
    followup.status.lastError =
      error instanceof Error ? error.message : "failed to start follow-up";
    await appendSyncActivity(
      "wtt",
      "Background follow-up failed to start.",
      {
        mode: "wtt-followup-failed",
        error: followup.status.lastError,
        years: pending.years ?? [],
      },
      "error",
    );
  }
}

export function getTTBLFollowupStatus(): TTBLFollowupStatus {
  const status = getStore().ttblFollowup.status;
  return {
    ...status,
    options: status.options
      ? {
          ...status.options,
        }
      : null,
  };
}

export function scheduleTTBLFollowupInBackground(
  options: StartTTBLActionJobOptions & {
    delayMs?: number;
    reason?: string;
    requestedByJobId?: string;
  },
): TTBLFollowupStatus {
  const store = getStore();
  const followup = store.ttblFollowup;
  const normalized = normalizeTTBLFollowupOptions(options);
  const delayMs = normalizeDelayMs(
    options.delayMs,
    parseDelayEnv("TTBL_FOLLOWUP_DELAY_MS", TTBL_FOLLOWUP_DEFAULT_DELAY_MS),
  );

  if (followup.timer) {
    clearTimeout(followup.timer);
  }

  const scheduledAt = nowIso();
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();
  followup.pendingOptions = normalized;
  followup.status.scheduled = true;
  followup.status.scheduledAt = scheduledAt;
  followup.status.scheduledFor = scheduledFor;
  followup.status.reason = options.reason ?? "manual";
  followup.status.requestedByJobId = options.requestedByJobId ?? null;
  followup.status.options = {
    season: normalized.season ?? null,
    numGamedays: normalized.numGamedays ?? null,
    delayMs: normalized.delayMs ?? null,
    includeYouth: normalized.includeYouth ?? false,
  };

  followup.timer = setTimeout(() => {
    void triggerScheduledTTBLFollowup();
  }, delayMs);

  void appendSyncActivity("ttbl", "Background follow-up scheduled.", {
    mode: "ttbl-followup-scheduled",
    scheduledAt,
    scheduledFor,
    reason: options.reason ?? "manual",
    requestedByJobId: options.requestedByJobId ?? null,
    checks: {
      season: normalized.season ?? null,
      numGamedays: normalized.numGamedays ?? null,
      includeYouth: normalized.includeYouth ?? false,
    },
  });

  return getTTBLFollowupStatus();
}

export function getWTTFollowupStatus(): WTTFollowupStatus {
  const status = getStore().wttFollowup.status;
  return {
    ...status,
    options: status.options
      ? {
          ...status.options,
          years: [...status.options.years],
        }
      : null,
  };
}

export function scheduleWTTFollowupInBackground(
  options: StartWTTActionJobOptions & {
    delayMs?: number;
    reason?: string;
    requestedByJobId?: string;
  },
): WTTFollowupStatus {
  const store = getStore();
  const followup = store.wttFollowup;
  const normalized = normalizeWTTFollowupOptions(options);
  const delayMs = normalizeDelayMs(
    options.delayMs,
    parseDelayEnv("WTT_FOLLOWUP_DELAY_MS", WTT_FOLLOWUP_DEFAULT_DELAY_MS),
  );

  if (followup.timer) {
    clearTimeout(followup.timer);
  }

  const scheduledAt = nowIso();
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();
  followup.pendingOptions = normalized;
  followup.status.scheduled = true;
  followup.status.scheduledAt = scheduledAt;
  followup.status.scheduledFor = scheduledFor;
  followup.status.reason = options.reason ?? "manual";
  followup.status.requestedByJobId = options.requestedByJobId ?? null;
  followup.status.options = {
    years: normalized.years ?? [],
    pageSize: normalized.pageSize ?? null,
    maxPages: normalized.maxPages ?? null,
    maxEventsPerYear: normalized.maxEventsPerYear ?? null,
    delayMs: normalized.delayMs ?? null,
    eventScope: normalized.eventScope ?? "singles_only",
    includeYouth: normalized.includeYouth ?? false,
  };

  followup.timer = setTimeout(() => {
    void triggerScheduledWTTFollowup();
  }, delayMs);

  void appendSyncActivity("wtt", "Background follow-up scheduled.", {
    mode: "wtt-followup-scheduled",
    scheduledAt,
    scheduledFor,
    reason: options.reason ?? "manual",
    requestedByJobId: options.requestedByJobId ?? null,
    checks: {
      years: normalized.years ?? [],
      pageSize: normalized.pageSize ?? null,
      maxPages: normalized.maxPages ?? null,
      maxEventsPerYear: normalized.maxEventsPerYear ?? null,
      eventScope: normalized.eventScope ?? "singles_only",
      includeYouth: normalized.includeYouth ?? false,
    },
  });

  return getWTTFollowupStatus();
}

export function cancelScheduledFollowups(
  target: "ttbl" | "wtt" | "all" = "all",
): { ttbl: TTBLFollowupStatus; wtt: WTTFollowupStatus; cancelledTimers: number } {
  const store = getStore();
  let cancelledTimers = 0;

  if (target === "all" || target === "ttbl") {
    const followup = store.ttblFollowup;
    if (followup.timer) {
      clearTimeout(followup.timer);
      cancelledTimers += 1;
    }
    followup.timer = null;
    followup.pendingOptions = null;
    followup.status.scheduled = false;
    followup.status.scheduledFor = null;
    followup.status.reason = "cancelled";
  }

  if (target === "all" || target === "wtt") {
    const followup = store.wttFollowup;
    if (followup.timer) {
      clearTimeout(followup.timer);
      cancelledTimers += 1;
    }
    followup.timer = null;
    followup.pendingOptions = null;
    followup.status.scheduled = false;
    followup.status.scheduledFor = null;
    followup.status.reason = "cancelled";
  }

  return {
    ttbl: getTTBLFollowupStatus(),
    wtt: getWTTFollowupStatus(),
    cancelledTimers,
  };
}

export function cancelActionJob(
  jobId: string,
  reason = "Cancelled by user request.",
): { found: boolean; alreadyTerminal: boolean; status: ActionJobStatus | null } {
  const status = getActionJob(jobId);
  if (!status) {
    return {
      found: false,
      alreadyTerminal: false,
      status: null,
    };
  }

  if (status.state === "completed" || status.state === "failed") {
    return {
      found: true,
      alreadyTerminal: true,
      status,
    };
  }

  const store = getStore();
  store.cancelReasons.set(jobId, reason);
  store.cancelControllers.get(jobId)?.abort(reason);
  emit(status, "SYSTEM", `Cancellation requested: ${reason}`);

  if (status.state === "queued") {
    status.state = "failed";
    status.error = reason;
    status.startedAt = status.startedAt ?? nowIso();
    status.finishedAt = nowIso();
    status.updatedAt = status.finishedAt;
    emit(status, "SYSTEM", `Job cancelled before start: ${reason}`);
    store.cancelControllers.delete(jobId);
    store.cancelReasons.delete(jobId);
  }

  return {
    found: true,
    alreadyTerminal: false,
    status,
  };
}

export function cancelActiveActionJobs(options?: {
  type?: ActionJobType;
  includeQueued?: boolean;
  reason?: string;
}): {
  cancelled: Array<{ jobId: string; type: ActionJobType; state: ActionJobState }>;
  count: number;
} {
  const includeQueued = options?.includeQueued ?? true;
  const reason = options?.reason ?? "Cancelled by user request.";
  const active = getActiveActionJobs(options?.type).filter((job) =>
    includeQueued ? true : job.state === "running",
  );

  const cancelled: Array<{ jobId: string; type: ActionJobType; state: ActionJobState }> = [];
  for (const row of active) {
    const result = cancelActionJob(row.jobId, reason);
    if (!result.found || !result.status) {
      continue;
    }
    cancelled.push({
      jobId: result.status.jobId,
      type: result.status.type,
      state: result.status.state,
    });
  }

  return {
    cancelled,
    count: cancelled.length,
  };
}

async function runActionJob<T extends ActionJobType>(
  status: ActionJobStatus,
  options: ActionJobOptionsByType[T],
): Promise<void> {
  const jobSignal = getStore().cancelControllers.get(status.jobId)?.signal;
  status.state = "running";
  status.startedAt = nowIso();
  status.updatedAt = status.startedAt;
  emit(status, "SYSTEM", `Job started for action type=${status.type}.`);

  try {
    throwIfJobCancelled(status);

    if (status.type === "ttbl") {
      const opts = options as ActionJobOptionsByType["ttbl"];
      if (opts.backgroundReason) {
        await appendSyncActivity("ttbl", "Background TTBL sync started.", {
          mode: "ttbl-background-start",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          sourceJobId: opts.backgroundSourceJobId ?? null,
          checks: {
            season: opts.season ?? null,
            includeYouth: opts.includeYouth ?? false,
          },
        });
      }
      emit(
        status,
        "API",
        `Starting TTBL scrape (season=${opts.season ?? "default"}, gamedays=${opts.numGamedays ?? "default"}).`,
      );
      const result = await scrapeTTBLSeason({
        season: opts.season,
        numGamedays: opts.numGamedays,
        delayMs: opts.delayMs,
        includeYouth: opts.includeYouth ?? false,
        onLog: (message) => appendWorkerLog(status, message),
        signal: jobSignal,
      });
      throwIfJobCancelled(status);
      emit(status, "API", "Rebuilding player registry after TTBL scrape.");
      const players = await rebuildPlayerRegistry((message) => appendWorkerLog(status, message));
      let followup: TTBLFollowupStatus | null = null;
      const needsFollowup = (result.ongoingMatches ?? 0) > 0 || (result.notFinishedMatches ?? 0) > 0;
      if (needsFollowup) {
        followup = scheduleTTBLFollowupInBackground({
          season: result.metadata.season,
          numGamedays: opts.numGamedays,
          delayMs: parseDelayEnv("TTBL_FOLLOWUP_DELAY_MS", TTBL_FOLLOWUP_DEFAULT_DELAY_MS),
          includeYouth: opts.includeYouth ?? false,
          backgroundReason: "auto-after-ttbl-job",
          reason: "auto-after-ttbl-job",
          requestedByJobId: status.jobId,
        });
        emit(
          status,
          "SYSTEM",
          `Detected live/in-progress TTBL matches (ongoing=${result.ongoingMatches}, notFinished=${result.notFinishedMatches}). Follow-up scrape scheduled for ${followup.scheduledFor}.`,
        );
      }
      if (opts.backgroundReason) {
        await appendSyncActivity("ttbl", "Background TTBL sync completed.", {
          mode: "ttbl-background-complete",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          summary: {
            matches: result.metadata.totalMatches,
            ongoingMatches: result.ongoingMatches,
            notFinishedMatches: result.notFinishedMatches,
            filteredYouthMatches: result.filteredYouthMatches,
          },
        });
      }
      status.result = { result, players, followup };
    } else if (status.type === "ttbl-legacy") {
      const opts = options as ActionJobOptionsByType["ttbl-legacy"];
      if (opts.backgroundReason) {
        await appendSyncActivity("ttbl", "Background TTBL legacy sync started.", {
          mode: "ttbl-legacy-background-start",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          sourceJobId: opts.backgroundSourceJobId ?? null,
          checks: {
            seasons: opts.seasons,
            includeYouth: opts.includeYouth ?? false,
          },
        });
      }
      emit(
        status,
        "API",
        `Starting TTBL scrape (multi-season, seasons=${opts.seasons.length}, gamedays=${opts.numGamedays ?? "default"}).`,
      );
      const result = await scrapeTTBLLegacySeasons({
        seasons: opts.seasons,
        numGamedays: opts.numGamedays,
        delayMs: opts.delayMs,
        includeYouth: opts.includeYouth ?? false,
        onLog: (message) => appendWorkerLog(status, message),
        signal: jobSignal,
      });
      throwIfJobCancelled(status);
      emit(status, "API", "Rebuilding player registry after TTBL scrape.");
      const players = await rebuildPlayerRegistry((message) => appendWorkerLog(status, message));
      const latest = [...result.results].sort(
        (a, b) => b.metadata.season.localeCompare(a.metadata.season),
      )[0];
      let followup: TTBLFollowupStatus | null = null;
      if (latest && ((latest.ongoingMatches ?? 0) > 0 || (latest.notFinishedMatches ?? 0) > 0)) {
        followup = scheduleTTBLFollowupInBackground({
          season: latest.metadata.season,
          numGamedays: opts.numGamedays,
          delayMs: parseDelayEnv("TTBL_FOLLOWUP_DELAY_MS", TTBL_FOLLOWUP_DEFAULT_DELAY_MS),
          includeYouth: opts.includeYouth ?? false,
          backgroundReason: "auto-after-ttbl-legacy-job",
          reason: "auto-after-ttbl-legacy-job",
          requestedByJobId: status.jobId,
        });
        emit(
          status,
          "SYSTEM",
          `Detected live/in-progress TTBL matches in latest season ${latest.metadata.season} (ongoing=${latest.ongoingMatches}, notFinished=${latest.notFinishedMatches}). Follow-up scrape scheduled for ${followup.scheduledFor}.`,
        );
      }
      if (opts.backgroundReason) {
        await appendSyncActivity("ttbl", "Background TTBL legacy sync completed.", {
          mode: "ttbl-legacy-background-complete",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          summary: {
            seasons: result.seasons.length,
            latestSeason: latest?.metadata.season ?? null,
            latestOngoing: latest?.ongoingMatches ?? 0,
            latestNotFinished: latest?.notFinishedMatches ?? 0,
          },
        });
      }
      status.result = { result, players, followup };
    } else if (status.type === "ttbl-all-time") {
      const opts = options as ActionJobOptionsByType["ttbl-all-time"];
      if (opts.backgroundReason) {
        await appendSyncActivity("ttbl", "Background TTBL all-time sync started.", {
          mode: "ttbl-all-time-background-start",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          sourceJobId: opts.backgroundSourceJobId ?? null,
          checks: {
            startYear: opts.startYear ?? null,
            endYear: opts.endYear ?? null,
            includeYouth: opts.includeYouth ?? false,
          },
        });
      }
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
        includeYouth: opts.includeYouth ?? false,
        onLog: (message) => appendWorkerLog(status, message),
        signal: jobSignal,
      });
      throwIfJobCancelled(status);
      emit(status, "API", "Rebuilding player registry after TTBL all-time scrape.");
      const players = await rebuildPlayerRegistry((message) => appendWorkerLog(status, message));
      let followup: TTBLFollowupStatus | null = null;
      if (
        result.current &&
        ((result.current.ongoingMatches ?? 0) > 0 ||
          (result.current.notFinishedMatches ?? 0) > 0)
      ) {
        followup = scheduleTTBLFollowupInBackground({
          season: result.current.metadata.season,
          numGamedays: opts.numGamedays,
          delayMs: parseDelayEnv("TTBL_FOLLOWUP_DELAY_MS", TTBL_FOLLOWUP_DEFAULT_DELAY_MS),
          includeYouth: opts.includeYouth ?? false,
          backgroundReason: "auto-after-ttbl-all-time-job",
          reason: "auto-after-ttbl-all-time-job",
          requestedByJobId: status.jobId,
        });
        emit(
          status,
          "SYSTEM",
          `Detected live/in-progress TTBL matches in current season ${result.current.metadata.season} (ongoing=${result.current.ongoingMatches}, notFinished=${result.current.notFinishedMatches}). Follow-up scrape scheduled for ${followup.scheduledFor}.`,
        );
      }
      if (opts.backgroundReason) {
        await appendSyncActivity("ttbl", "Background TTBL all-time sync completed.", {
          mode: "ttbl-all-time-background-complete",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          summary: {
            discoveredSeasons: result.discoveredSeasons.length,
            currentSeason: result.current?.metadata.season ?? null,
            currentOngoing: result.current?.ongoingMatches ?? 0,
            currentNotFinished: result.current?.notFinishedMatches ?? 0,
          },
        });
      }
      status.result = { result, players, followup };
    } else if (status.type === "wtt") {
      const opts = options as ActionJobOptionsByType["wtt"];
      if (opts.backgroundReason) {
        await appendSyncActivity("wtt", "Background WTT sync started.", {
          mode: "wtt-background-start",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          sourceJobId: opts.backgroundSourceJobId ?? null,
          checks: {
            years: opts.years ?? [],
            maxEventsPerYear: opts.maxEventsPerYear ?? null,
            includeYouth: opts.includeYouth ?? false,
          },
        });
      }
      emit(
        status,
        "API",
        `Starting WTT scrape (years=${opts.years?.join(",") || "default"}, pageSize=${opts.pageSize ?? "default"}, maxPages=${opts.maxPages ?? "default"}, maxEventsPerYear=${opts.maxEventsPerYear ?? "default"}, eventScope=${opts.eventScope ?? "singles_only"}, includeYouth=${opts.includeYouth ?? false}).`,
      );
      const result = await scrapeWTTMatches({
        years: opts.years,
        pageSize: opts.pageSize,
        maxPages: opts.maxPages,
        maxEventsPerYear: opts.maxEventsPerYear,
        delayMs: opts.delayMs,
        eventScope: opts.eventScope,
        includeYouth: opts.includeYouth,
        profileEnrichMaxPlayers: opts.profileEnrichMaxPlayers,
        profileEnrichMinMatches: opts.profileEnrichMinMatches,
        onLog: (message) => appendWorkerLog(status, message),
      });
      throwIfJobCancelled(status);
      emit(status, "API", "Rebuilding player registry after WTT scrape.");
      const players = await rebuildPlayerRegistry((message) => appendWorkerLog(status, message));
      let followup: WTTFollowupStatus | null = null;
      const needsFollowup = (result.ongoingMatches ?? 0) > 0 || (result.notFinishedMatches ?? 0) > 0;
      if (needsFollowup) {
        const followupYears =
          result.years.length > 0 ? result.years : opts.years && opts.years.length > 0 ? opts.years : undefined;
        followup = scheduleWTTFollowupInBackground({
          years: followupYears,
          pageSize: opts.pageSize ?? 50,
          maxPages: Math.min(opts.maxPages ?? 180, 80),
          maxEventsPerYear: Math.min(opts.maxEventsPerYear ?? 16, 16),
          delayMs: parseDelayEnv("WTT_FOLLOWUP_DELAY_MS", WTT_FOLLOWUP_DEFAULT_DELAY_MS),
          eventScope: opts.eventScope ?? "singles_only",
          includeYouth: opts.includeYouth ?? false,
          backgroundReason: "auto-after-wtt-job",
          profileEnrichMaxPlayers: 0,
          profileEnrichMinMatches: opts.profileEnrichMinMatches ?? 2,
          reason: "auto-after-wtt-job",
          requestedByJobId: status.jobId,
        });
        emit(
          status,
          "SYSTEM",
          `Detected live/in-progress WTT matches (ongoing=${result.ongoingMatches}, notFinished=${result.notFinishedMatches}). Follow-up scrape scheduled for ${followup.scheduledFor}.`,
        );
      }
      if (opts.backgroundReason) {
        await appendSyncActivity("wtt", "Background WTT sync completed.", {
          mode: "wtt-background-complete",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          summary: {
            years: result.years,
            matches: result.matches,
            ongoingMatches: result.ongoingMatches,
            notFinishedMatches: result.notFinishedMatches,
            youthMatches: result.youthMatches,
          },
        });
      }
      status.result = { result, players, followup };
    } else if (status.type === "wtt-all-time") {
      const opts = options as ActionJobOptionsByType["wtt-all-time"];
      if (opts.backgroundReason) {
        await appendSyncActivity("wtt", "Background WTT all-time sync started.", {
          mode: "wtt-all-time-background-start",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          sourceJobId: opts.backgroundSourceJobId ?? null,
          checks: {
            startYear: opts.startYear ?? null,
            endYear: opts.endYear ?? null,
            maxEventsPerYear: opts.maxEventsPerYear ?? null,
            includeYouth: opts.includeYouth ?? false,
          },
        });
      }
      emit(
        status,
        "API",
        `Starting WTT all-time scrape (range=${opts.startYear ?? "default"}-${opts.endYear ?? "default"}, pageSize=${opts.pageSize ?? "default"}, maxPages=${opts.maxPages ?? "default"}, maxEventsPerYear=${opts.maxEventsPerYear ?? "default"}, eventScope=${opts.eventScope ?? "singles_only"}, includeYouth=${opts.includeYouth ?? false}).`,
      );
      const result = await scrapeWTTAllTime({
        startYear: opts.startYear,
        endYear: opts.endYear,
        pageSize: opts.pageSize,
        maxPages: opts.maxPages,
        maxEventsPerYear: opts.maxEventsPerYear,
        delayMs: opts.delayMs,
        eventScope: opts.eventScope,
        includeYouth: opts.includeYouth,
        profileEnrichMaxPlayers: opts.profileEnrichMaxPlayers,
        profileEnrichMinMatches: opts.profileEnrichMinMatches,
        onLog: (message) => appendWorkerLog(status, message),
      });
      throwIfJobCancelled(status);
      emit(status, "API", "Rebuilding player registry after WTT all-time scrape.");
      const players = await rebuildPlayerRegistry((message) => appendWorkerLog(status, message));
      let followup: WTTFollowupStatus | null = null;
      const scrape = result.scrape;
      const needsFollowup = (scrape.ongoingMatches ?? 0) > 0 || (scrape.notFinishedMatches ?? 0) > 0;
      if (needsFollowup) {
        const latestYear = [...scrape.years].sort((a, b) => b - a)[0];
        followup = scheduleWTTFollowupInBackground({
          years: Number.isFinite(latestYear) ? [latestYear as number] : undefined,
          pageSize: opts.pageSize ?? 50,
          maxPages: Math.min(opts.maxPages ?? 180, 80),
          maxEventsPerYear: Math.min(opts.maxEventsPerYear ?? 16, 16),
          delayMs: parseDelayEnv("WTT_FOLLOWUP_DELAY_MS", WTT_FOLLOWUP_DEFAULT_DELAY_MS),
          eventScope: opts.eventScope ?? "singles_only",
          includeYouth: opts.includeYouth ?? false,
          backgroundReason: "auto-after-wtt-all-time-job",
          profileEnrichMaxPlayers: 0,
          profileEnrichMinMatches: opts.profileEnrichMinMatches ?? 2,
          reason: "auto-after-wtt-all-time-job",
          requestedByJobId: status.jobId,
        });
        emit(
          status,
          "SYSTEM",
          `Detected live/in-progress WTT matches during all-time scrape (ongoing=${scrape.ongoingMatches}, notFinished=${scrape.notFinishedMatches}). Follow-up scrape scheduled for ${followup.scheduledFor}.`,
        );
      }
      if (opts.backgroundReason) {
        await appendSyncActivity("wtt", "Background WTT all-time sync completed.", {
          mode: "wtt-all-time-background-complete",
          jobId: status.jobId,
          reason: opts.backgroundReason,
          summary: {
            discoveredYears: result.discoveredYears.length,
            matches: scrape.matches,
            ongoingMatches: scrape.ongoingMatches,
            notFinishedMatches: scrape.notFinishedMatches,
          },
        });
      }
      status.result = { result, players, followup };
    } else if (status.type === "players-registry") {
      const opts = options as StartPlayersRegistryActionJobOptions;
      emit(status, "API", "Starting player registry rebuild.");
      const registry = await rebuildPlayerRegistry(
        (message) => appendWorkerLog(status, message),
        {
          failOnUnresolvedCandidates: opts.failOnUnresolvedCandidates === true,
        },
      );
      status.result = {
        registry,
        strict: opts.failOnUnresolvedCandidates === true,
        backgroundReason: opts.backgroundReason ?? null,
        backgroundSourceJobId: opts.backgroundSourceJobId ?? null,
      };
    } else {
      emit(status, "API", "Destroying stored relational data.");
      throwIfJobCancelled(status);
      const prisma = getPrismaClient();
      if (!prisma) {
        throw new Error("DATABASE_URL is required for destroy-data.");
      }
      const preservedSyncEntries = await listSyncActivityEntries(5000);
      await prisma.$transaction(async (tx) => {
        await tx.playerMergeCandidate.deleteMany({});
        await tx.playerCanonicalMember.deleteMany({});
        await tx.playerCanonical.deleteMany({});
        await tx.playerRegistryState.deleteMany({});
        await tx.playerManualAlias.deleteMany({});
        await tx.ttblGame.deleteMany({});
        await tx.ttblMatch.deleteMany({});
        await tx.ttblPlayerSeasonStat.deleteMany({});
        await tx.ttblSeasonSummary.deleteMany({});
        await tx.ttblPlayerProfile.deleteMany({});
        await tx.ttblPlayer.deleteMany({});
        await tx.wttMatchGame.deleteMany({});
        await tx.wttMatch.deleteMany({});
        await tx.wttPlayer.deleteMany({});
      });
      await removeDir(DATA_ROOT);
      if (preservedSyncEntries.length > 0) {
        await replaceSyncActivityEntries(preservedSyncEntries);
        emit(
          status,
          "API",
          `Restored ${preservedSyncEntries.length} background sync activity log entries.`,
        );
      }
      emit(status, "API", "Relational data cleared.");
      status.result = {
        storage: "postgres",
        restoredSyncActivityEntries: preservedSyncEntries.length,
      };
    }

    status.state = "completed";
    status.finishedAt = nowIso();
    status.updatedAt = status.finishedAt;
    emit(status, "SYSTEM", "Job completed successfully.");
  } catch (error) {
    status.state = "failed";
    const cancelled = error instanceof ActionJobCancelledError || Boolean(getCancellationReason(status.jobId));
    status.error = error instanceof Error ? error.message : "unknown error";
    status.finishedAt = nowIso();
    status.updatedAt = status.finishedAt;
    emit(status, "SYSTEM", cancelled ? `Job cancelled: ${status.error}` : `Job failed: ${status.error}`);
    const backgroundReason = (options as { backgroundReason?: string }).backgroundReason;
    if (backgroundReason && !cancelled) {
      const source: "ttbl" | "wtt" =
        status.type === "ttbl" || status.type === "ttbl-legacy" || status.type === "ttbl-all-time"
          ? "ttbl"
          : "wtt";
      await appendSyncActivity(
        source,
        `Background ${source.toUpperCase()} sync failed.`,
        {
          mode: `${source}-background-failed`,
          jobId: status.jobId,
          reason: backgroundReason,
          error: status.error,
        },
        "error",
      );
    }
  } finally {
    const store = getStore();
    store.cancelControllers.delete(status.jobId);
    store.cancelReasons.delete(status.jobId);
  }
}

async function runDestroyWhenIdle(
  status: ActionJobStatus,
  options: ActionJobOptionsByType["destroy-data"],
): Promise<void> {
  let lastBlockedBy: string | null = null;

  while (true) {
    const cancelReason = getCancellationReason(status.jobId);
    if (cancelReason) {
      status.state = "failed";
      status.error = cancelReason;
      status.startedAt = status.startedAt ?? nowIso();
      status.finishedAt = nowIso();
      status.updatedAt = status.finishedAt;
      emit(status, "SYSTEM", `Job cancelled before execution: ${cancelReason}`);
      const store = getStore();
      store.cancelControllers.delete(status.jobId);
      store.cancelReasons.delete(status.jobId);
      return;
    }

    const blocking = getRunningActionJob();
    if (blocking?.jobId === status.jobId) {
      break;
    }
    if (!blocking) {
      break;
    }

    const blockedBy = `${blocking.type}:${blocking.jobId}`;
    if (blockedBy !== lastBlockedBy) {
      emit(
        status,
        "SYSTEM",
        `Destroy-data queued: waiting for active job ${blocking.type} (${blocking.jobId}) to finish.`,
      );
      lastBlockedBy = blockedBy;
    }

    status.updatedAt = nowIso();
    await sleep(DESTROY_WAIT_POLL_MS);
  }

  await runActionJob(status, options);
}

export function startActionJob<T extends ActionJobType>(
  type: T,
  options: ActionJobOptionsByType[T],
): { alreadyRunning: boolean; status: ActionJobStatus } {
  const activeSameType = getActiveActionJob(type);
  if (activeSameType && activeSameType.state === "running") {
    return { alreadyRunning: true, status: activeSameType };
  }

  const runningAnyType = getRunningActionJob();
  if (runningAnyType && type !== "destroy-data") {
    return { alreadyRunning: true, status: runningAnyType };
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

  const store = getStore();
  store.jobs.set(status.jobId, status);
  store.cancelControllers.set(status.jobId, new AbortController());
  store.cancelReasons.delete(status.jobId);

  if (type === "destroy-data") {
    void runDestroyWhenIdle(status, options as ActionJobOptionsByType["destroy-data"]);
  } else {
    void runActionJob(status, options);
  }

  return {
    alreadyRunning: false,
    status,
  };
}
