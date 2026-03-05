"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import {
  clearAdminConsoleToken,
  readAdminConsoleToken,
  writeAdminConsoleToken,
} from "@/lib/admin/browser-token";

type AdminErrorCategory = "scrape" | "merge" | "system";
type AdminErrorStatus = "open" | "resolved";
type AdminTab = "issue" | "errors" | "logs" | "merge" | "debug";

interface AdminErrorEntry {
  id: string;
  timestamp: string;
  category: AdminErrorCategory;
  status: AdminErrorStatus;
  source: string;
  operation: string;
  jobId: string | null;
  jobType: string | null;
  message: string;
  errorName: string | null;
  errorStack: string | null;
  details: Record<string, unknown> | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

interface MergeCandidateRow {
  leftCanonicalKey: string;
  rightCanonicalKey: string;
  leftName: string;
  rightName: string;
  reason: string;
}

interface RegistryEnvelope {
  ok: boolean;
  error?: string;
  registry?: {
    mergeCandidates?: MergeCandidateRow[];
  } | null;
}

interface RegistryJobEnvelope {
  ok: boolean;
  error?: string;
  jobId?: string;
}

interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
}

interface ActiveJob {
  jobId: string;
  type: string;
  state: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt: string | null;
  progress: {
    totalLogs: number;
    recentLogs: string[];
  };
}

interface ScheduledFollowup {
  scheduled: boolean;
  scheduledFor: string | null;
  [key: string]: unknown;
}

interface ActiveJobsResponse {
  ok: boolean;
  activeJobs: ActiveJob[];
  scheduled: {
    ttbl: ScheduledFollowup | null;
    wtt: ScheduledFollowup | null;
  };
}

type AdminFetcher = (
  url: string,
  init?: RequestInit,
) => Promise<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  const error = payload.error;
  return typeof error === "string" && error.length > 0 ? error : fallback;
}

function isMergeCandidateRow(value: unknown): value is MergeCandidateRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.leftCanonicalKey === "string" &&
    typeof value.rightCanonicalKey === "string" &&
    typeof value.leftName === "string" &&
    typeof value.rightName === "string" &&
    typeof value.reason === "string"
  );
}

function toRegistryEnvelope(payload: Record<string, unknown>): RegistryEnvelope {
  const registry = payload.registry;
  const mergeCandidates =
    isRecord(registry) && Array.isArray(registry.mergeCandidates)
      ? registry.mergeCandidates.filter(isMergeCandidateRow)
      : undefined;

  return {
    ok: payload.ok === true,
    error: typeof payload.error === "string" ? payload.error : undefined,
    registry: isRecord(registry) ? { mergeCandidates } : null,
  };
}

function isActiveJob(value: unknown): value is ActiveJob {
  if (!isRecord(value) || !isRecord(value.progress)) {
    return false;
  }
  return (
    typeof value.jobId === "string" &&
    typeof value.type === "string" &&
    (value.state === "queued" ||
      value.state === "running" ||
      value.state === "completed" ||
      value.state === "failed") &&
    typeof value.createdAt === "string" &&
    (typeof value.startedAt === "string" || value.startedAt === null) &&
    typeof value.progress.totalLogs === "number" &&
    Array.isArray(value.progress.recentLogs) &&
    value.progress.recentLogs.every((log) => typeof log === "string")
  );
}

function toScheduledFollowup(value: unknown): ScheduledFollowup | null {
  if (!isRecord(value)) {
    return null;
  }

  const scheduledFor = value.scheduledFor;
  return {
    ...value,
    scheduled: typeof value.scheduled === "boolean" ? value.scheduled : false,
    scheduledFor:
      typeof scheduledFor === "string" || scheduledFor === null
        ? scheduledFor
        : null,
  };
}

function toActiveJobsResponse(payload: Record<string, unknown>): ActiveJobsResponse {
  const scheduled = isRecord(payload.scheduled) ? payload.scheduled : {};
  return {
    ok: payload.ok === true,
    activeJobs: Array.isArray(payload.activeJobs)
      ? payload.activeJobs.filter(isActiveJob)
      : [],
    scheduled: {
      ttbl: toScheduledFollowup(scheduled.ttbl),
      wtt: toScheduledFollowup(scheduled.wtt),
    },
  };
}

function fmtDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatStackForUi(
  stack: string | null,
  includeFrameworkFrames: boolean,
): string {
  if (!stack) {
    return "No stack trace captured.";
  }

  const lines = stack
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0);
  if (lines.length === 0) {
    return "No stack trace captured.";
  }

  if (includeFrameworkFrames) {
    return lines.slice(0, 80).join("\n");
  }

  const header = lines[0] ?? "Error";
  const frames = lines.slice(1);
  const appFrames = frames.filter((line) => {
    const normalized = line.toLowerCase();
    return (
      !normalized.includes("node_modules") &&
      !normalized.includes("next/dist") &&
      !normalized.includes("internal/process/task_queues")
    );
  });
  const selectedFrames = (appFrames.length > 0 ? appFrames : frames).slice(0, 16);
  const omitted = Math.max(0, frames.length - selectedFrames.length);

  return [
    header,
    ...selectedFrames,
    omitted > 0 ? `... ${omitted} additional frames hidden` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildReadableCopyPayload(
  entry: AdminErrorEntry,
  includeFrameworkFrames: boolean,
): string {
  return [
    `Error Log: ${entry.id}`,
    `Timestamp: ${entry.timestamp}`,
    `Category: ${entry.category}`,
    `Status: ${entry.status}`,
    `Source: ${entry.source}`,
    `Operation: ${entry.operation}`,
    `Job: ${entry.jobType ?? "-"} (${entry.jobId ?? "-"})`,
    `Message: ${entry.message}`,
    `Resolved At: ${entry.resolvedAt ?? "-"}`,
    `Resolution Note: ${entry.resolutionNote ?? "-"}`,
    "",
    "Stack Trace:",
    formatStackForUi(entry.errorStack, includeFrameworkFrames),
    "",
    "Details:",
    JSON.stringify(entry.details ?? {}, null, 2),
  ].join("\n");
}

export function AdminErrorConsole() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const requestedTab: AdminTab =
    tabParam === "issue" ||
    tabParam === "errors" ||
    tabParam === "logs" ||
    tabParam === "merge" ||
    tabParam === "debug"
      ? tabParam
      : "errors";
  const errorIdFromUrl = searchParams.get("errorId");
  const activeTab: AdminTab = errorIdFromUrl
    ? "issue"
    : requestedTab === "issue"
      ? "errors"
      : requestedTab;

  const [passwordInput, setPasswordInput] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [statusMessage, setStatusMessage] = useState("Admin console is locked.");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showFrameworkFrames, setShowFrameworkFrames] = useState(false);

  const [allErrors, setAllErrors] = useState<AdminErrorEntry[]>([]);
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidateRow[]>([]);
  const [resolutionNotes, setResolutionNotes] = useState<Record<string, string>>({});

  const [statusFilter, setStatusFilter] = useState<"all" | AdminErrorStatus>("all");
  const [categoryFilter, setCategoryFilter] = useState<"all" | AdminErrorCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Live logs state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLevel, setLogsLevel] = useState<"all" | "info" | "warn" | "error">("all");
  const [isLogsConnected, setIsLogsConnected] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [scheduledTTBL, setScheduledTTBL] = useState<ScheduledFollowup | null>(null);
  const [scheduledWTT, setScheduledWTT] = useState<ScheduledFollowup | null>(null);
  const logsViewerRef = useRef<HTMLDivElement>(null);
  const didAttemptAutoUnlock = useRef(false);

  const selectedError = useMemo(
    () => allErrors.find((row) => row.id === errorIdFromUrl) ?? null,
    [allErrors, errorIdFromUrl],
  );

  const filteredErrors = useMemo(() => {
    let filtered = allErrors;
    if (statusFilter !== "all") {
      filtered = filtered.filter((row) => row.status === statusFilter);
    }
    if (categoryFilter !== "all") {
      filtered = filtered.filter((row) => row.category === categoryFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((row) =>
        JSON.stringify(row).toLowerCase().includes(q),
      );
    }
    return filtered;
  }, [allErrors, statusFilter, categoryFilter, searchQuery]);

  const mergeReasonSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of mergeCandidates) {
      counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6);
  }, [mergeCandidates]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => logsLevel === "all" || log.level === logsLevel);
  }, [logs, logsLevel]);

  const adminFetchWithPassword = useCallback(
    async (
      password: string,
      url: string,
      init?: RequestInit,
    ): Promise<Record<string, unknown>> => {
      const headers = new Headers(init?.headers);
      headers.set("x-admin-console-password", password);
      if (init?.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      const response = await fetch(url, {
        ...init,
        headers,
        cache: "no-store",
      });
      const json = await response.json().catch(() => ({}));
      const payload = isRecord(json) ? json : {};

      if (!response.ok) {
        throw new Error(readErrorMessage(payload, `Request failed: ${response.status}`));
      }

      return payload;
    },
    [],
  );

  const adminFetch = useCallback(
    (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
      if (!adminPassword) {
        throw new Error("Admin console locked.");
      }
      return adminFetchWithPassword(adminPassword, url, init);
    },
    [adminPassword, adminFetchWithPassword],
  );

  function onLock(): void {
    setAdminPassword("");
    setStatusMessage("Admin console is locked.");
    clearAdminConsoleToken();
  }

  const loadErrors = useCallback(async (fetcher: AdminFetcher = adminFetch): Promise<void> => {
    try {
      const payload = await fetcher("/api/admin/errors");
      const rawRows = Array.isArray(payload.entries)
        ? payload.entries
        : Array.isArray(payload.errors)
          ? payload.errors
          : [];
      const rows = rawRows as AdminErrorEntry[];
      setAllErrors(rows);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load errors.",
      );
    }
  }, [adminFetch]);

  const loadMergeCandidates = useCallback(async (fetcher: AdminFetcher = adminFetch): Promise<void> => {
    try {
      const rawPayload = await fetcher("/api/players/country-conflicts");
      const payload = toRegistryEnvelope(rawPayload);
      if (!payload.ok) {
        throw new Error(readErrorMessage(rawPayload, "Failed to load candidates."));
      }
      setMergeCandidates(payload.registry?.mergeCandidates ?? []);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load candidates.",
      );
    }
  }, [adminFetch]);

  const loadActiveJobs = useCallback(async (fetcher: AdminFetcher = adminFetch): Promise<void> => {
    try {
      const rawPayload = await fetcher("/api/admin/scrape/active");
      const payload = toActiveJobsResponse(rawPayload);
      if (!payload.ok) {
        throw new Error(readErrorMessage(rawPayload, "Failed to load active jobs."));
      }
      setActiveJobs(payload.activeJobs ?? []);
      setScheduledTTBL(payload.scheduled?.ttbl || null);
      setScheduledWTT(payload.scheduled?.wtt || null);
    } catch (error) {
      console.error("Failed to load active jobs:", error);
    }
  }, [adminFetch]);

  const refreshAll = useCallback(async (fetcher: AdminFetcher = adminFetch): Promise<void> => {
    try {
      await Promise.all([
        loadErrors(fetcher),
        loadMergeCandidates(fetcher),
        loadActiveJobs(fetcher),
      ]);
    } catch {
      // Already handled individually
    }
  }, [adminFetch, loadErrors, loadMergeCandidates, loadActiveJobs]);

  async function onUnlock(): Promise<void> {
    const password = passwordInput.trim();
    if (!password) {
      setStatusMessage("Enter the admin console password.");
      return;
    }

    setBusyKey("unlock");
    try {
      const payload = await adminFetchWithPassword(
        password,
        "/api/admin/access",
      );
      if (payload.ok !== true) {
        throw new Error(readErrorMessage(payload, "Access denied"));
      }

      const unlockedFetch: AdminFetcher = (url, init) =>
        adminFetchWithPassword(password, url, init);
      setPasswordInput(password);
      setAdminPassword(password);
      writeAdminConsoleToken(password);
      setStatusMessage("Console unlocked.");
      await refreshAll(unlockedFetch);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Access denied.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  function setTab(tab: AdminTab): void {
    const params = new URLSearchParams(searchParams);
    if (tab === "issue") {
      const issueId = errorIdFromUrl;
      if (!issueId) {
        params.set("tab", "errors");
        params.delete("errorId");
      } else {
        params.set("tab", "issue");
        params.set("errorId", issueId);
      }
    } else {
      params.set("tab", tab);
      params.delete("errorId");
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  function selectError(id: string): void {
    const params = new URLSearchParams(searchParams);
    params.set("tab", "issue");
    params.set("errorId", id);
    router.push(`?${params.toString()}`, { scroll: false });
  }

  useEffect(() => {
    if (didAttemptAutoUnlock.current) {
      return;
    }
    didAttemptAutoUnlock.current = true;

    const token = readAdminConsoleToken();
    if (!token) {
      return;
    }

    let cancelled = false;
    setBusyKey("restore");

    void (async () => {
      try {
        const payload = await adminFetchWithPassword(token, "/api/admin/access");
        if (payload.ok !== true) {
          throw new Error(readErrorMessage(payload, "Access denied"));
        }
        if (cancelled) {
          return;
        }

        const restoredFetch: AdminFetcher = (url, init) =>
          adminFetchWithPassword(token, url, init);
        setPasswordInput(token);
        setAdminPassword(token);
        setStatusMessage("Console unlocked from saved token.");
        await refreshAll(restoredFetch);
      } catch (error) {
        clearAdminConsoleToken();
        if (!cancelled) {
          setAdminPassword("");
          setPasswordInput("");
          setStatusMessage(
            error instanceof Error
              ? `Saved token expired: ${error.message}`
              : "Saved token expired. Unlock again.",
          );
        }
      } finally {
        setBusyKey((current) => (current === "restore" ? null : current));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adminFetchWithPassword, refreshAll]);

  // Setup live logs stream
  useEffect(() => {
    if (!adminPassword) {
      setIsLogsConnected(false);
      return;
    }

    let closeRequested = false;
    const eventSource = new EventSource(
      `/api/admin/logs/stream?x-admin-console-password=${encodeURIComponent(adminPassword)}`,
    );

    eventSource.addEventListener("open", () => {
      if (!closeRequested) {
        setIsLogsConnected(true);
      }
    });

    eventSource.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "log") {
          setLogs((prev) => {
            const updated = [
              ...prev,
              {
                timestamp: message.timestamp,
                level: message.level || "info",
                source: message.source,
                message: message.message,
              },
            ];
            return updated.slice(-1000);
          });
        }
      } catch {
        // Ignore parse errors
      }
    });

    eventSource.addEventListener("error", () => {
      if (!closeRequested) {
        setIsLogsConnected(false);
        eventSource.close();
      }
    });

    return () => {
      closeRequested = true;
      eventSource.close();
    };
  }, [adminPassword]);

  // Auto-scroll logs viewer
  useEffect(() => {
    if (logsViewerRef.current) {
      logsViewerRef.current.scrollTop = logsViewerRef.current.scrollHeight;
    }
  }, [filteredLogs]);

  // Reload active jobs periodically
  useEffect(() => {
    if (!adminPassword) return;
    const interval = setInterval(() => {
      void loadActiveJobs();
    }, 3000);
    return () => clearInterval(interval);
  }, [adminPassword, loadActiveJobs]);

  async function onCopyError(entry: AdminErrorEntry): Promise<void> {
    const text = buildReadableCopyPayload(entry, showFrameworkFrames);
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage("Error details copied to clipboard.");
    } catch {
      setStatusMessage("Failed to copy to clipboard.");
    }
  }

  async function onPatchErrorStatus(
    id: string,
    newStatus: AdminErrorStatus,
  ): Promise<void> {
    setBusyKey(`patch-${id}`);
    try {
      const note = resolutionNotes[id] ?? "";
      await adminFetch(`/api/admin/errors/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus, resolutionNote: note }),
      });
      await loadErrors();
      setStatusMessage(`Error ${id} updated.`);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to update error.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function onDeleteError(id: string): Promise<void> {
    setBusyKey(`delete-${id}`);
    try {
      await adminFetch(`/api/admin/errors/${id}`, {
        method: "DELETE",
      });
      await loadErrors();
      setStatusMessage(`Error ${id} deleted.`);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to delete error.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function onClearResolved(): Promise<void> {
    setBusyKey("clear-resolved");
    try {
      await adminFetch("/api/admin/errors?mode=resolved", {
        method: "DELETE",
      });
      await loadErrors();
      setStatusMessage("Resolved errors deleted.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to clear resolved logs.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function onCancelScrapeJob(jobId: string): Promise<void> {
    setBusyKey(`cancel-job-${jobId}`);
    try {
      await adminFetch(`/api/admin/scrape/cancel/${jobId}`, {
        method: "POST",
      });
      setStatusMessage(`Job ${jobId} cancelled.`);
      await loadActiveJobs();
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to cancel job.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function onCancelScheduled(target: "ttbl" | "wtt" | "all"): Promise<void> {
    setBusyKey(`cancel-scheduled-${target}`);
    try {
      await adminFetch("/api/admin/scrape/cancel-scheduled", {
        method: "POST",
        body: JSON.stringify({ target }),
      });
      setStatusMessage(`Scheduled ${target} followups cancelled.`);
      await loadActiveJobs();
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to cancel scheduled jobs.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function onRunRegistryRefresh(strict: boolean): Promise<void> {
    setBusyKey(strict ? "strict-registry" : "registry");
    try {
      const response = await fetch("/api/players/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strict }),
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as RegistryJobEnvelope;
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.error ?? `Registry job start failed (${response.status})`,
        );
      }

      setStatusMessage(
        `${strict ? "Strict" : "Standard"} merge refresh started (job ${payload.jobId ?? "-"})`,
      );
      await Promise.all([loadErrors(), loadMergeCandidates()]);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to start merge refresh.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  function isConsoleTransitionBusy(): boolean {
    return busyKey === "unlock" || busyKey === "restore";
  }

  function isErrorRowMutationBusy(id: string): boolean {
    return (
      busyKey === `patch-${id}` ||
      busyKey === `delete-${id}` ||
      busyKey === "clear-resolved"
    );
  }

  return (
    <main className="dashboard-shell admin-console-shell">
      <section className="panel fade-in">
        <p className="eyebrow">Admin Console</p>
        <h1 className="title">Error Triage & Scrape Monitor</h1>
        <p className="hint">
          Monitor errors, live scraping activity, track merge diagnostics, and manage operations.
        </p>
      </section>

      <section className="panel admin-section-stack">
        <h2>Console Access</h2>
        <label>
          Admin Console Password
          <input
            type="password"
            value={passwordInput}
            onChange={(event) => setPasswordInput(event.target.value)}
            placeholder="Server env: ADMIN_CONSOLE_PASSWORD"
          />
        </label>
        <div className="inline-actions">
          <button
            className="btn btn-primary"
            disabled={busyKey !== null}
            onClick={onUnlock}
            type="button"
          >
            {busyKey === "unlock" ? "Unlocking..." : "Unlock console"}
          </button>
          <button
            className="btn btn-ghost"
            disabled={busyKey !== null || !adminPassword}
            onClick={onLock}
            type="button"
          >
            Lock console
          </button>
          <button
            className="btn btn-ghost"
            disabled={busyKey !== null || !adminPassword}
            onClick={() => void refreshAll()}
            type="button"
          >
            Refresh data
          </button>
        </div>
        <p className="hint">{statusMessage}</p>
      </section>

      {adminPassword ? (
        <>
          {/* Tab Navigation */}
          <section className="panel">
            <div className="tab-nav">
              {(
                errorIdFromUrl
                  ? (["issue", "errors", "logs", "merge", "debug"] as const)
                  : (["errors", "logs", "merge", "debug"] as const)
              ).map((tab) => (
                <button
                  key={tab}
                  className={`tab-button ${activeTab === tab ? "active" : ""}`}
                  onClick={() => setTab(tab)}
                  type="button"
                >
                  {tab === "issue" && "Active Issue"}
                  {tab === "errors" && "Errors"}
                  {tab === "logs" && "Live Logs"}
                  {tab === "merge" && "Merge"}
                  {tab === "debug" && "Debug"}
                </button>
              ))}
            </div>
          </section>

          {/* Active Issue Tab */}
          {activeTab === "issue" && (
            <section className="panel admin-section-stack">
              <h2>Active Issue</h2>
              <div className="inline-actions">
                <button
                  className="btn btn-ghost"
                  disabled={isConsoleTransitionBusy()}
                  onClick={() => setTab("errors")}
                  type="button"
                >
                  Back to error list
                </button>
              </div>
              {selectedError ? (
                <>
                  <div className="admin-detail-grid">
                    <div className="admin-detail-card">
                      <span>Error ID</span>
                      <strong>{selectedError.id}</strong>
                    </div>
                    <div className="admin-detail-card">
                      <span>Time</span>
                      <strong>{fmtDate(selectedError.timestamp)}</strong>
                    </div>
                    <div className="admin-detail-card">
                      <span>Category</span>
                      <strong>{selectedError.category}</strong>
                    </div>
                    <div className="admin-detail-card">
                      <span>Status</span>
                      <strong>{selectedError.status}</strong>
                    </div>
                    <div className="admin-detail-card">
                      <span>Source</span>
                      <strong>{selectedError.source}</strong>
                    </div>
                    <div className="admin-detail-card">
                      <span>Operation</span>
                      <strong>{selectedError.operation}</strong>
                    </div>
                  </div>

                  <div className="admin-section-stack">
                    <div className="message-block">{selectedError.message}</div>
                    {selectedError.errorStack && (
                      <details>
                        <summary>
                          Stack Trace ({selectedError.errorStack.split("\n").length} frames)
                        </summary>
                        <code className="stack-trace">
                          {formatStackForUi(selectedError.errorStack, showFrameworkFrames)}
                        </code>
                      </details>
                    )}
                    {selectedError.details && (
                      <details>
                        <summary>Details</summary>
                        <code className="json-block">
                          {JSON.stringify(selectedError.details, null, 2)}
                        </code>
                      </details>
                    )}
                    <label>
                      Resolution Note
                      <textarea
                        value={resolutionNotes[selectedError.id] ?? ""}
                        onChange={(event) =>
                          setResolutionNotes((prev) => ({
                            ...prev,
                            [selectedError.id]: event.target.value,
                          }))
                        }
                        placeholder="Add a note about this error..."
                      />
                    </label>
                    <div className="inline-actions">
                      <button
                        className="btn btn-secondary"
                        disabled={isErrorRowMutationBusy(selectedError.id)}
                        onClick={() =>
                          void onPatchErrorStatus(
                            selectedError.id,
                            selectedError.status === "open" ? "resolved" : "open",
                          )
                        }
                        type="button"
                      >
                        {selectedError.status === "open" ? "Mark Resolved" : "Reopen"}
                      </button>
                      <button
                        className="btn btn-ghost"
                        disabled={isConsoleTransitionBusy()}
                        onClick={() => setShowFrameworkFrames(!showFrameworkFrames)}
                        type="button"
                      >
                        {showFrameworkFrames ? "Hide" : "Show"} Framework Frames
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={isErrorRowMutationBusy(selectedError.id)}
                        onClick={() => void onDeleteError(selectedError.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="admin-section-stack">
                  <p className="hint">
                    Issue not found for ID <code>{errorIdFromUrl ?? "-"}</code>.
                  </p>
                  <div className="inline-actions">
                    <button
                      className="btn btn-ghost"
                      disabled={isConsoleTransitionBusy()}
                      onClick={() => void loadErrors()}
                      type="button"
                    >
                      Refresh errors
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={isConsoleTransitionBusy()}
                      onClick={() => setTab("errors")}
                      type="button"
                    >
                      Open errors list
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Errors Tab */}
          {activeTab === "errors" && (
            <>
              <section className="panel admin-section-stack">
                <h2>Error Filters</h2>
                <div className="admin-filter-grid">
                  <label>
                    Status
                    <select
                      value={statusFilter}
                      onChange={(event) =>
                        setStatusFilter(
                          event.target.value as "all" | AdminErrorStatus,
                        )
                      }
                    >
                      <option value="all">All</option>
                      <option value="open">Open</option>
                      <option value="resolved">Resolved</option>
                    </select>
                  </label>
                  <label>
                    Category
                    <select
                      value={categoryFilter}
                      onChange={(event) =>
                        setCategoryFilter(
                          event.target.value as "all" | AdminErrorCategory,
                        )
                      }
                    >
                      <option value="all">All</option>
                      <option value="scrape">Scrape</option>
                      <option value="merge">Merge</option>
                      <option value="system">System</option>
                    </select>
                  </label>
                  <label>
                    Search
                    <input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="message, source, operation, job id"
                    />
                  </label>
                </div>
                <div className="inline-actions">
                  <button
                    className="btn btn-ghost"
                    disabled={busyKey !== null}
                    onClick={() => void loadErrors()}
                    type="button"
                  >
                    Refresh errors
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={busyKey !== null || allErrors.every((e) => e.status !== "resolved")}
                    onClick={() => void onClearResolved()}
                    type="button"
                  >
                    {busyKey === "clear-resolved" ? "Clearing..." : "Clear resolved"}
                  </button>
                </div>
              </section>

              <section className="panel">
                <h2>Error Logs ({filteredErrors.length})</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Category</th>
                        <th>Source</th>
                        <th>Status</th>
                        <th>Message</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredErrors.map((entry) => (
                        <tr key={entry.id}>
                          <td>{fmtDate(entry.timestamp)}</td>
                          <td>
                            <code>{entry.category}</code>
                          </td>
                          <td>
                            <code>{entry.source}</code>
                          </td>
                          <td>
                            <code>{entry.status}</code>
                          </td>
                          <td>{entry.message}</td>
                          <td>
                            <div className="inline-actions inline-actions-compact">
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={isConsoleTransitionBusy()}
                                onClick={() => selectError(entry.id)}
                                type="button"
                              >
                                View
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={isConsoleTransitionBusy()}
                                onClick={() => void onCopyError(entry)}
                                type="button"
                              >
                                Copy
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={isErrorRowMutationBusy(entry.id)}
                                onClick={() =>
                                  void onPatchErrorStatus(
                                    entry.id,
                                    entry.status === "open" ? "resolved" : "open",
                                  )
                                }
                                type="button"
                              >
                                {entry.status === "open" ? "Resolve" : "Reopen"}
                              </button>
                              <button
                                className="btn btn-danger btn-sm"
                                disabled={isErrorRowMutationBusy(entry.id)}
                                onClick={() => void onDeleteError(entry.id)}
                                type="button"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredErrors.length === 0 ? (
                        <tr>
                          <td colSpan={6}>No error logs matched current filters.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {/* Live Logs Tab */}
          {activeTab === "logs" && (
            <>
              <section className="panel">
                <h2>Active Scraping Jobs ({activeJobs.length})</h2>
                {activeJobs.length === 0 ? (
                  <p className="hint">No active scraping jobs.</p>
                ) : (
                  <div className="admin-section-stack">
                    {activeJobs.map((job) => (
                      <details
                        key={job.jobId}
                        className="admin-debug-details"
                      >
                        <summary>
                          <strong>{job.type}</strong> - {job.state} ({job.jobId.slice(0, 8)})
                          {job.startedAt && (
                            <span className="hint">
                              {" "}
                              started {fmtDate(job.startedAt)}
                            </span>
                          )}
                        </summary>
                        <div className="admin-section-stack">
                          <div className="admin-detail-grid">
                            <div className="admin-detail-card">
                              <span>Job ID</span>
                              <strong>{job.jobId}</strong>
                            </div>
                            <div className="admin-detail-card">
                              <span>Type</span>
                              <strong>{job.type}</strong>
                            </div>
                            <div className="admin-detail-card">
                              <span>State</span>
                              <strong>{job.state}</strong>
                            </div>
                            <div className="admin-detail-card">
                              <span>Total Logs</span>
                              <strong>{job.progress.totalLogs}</strong>
                            </div>
                          </div>
                          {job.progress.recentLogs.length > 0 && (
                            <div>
                              <p className="hint">Recent logs:</p>
                              <ul style={{ fontSize: "0.85rem", margin: "0.5rem 0" }}>
                                {job.progress.recentLogs.map((log, idx) => (
                                  <li key={idx}>{log}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          <button
                            className="btn btn-danger"
                            disabled={busyKey !== null || job.state === "completed" || job.state === "failed"}
                            onClick={() => void onCancelScrapeJob(job.jobId)}
                            type="button"
                          >
                            {busyKey === `cancel-job-${job.jobId}` ? "Cancelling..." : "Cancel Job"}
                          </button>
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </section>

              <section className="panel">
                <h2>Scheduled Followups</h2>
                <div className="admin-section-stack">
                  {scheduledTTBL?.scheduled ? (
                    <details className="admin-debug-details">
                      <summary>
                        <strong>TTBL Followup</strong> - Scheduled for{" "}
                        {fmtDate(scheduledTTBL.scheduledFor)}
                      </summary>
                      <div className="admin-section-stack">
                        <button
                          className="btn btn-danger"
                          disabled={busyKey !== null}
                          onClick={() => void onCancelScheduled("ttbl")}
                          type="button"
                        >
                          {busyKey === "cancel-scheduled-ttbl" ? "Cancelling..." : "Cancel TTBL Scheduled"}
                        </button>
                      </div>
                    </details>
                  ) : (
                    <p className="hint">No TTBL followups scheduled.</p>
                  )}
                  {scheduledWTT?.scheduled ? (
                    <details className="admin-debug-details">
                      <summary>
                        <strong>WTT Followup</strong> - Scheduled for{" "}
                        {fmtDate(scheduledWTT.scheduledFor)}
                      </summary>
                      <div className="admin-section-stack">
                        <button
                          className="btn btn-danger"
                          disabled={busyKey !== null}
                          onClick={() => void onCancelScheduled("wtt")}
                          type="button"
                        >
                          {busyKey === "cancel-scheduled-wtt" ? "Cancelling..." : "Cancel WTT Scheduled"}
                        </button>
                      </div>
                    </details>
                  ) : (
                    <p className="hint">No WTT followups scheduled.</p>
                  )}
                </div>
              </section>

              <section className="panel">
                <h2>Live Scraping Logs</h2>
                <div className="logs-filters">
                  <span className="logs-filter-label">Filter:</span>
                  {(["all", "info", "warn", "error"] as const).map((level) => (
                    <button
                      key={level}
                      className={`logs-filter-button ${logsLevel === level ? "active" : ""}`}
                      onClick={() => setLogsLevel(level)}
                      type="button"
                    >
                      {level}
                    </button>
                  ))}
                  <span className="hint" style={{ marginLeft: "auto" }}>
                    {isLogsConnected ? "🟢 Connected" : "🔴 Disconnected"}
                  </span>
                </div>
                <div className="logs-viewer" ref={logsViewerRef}>
                  {filteredLogs.length === 0 ? (
                    <div className="logs-empty">
                      {logs.length === 0
                        ? "Waiting for logs...\n\nLogs will appear here when scraping is active."
                        : "No logs matching current filter."}
                    </div>
                  ) : (
                    filteredLogs.map((log, idx) => (
                      <div key={idx} className={`log-entry ${log.level}`}>
                        <div className="log-time">{fmtDate(log.timestamp)}</div>
                        <div className="log-source">{log.source}</div>
                        <div className="log-message">{log.message}</div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}

          {/* Merge Tab */}
          {activeTab === "merge" && (
            <>
              <section className="panel admin-section-stack">
                <h2>Player Merge Diagnostics</h2>
                <p className="hint">
                  Automatic merge now tolerates country-code formatting differences
                  and near DOB mismatches for TTBL identity splits when other signals align.
                </p>
                <div className="inline-actions">
                  <button
                    className="btn btn-ghost"
                    disabled={busyKey !== null}
                    onClick={() => void onRunRegistryRefresh(false)}
                    type="button"
                  >
                    {busyKey === "registry" ? "Starting..." : "Run merge refresh"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={busyKey !== null}
                    onClick={() => void onRunRegistryRefresh(true)}
                    type="button"
                  >
                    {busyKey === "strict-registry" ? "Starting..." : "Run strict merge test"}
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busyKey !== null}
                    onClick={() => void loadMergeCandidates()}
                    type="button"
                  >
                    Refresh diagnostics
                  </button>
                </div>

                <div className="admin-detail-grid">
                  <div className="admin-detail-card">
                    <span>Unresolved Candidates</span>
                    <strong>{mergeCandidates.length}</strong>
                  </div>
                  <div className="admin-detail-card">
                    <span>Top Reason</span>
                    <strong>{mergeReasonSummary[0]?.[0] ?? "none"}</strong>
                  </div>
                  <div className="admin-detail-card">
                    <span>Count For Top Reason</span>
                    <strong>{mergeReasonSummary[0]?.[1] ?? 0}</strong>
                  </div>
                </div>

                <p className="hint">Reason summary</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Reason</th>
                        <th>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mergeReasonSummary.map(([reason, count]) => (
                        <tr key={`${reason}:${count}`}>
                          <td>{reason}</td>
                          <td>{count}</td>
                        </tr>
                      ))}
                      {mergeReasonSummary.length === 0 ? (
                        <tr>
                          <td colSpan={2}>No unresolved reasons.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                <p className="hint">Sample unresolved candidates</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Left</th>
                        <th>Right</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mergeCandidates.slice(0, 20).map((row, index) => (
                        <tr
                          key={`${row.leftCanonicalKey}:${row.rightCanonicalKey}:${row.reason}:${index}`}
                        >
                          <td>
                            <div>{row.leftName}</div>
                            <code>{row.leftCanonicalKey}</code>
                          </td>
                          <td>
                            <div>{row.rightName}</div>
                            <code>{row.rightCanonicalKey}</code>
                          </td>
                          <td>{row.reason}</td>
                        </tr>
                      ))}
                      {mergeCandidates.length === 0 ? (
                        <tr>
                          <td colSpan={3}>No unresolved merge candidates.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}

          {/* Debug Tab */}
          {activeTab === "debug" && (
            <section className="panel admin-section-stack">
              <h2>Debug Tools</h2>
              <p className="hint">
                Advanced debugging and monitoring tools will be available here.
              </p>
              <div className="admin-detail-grid">
                <div className="admin-detail-card">
                  <span>Active Errors</span>
                  <strong>{allErrors.filter((e) => e.status === "open").length}</strong>
                </div>
                <div className="admin-detail-card">
                  <span>Total Errors</span>
                  <strong>{allErrors.length}</strong>
                </div>
                <div className="admin-detail-card">
                  <span>Active Jobs</span>
                  <strong>{activeJobs.length}</strong>
                </div>
                <div className="admin-detail-card">
                  <span>Live Log Entries</span>
                  <strong>{logs.length}</strong>
                </div>
              </div>
            </section>
          )}
        </>
      ) : null}
    </main>
  );
}
