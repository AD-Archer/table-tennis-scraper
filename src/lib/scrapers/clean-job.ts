import { randomUUID } from "node:crypto";
import { logAdminError } from "@/lib/admin/error-log";
import { logServerEvent } from "@/lib/server/logger";
import {
  CleanScrapeOptions,
  CleanScrapeResult,
  runCleanScrape,
} from "@/lib/scrapers/clean";

export type CleanScrapeJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface CleanScrapeJobStatus {
  jobId: string;
  state: CleanScrapeJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  logs: string[];
  result: CleanScrapeResult | null;
  error: string | null;
}

interface JobsStore {
  jobs: Map<string, CleanScrapeJobStatus>;
}

const globalStore = globalThis as typeof globalThis & {
  __cleanScrapeJobs?: JobsStore;
};

function getStore(): JobsStore {
  if (!globalStore.__cleanScrapeJobs) {
    globalStore.__cleanScrapeJobs = {
      jobs: new Map<string, CleanScrapeJobStatus>(),
    };
  }

  return globalStore.__cleanScrapeJobs;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getActiveJob(): CleanScrapeJobStatus | null {
  const store = getStore();
  const rows = [...store.jobs.values()]
    .filter((job) => job.state === "queued" || job.state === "running")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return rows[0] ?? null;
}

function appendLog(job: CleanScrapeJobStatus, message: string): void {
  job.logs.push(message);
  if (job.logs.length > 1200) {
    job.logs.splice(0, job.logs.length - 1200);
  }
  job.updatedAt = nowIso();
}

export function getCleanScrapeJob(jobId: string): CleanScrapeJobStatus | null {
  const store = getStore();
  return store.jobs.get(jobId) ?? null;
}

export function getLatestCleanScrapeJob(): CleanScrapeJobStatus | null {
  const store = getStore();
  const rows = [...store.jobs.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  return rows[0] ?? null;
}

export function startCleanScrapeJob(options: CleanScrapeOptions): {
  alreadyRunning: boolean;
  status: CleanScrapeJobStatus;
} {
  const active = getActiveJob();
  if (active) {
    logServerEvent({
      level: "info",
      scope: "clean-job",
      event: "joined_running_job",
      message: "Joined running clean scrape job.",
      context: {
        jobId: active.jobId,
        state: active.state,
      },
    });
    return {
      alreadyRunning: true,
      status: active,
    };
  }

  const createdAt = nowIso();
  const status: CleanScrapeJobStatus = {
    jobId: randomUUID(),
    state: "queued",
    createdAt,
    startedAt: null,
    finishedAt: null,
    updatedAt: createdAt,
    logs: [
      `[${createdAt}] Job queued. Waiting to start clean scrape workflow.`,
    ],
    result: null,
    error: null,
  };

  const store = getStore();
  store.jobs.set(status.jobId, status);
  logServerEvent({
    level: "info",
    scope: "clean-job",
    event: "job_queued",
    message: "Clean scrape job queued.",
    context: {
      jobId: status.jobId,
    },
  });

  void (async () => {
    status.state = "running";
    status.startedAt = nowIso();
    status.updatedAt = status.startedAt;
    appendLog(status, `[${status.startedAt}] Job started.`);
    logServerEvent({
      level: "info",
      scope: "clean-job",
      event: "job_started",
      message: "Clean scrape job started.",
      context: {
        jobId: status.jobId,
      },
    });

    try {
      const result = await runCleanScrape(options, (message) => {
        appendLog(status, message);
      });

      status.state = "completed";
      status.result = result;
      status.finishedAt = nowIso();
      status.updatedAt = status.finishedAt;
      appendLog(status, `[${status.finishedAt}] Job completed successfully.`);
      logServerEvent({
        level: "info",
        scope: "clean-job",
        event: "job_completed",
        message: "Clean scrape job completed successfully.",
        context: {
          jobId: status.jobId,
          startedAt: status.startedAt,
          finishedAt: status.finishedAt,
        },
      });
    } catch (error) {
      const finishedAt = nowIso();
      status.state = "failed";
      status.error = error instanceof Error ? error.message : "unknown error";
      status.finishedAt = finishedAt;
      status.updatedAt = finishedAt;
      appendLog(status, `[${finishedAt}] Job failed: ${status.error}`);
      await logAdminError({
        category: "scrape",
        source: "master-sync",
        operation: "clean-scrape",
        jobId: status.jobId,
        jobType: "clean-scrape",
        message: status.error,
        error,
        details: {
          startedAt: status.startedAt,
          finishedAt: status.finishedAt,
          options,
          logsTail: status.logs.slice(-100),
        },
      }).catch(() => undefined);
      logServerEvent({
        level: "error",
        scope: "clean-job",
        event: "job_failed",
        message: "Clean scrape job failed.",
        context: {
          jobId: status.jobId,
          error: status.error,
        },
        error,
      });
    }
  })();

  return {
    alreadyRunning: false,
    status,
  };
}
