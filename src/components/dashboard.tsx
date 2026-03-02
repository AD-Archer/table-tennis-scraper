"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DashboardOverview, EndpointRow } from "@/lib/dashboard-types";

interface DashboardProps {
  initialOverview: DashboardOverview;
}

const ENDPOINT_CATEGORY_ORDER = [
  "MCP routes (AI + debugging)",
  "Internal API routes (lambda triggers)",
  "Spindex routes (compare + push)",
  "Data and utility routes",
];

type ActionJobState = "queued" | "running" | "completed" | "failed";

interface ActionJobStatus {
  jobId: string;
  type?: string;
  state: ActionJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  logs: string[];
  result: unknown;
  error: string | null;
}

interface ApiEnvelope {
  ok: boolean;
  error?: string;
  overview?: DashboardOverview;
  status?: ActionJobStatus;
  jobId?: string;
  alreadyRunning?: boolean;
  logs?: string[];
}

interface CancelApiEnvelope {
  ok: boolean;
  error?: string;
  cancelledAt?: string;
  requested?: {
    jobId?: string | null;
    target?: string | null;
    includeQueued?: boolean;
    clearFollowups?: boolean;
    reason?: string;
  };
  single?: {
    found?: boolean;
    alreadyTerminal?: boolean;
    status?: {
      jobId: string;
      type: string;
      state: string;
    } | null;
  } | null;
  cancelled?: {
    cancelled?: Array<{ jobId: string; type: string; state: string }>;
    count?: number;
  } | null;
}

const ACTION_JOB_POLL_MS = 1200;
const OVERVIEW_POLL_MS = 10000;
const FRONTEND_MASTER_PASSWORD =
  process.env.NEXT_PUBLIC_MASTER_SYNC_PASSWORD?.trim() ?? "";

function fmtDate(value?: string | null): string {
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

function formatSyncDetails(details: Record<string, unknown> | null | undefined): string {
  if (!details || Object.keys(details).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(details)}`;
}

function isWaitingQueued(status: ActionJobStatus): boolean {
  if (status.state !== "queued") {
    return false;
  }

  const last = status.logs.at(-1) ?? "";
  return /queued:\s*waiting for active job/i.test(last);
}

function parseTTBLSeasonsCsv(value: string): string[] {
  const seasons = new Map<string, number>();

  for (const token of value.split(",")) {
    const raw = token.trim();
    if (!raw) {
      continue;
    }

    const yearOnly = raw.match(/^(\d{4})$/);
    if (yearOnly?.[1]) {
      const startYear = Number.parseInt(yearOnly[1], 10);
      if (Number.isFinite(startYear)) {
        seasons.set(`${startYear}-${startYear + 1}`, startYear);
      }
      continue;
    }

    const seasonRange = raw.match(/^(\d{4})\s*[-/]\s*(\d{4})$/);
    if (seasonRange?.[1] && seasonRange[2]) {
      const startYear = Number.parseInt(seasonRange[1], 10);
      const endYear = Number.parseInt(seasonRange[2], 10);
      if (Number.isFinite(startYear) && Number.isFinite(endYear) && endYear === startYear + 1) {
        seasons.set(`${startYear}-${endYear}`, startYear);
      }
    }
  }

  return [...seasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([season]) => season);
}

function buildDefaultTTBLYears(initialOverview: DashboardOverview): string {
  const yearSet = new Set<number>();

  for (const season of initialOverview.ttbl.legacy?.seasons ?? []) {
    const start = Number.parseInt(season.split("-")[0] ?? "", 10);
    if (Number.isFinite(start)) {
      yearSet.add(start);
    }
  }

  const currentSeason = initialOverview.ttbl.metadata?.season;
  if (currentSeason) {
    const start = Number.parseInt(currentSeason.split("-")[0] ?? "", 10);
    if (Number.isFinite(start)) {
      yearSet.add(start);
    }
  }

  if (yearSet.size === 0) {
    return "2024,2023";
  }

  return [...yearSet].sort((a, b) => b - a).join(",");
}

export function Dashboard({ initialOverview }: DashboardProps) {
  const [overview, setOverview] = useState(initialOverview);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [activity, setActivity] = useState<string>("Ready.");

  const [ttblYears, setTtblYears] = useState(buildDefaultTTBLYears(initialOverview));
  const [wttYears, setWttYears] = useState(
    initialOverview.wtt.years.length > 0
      ? initialOverview.wtt.years.join(",")
      : `${new Date().getUTCFullYear()},${new Date().getUTCFullYear() - 1}`,
  );
  const [masterPassword, setMasterPassword] = useState("");

  const [showActionLog, setShowActionLog] = useState(false);
  const [actionLogTitle, setActionLogTitle] = useState("No action has been run yet.");
  const [actionLogs, setActionLogs] = useState<string[]>([]);
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [showCanonicalKeys, setShowCanonicalKeys] = useState(false);

  const actionPollTimerRef = useRef<number | null>(null);
  const appendUiLog = useCallback((message: string): void => {
    setActionLogs((prev) => [...prev, `[${new Date().toISOString()}] [UI] ${message}`]);
  }, []);

  const mergeCandidates = useMemo(
    () => {
      const seen = new Set<string>();
      const out: NonNullable<DashboardOverview["players"]>["mergeCandidates"] = [];

      for (const row of overview.players?.mergeCandidates ?? []) {
        const left = row.leftCanonicalKey.trim();
        const right = row.rightCanonicalKey.trim();
        const reason = row.reason.trim().toLowerCase().replace(/\s+/g, " ");
        if (!left || !right || !reason) {
          continue;
        }

        const pair = [left, right].sort((a, b) => a.localeCompare(b));
        const signature = `${pair[0]}::${pair[1]}::${reason}`;
        if (seen.has(signature)) {
          continue;
        }
        seen.add(signature);
        out.push(row);
        if (out.length >= 16) {
          break;
        }
      }

      return out;
    },
    [overview.players?.mergeCandidates],
  );
  const syncLogLines = useMemo(
    () =>
      (overview.sync.activity ?? []).map((entry) =>
        `[${entry.timestamp}] [${entry.source.toUpperCase()}] [${entry.level.toUpperCase()}] ${entry.message}${formatSyncDetails(
          entry.details,
        )}`,
      ),
    [overview.sync.activity],
  );
  const ttblSeasons = useMemo(() => {
    const rows = new Set<string>(overview.ttbl.legacy?.seasons ?? []);
    if (overview.ttbl.metadata?.season) {
      rows.add(overview.ttbl.metadata.season);
    }

    return [...rows].sort((a, b) => {
      const aStart = Number.parseInt(a.split("-")[0] ?? "0", 10);
      const bStart = Number.parseInt(b.split("-")[0] ?? "0", 10);
      return bStart - aStart;
    });
  }, [overview.ttbl.legacy?.seasons, overview.ttbl.metadata?.season]);
  const ttblSeasonSummary = useMemo(() => {
    if (ttblSeasons.length === 0) {
      return "no seasons scraped yet";
    }
    if (ttblSeasons.length === 1) {
      return `season ${ttblSeasons[0]}`;
    }
    return `${ttblSeasons[0]} to ${ttblSeasons[ttblSeasons.length - 1]} (${ttblSeasons.length} seasons)`;
  }, [ttblSeasons]);
  const ttblLegacyTotalMatches = useMemo(
    () =>
      (overview.ttbl.legacy?.results ?? []).reduce(
        (sum, row) => sum + (Number.isFinite(row.totalMatches) ? row.totalMatches : 0),
        0,
      ),
    [overview.ttbl.legacy?.results],
  );
  const wttYearsSummary = useMemo(() => {
    if (overview.wtt.years.length === 0) {
      return "no years scraped yet";
    }

    const sorted = [...overview.wtt.years].sort((a, b) => b - a);
    if (sorted.length <= 5) {
      return sorted.join(", ");
    }
    return `${sorted[0]} to ${sorted[sorted.length - 1]} (${sorted.length} years)`;
  }, [overview.wtt.years]);
  const endpointGroups = useMemo(() => {
    const byCategory = new Map<string, EndpointRow[]>();

    for (const endpoint of overview.endpoints) {
      const current = byCategory.get(endpoint.category) ?? [];
      current.push(endpoint);
      byCategory.set(endpoint.category, current);
    }

    const prioritized = ENDPOINT_CATEGORY_ORDER.filter((category) => byCategory.has(category));
    const extras = [...byCategory.keys()]
      .filter((category) => !ENDPOINT_CATEGORY_ORDER.includes(category))
      .sort((a, b) => a.localeCompare(b));

    return [...prioritized, ...extras].map((category) => ({
      category,
      endpoints: [...(byCategory.get(category) ?? [])].sort(
        (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      ),
    }));
  }, [overview.endpoints]);

  const clearActionPollTimer = useCallback((): void => {
    if (actionPollTimerRef.current !== null) {
      window.clearTimeout(actionPollTimerRef.current);
      actionPollTimerRef.current = null;
    }
  }, []);

  const refreshOverview = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/overview", {
      method: "GET",
      cache: "no-store",
    });

    const payload = (await response.json()) as ApiEnvelope;
    if (!response.ok || !payload.ok || !payload.overview) {
      throw new Error(payload.error ?? "Failed to load overview");
    }

    setOverview(payload.overview);
  }, []);

  useEffect(() => {
    return () => {
      clearActionPollTimer();
    };
  }, [clearActionPollTimer]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshOverview().catch(() => undefined);
    }, OVERVIEW_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [refreshOverview]);

  const pollActionJob = useCallback(
    async (endpoint: string, jobId: string, key: string): Promise<void> => {
      try {
        const sep = endpoint.includes("?") ? "&" : "?";
        const response = await fetch(`${endpoint}${sep}jobId=${encodeURIComponent(jobId)}`, {
          method: "GET",
          cache: "no-store",
        });

        const payload = (await response.json()) as ApiEnvelope;
        if (!response.ok || !payload.ok || !payload.status) {
          throw new Error(payload.error ?? `Failed polling ${key} (${response.status})`);
        }

        if ((payload.status.logs ?? []).length > 0) {
          setActionLogs(payload.status.logs ?? []);
        } else {
          appendUiLog(`${key} status polled (${payload.status.state}) with no worker logs yet.`);
        }
        setActionJobId(payload.status.jobId);

        if (payload.status.state === "queued") {
          const waiting = isWaitingQueued(payload.status);
          if (waiting) {
            setBusyKey((prev) => (prev === key ? null : prev));
            setActivity(`${key} scheduled. It will run after the active job finishes.`);
          } else {
            setActivity(`${key} queued.`);
          }
          actionPollTimerRef.current = window.setTimeout(() => {
            void pollActionJob(endpoint, jobId, key);
          }, ACTION_JOB_POLL_MS);
          return;
        }

        if (payload.status.state === "running") {
          setBusyKey((prev) => prev ?? key);
          setActivity(`${key} running...`);
          actionPollTimerRef.current = window.setTimeout(() => {
            void pollActionJob(endpoint, jobId, key);
          }, ACTION_JOB_POLL_MS);
          return;
        }

        clearActionPollTimer();
        setBusyKey(null);

        if (payload.status.state === "completed") {
          await refreshOverview();
          setActivity(`${key} finished successfully.`);
        } else {
          setActivity(`${key} failed: ${payload.status.error ?? "unknown error"}`);
        }
      } catch (error) {
        clearActionPollTimer();
        setBusyKey(null);
        setActionLogs((prev) =>
          prev.length > 0
            ? prev
            : [
                `[${new Date().toISOString()}] [UI] ${key} polling failed: ${
                  error instanceof Error ? error.message : "unknown error"
                }`,
              ],
        );
        setActivity(
          `${key} polling failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    },
    [appendUiLog, clearActionPollTimer, refreshOverview],
  );

  async function invoke(
    endpoint: string,
    body: Record<string, unknown>,
    key: string,
    statusEndpoint?: string,
  ) {
    setBusyKey(key);
    setActivity(`Running ${key}...`);
    setShowActionLog(true);
    setActionLogTitle(`${key} log`);
    setActionLogs([`[${new Date().toISOString()}] [UI] ${key} started.`]);
    clearActionPollTimer();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as ApiEnvelope;
      if (!response.ok || !payload.ok || !payload.status || !payload.jobId) {
        const message = payload.error ?? `Failed to start ${key} (${response.status})`;
        appendUiLog(`${key} failed to start: ${message}`);
        setBusyKey(null);
        setActivity(`${key} failed: ${message}`);
        return;
      }

      setActionJobId(payload.jobId);
      if ((payload.status.logs ?? []).length > 0) {
        setActionLogs(payload.status.logs ?? []);
      } else {
        appendUiLog(`${key} accepted as job ${payload.jobId} (${payload.status.state}).`);
      }

      if (payload.alreadyRunning) {
        const activeType = payload.status.type ?? "unknown";
        if (key === "Merge refresh" && activeType !== "players-registry") {
          appendUiLog(
            `Merge refresh did not start because active ${activeType} job ${payload.jobId} is running.`,
          );
          setBusyKey(null);
          setActivity(
            `Merge refresh waiting: active ${activeType} job ${payload.jobId} is running.`,
          );
          return;
        }
        setActivity(`Joined existing ${key} job ${payload.jobId}.`);
      } else {
        setActivity(`${key} job ${payload.jobId} started.`);
      }

      if (payload.status.state === "queued" && isWaitingQueued(payload.status)) {
        setBusyKey(null);
        setActivity(`${key} scheduled. It will run after the active job finishes.`);
      }

      if (payload.status.state === "completed" || payload.status.state === "failed") {
        setBusyKey(null);
        if (payload.status.state === "completed") {
          await refreshOverview();
          setActivity(`${key} finished successfully.`);
        } else {
          setActivity(`${key} failed: ${payload.status.error ?? "unknown error"}`);
        }
        return;
      }

      const pollEndpoint = statusEndpoint ?? endpoint;
      actionPollTimerRef.current = window.setTimeout(() => {
        void pollActionJob(pollEndpoint, payload.jobId as string, key);
      }, ACTION_JOB_POLL_MS);
    } catch (error) {
      clearActionPollTimer();
      setBusyKey(null);
      appendUiLog(`${key} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      setActivity(
        `${key} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async function onRunTTBL(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seasons = parseTTBLSeasonsCsv(ttblYears);
    if (seasons.length === 0) {
      setActivity(
        "TTBL scrape failed: use 2025 or 2025-2026 (comma separated).",
      );
      return;
    }

    await invoke(
      "/api/scrape/ttbl",
      {
        seasons,
        delayMs: 300,
      },
      "TTBL scrape",
    );
  }

  async function onRunWTT(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await invoke(
      "/api/scrape/wtt",
      {
        years: wttYears,
        pageSize: 50,
        maxPages: 80,
        maxEventsPerYear: 18,
        recentDays: 45,
        delayMs: 180,
        tournamentScope: "wtt_only",
        eventScope: "singles_only",
        includeYouth: false,
        profileEnrichMaxPlayers: 600,
        profileEnrichMinMatches: 2,
      },
      "WTT scrape",
    );
  }

  async function onRunTTBLAllTime() {
    const nowYear = new Date().getUTCFullYear();
    await invoke(
      "/api/scrape/ttbl/all",
      {
        startYear: 1995,
        endYear: nowYear + 1,
        delayMs: 120,
      },
      "TTBL full refresh",
    );
  }

  async function onDestroyData() {
    const enteredMasterPassword = masterPassword.trim();
    if (!enteredMasterPassword) {
      setActivity("Destroy data failed: enter master password.");
      return;
    }
    if (!FRONTEND_MASTER_PASSWORD) {
      setActivity(
        "Destroy data failed: NEXT_PUBLIC_MASTER_SYNC_PASSWORD is not configured.",
      );
      return;
    }
    if (enteredMasterPassword !== FRONTEND_MASTER_PASSWORD) {
      setActivity("Destroy data failed: invalid master password.");
      return;
    }
    await invoke("/api/data/destroy", {}, "Destroy data");
  }

  async function onRunMasterSync() {
    const enteredMasterPassword = masterPassword.trim();
    if (!enteredMasterPassword) {
      setActivity("Master sync failed: enter master password.");
      return;
    }
    if (!FRONTEND_MASTER_PASSWORD) {
      setActivity(
        "Master sync failed: NEXT_PUBLIC_MASTER_SYNC_PASSWORD is not configured.",
      );
      return;
    }
    if (enteredMasterPassword !== FRONTEND_MASTER_PASSWORD) {
      setActivity("Master sync failed: invalid master password.");
      return;
    }
    const nowYear = new Date().getUTCFullYear();
    await invoke(
      "/api/scrape/clean",
      {
        ttblStartYear: 1995,
        ttblEndYear: nowYear + 1,
        wttStartYear: 2017,
        wttEndYear: nowYear,
        wttPageSize: 500,
        wttMaxPages: 1200,
        delayMs: 100,
      },
      "Master sync",
    );
  }

  async function onRunWTTAllTime() {
    const nowYear = new Date().getUTCFullYear();
    await invoke(
      "/api/scrape/wtt/all",
      {
        startYear: 2017,
        endYear: nowYear,
        pageSize: 50,
        maxPages: 1400,
        delayMs: 120,
        tournamentScope: "all",
        eventScope: "singles_only",
        includeYouth: false,
        profileEnrichMaxPlayers: 0,
        profileEnrichMinMatches: 3,
      },
      "WTT full refresh",
    );
  }

  async function onRefreshMergeRegistryStrict() {
    await invoke(
      "/api/players/registry",
      {
        strict: true,
      },
      "Merge refresh",
      "/api/players/registry",
    );
  }

  async function onCancelActiveJob() {
    setCancelBusy(true);
    setShowActionLog(true);
    setActionLogTitle("Cancel log");
    appendUiLog("Cancel active job requested from dashboard header.");

    try {
      const params = new URLSearchParams({
        cancel: "1",
        includeQueued: "1",
        clearFollowups: "0",
        reason: "Cancelled from dashboard header button.",
      });
      const response = await fetch(`/api/mcp?${params.toString()}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as CancelApiEnvelope;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Cancel request failed (${response.status})`);
      }

      const cancelledCount = payload.cancelled?.count ?? 0;
      const singleState = payload.single?.status?.state ?? null;
      if (singleState) {
        appendUiLog(`Cancellation requested for job ${payload.single?.status?.jobId} (${singleState}).`);
      } else if (cancelledCount > 0) {
        appendUiLog(`Cancellation requested for ${cancelledCount} active job(s).`);
      } else {
        appendUiLog("No active jobs were running to cancel.");
      }

      clearActionPollTimer();
      setBusyKey(null);
      setActionJobId(null);
      await refreshOverview();
      setActivity(
        cancelledCount > 0 || singleState
          ? "Cancellation requested. Check Last Action Log for final status."
          : "No active jobs to cancel.",
      );
    } catch (error) {
      appendUiLog(
        `Cancel active job failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      setActivity(
        `Cancel active job failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <main className="dashboard-shell">
      <section className="hero-grid panel fade-in">
        <div>
          <p className="eyebrow">TTBL + ITTF/WTT</p>
          <h1 className="title">Scraper Control Deck + Job Control</h1>
          <p className="lede">
            This app only scrapes and combines source data.
          </p>
          <p className="hint deck-link-wrap">
            <Link className="ghost-link" href="/players">
              Open player view
            </Link>
          </p>
        </div>
        <div className="hero-meta">
          <p>
            Last refresh
            <strong>{fmtDate(overview.generatedAt)}</strong>
          </p>
          <p>
            Activity
            <strong>{activity}</strong>
          </p>
          <p>
            Active Job
            <strong>
              {actionJobId
                ? `${busyKey ?? "running"} (${actionJobId})`
                : "none tracked in this session"}
            </strong>
          </p>
          <p>
            TTBL Background
            <strong>
              {overview.sync.ttblFollowup.scheduled
                ? `scheduled ${fmtDate(overview.sync.ttblFollowup.scheduledFor)}`
                : "idle"}
            </strong>
          </p>
          <p>
            WTT Background
            <strong>
              {overview.sync.wttFollowup.scheduled
                ? `scheduled ${fmtDate(overview.sync.wttFollowup.scheduledFor)}`
                : "idle"}
            </strong>
          </p>
          <button
            className="btn btn-danger btn-hero"
            disabled={cancelBusy}
            onClick={onCancelActiveJob}
            type="button"
          >
            {cancelBusy ? "Cancelling..." : "Cancel active job"}
          </button>
        </div>
      </section>

      <section className="metrics-grid stagger">
        <article className="metric-card">
          <span>TTBL Players</span>
          <strong>
            {overview.players?.totals.ttblSourcePlayers ??
              overview.ttbl.metadata?.uniquePlayers ??
              0}
          </strong>
          <small>{ttblSeasonSummary}</small>
        </article>
        <article className="metric-card">
          <span>WTT Players</span>
          <strong>
            {overview.players?.totals.wttSourcePlayers ?? overview.wtt.totalPlayers}
          </strong>
          <small>{wttYearsSummary}</small>
        </article>
        <article className="metric-card">
          <span>TTBL Matches (Current)</span>
          <strong>{overview.ttbl.metadata?.totalMatches ?? 0}</strong>
          <small>
            {ttblLegacyTotalMatches > 0
              ? `all-time indexed: ${ttblLegacyTotalMatches}`
              : ttblSeasonSummary}
          </small>
        </article>
        <article className="metric-card">
          <span>WTT Matches</span>
          <strong>{overview.wtt.totalMatches}</strong>
          <small>{wttYearsSummary}</small>
        </article>
      </section>

      <section className="controls-grid">
        <form className="panel action-panel action-panel-sync" onSubmit={onRunTTBL}>
          <h2>Scrape TTBL</h2>
          <label>
            Seasons or Start Years (CSV)
            <input
              value={ttblYears}
              onChange={(e) => setTtblYears(e.target.value)}
              placeholder="2025,2024-2025,2023"
            />
          </label>
          <p className="hint">
            You can enter <code>2025</code> (auto-maps to <code>2025-2026</code>) or
            <code>2025-2026</code>. Max gamedays are auto-detected per season.
          </p>
          <p className="hint">
            Youth-tagged TTBL matches are filtered out by default.
          </p>
          <button className="btn btn-primary btn-block" disabled={busyKey !== null} type="submit">
            {busyKey === "TTBL scrape" ? "Running..." : "Scrape TTBL"}
          </button>
        </form>

        <form className="panel action-panel action-panel-sync" onSubmit={onRunWTT}>
          <h2>Scrape WTT</h2>
          <label>
            Years (CSV)
            <input value={wttYears} onChange={(e) => setWttYears(e.target.value)} />
          </label>
          <p className="hint">
            Uses TTU/WTT result feeds with default filters:
            WTT tournaments + singles-only + no youth. Writes
            <code>players.json</code>, <code>matches.json</code>, and <code>dataset.json</code>.
          </p>
          <p className="hint">
            Default scope is intentionally limited for speed: current year, last 45 days, and
            max 18 events per year.
          </p>
          <button className="btn btn-primary btn-block" disabled={busyKey !== null} type="submit">
            {busyKey === "WTT scrape" ? "Running..." : "Scrape WTT"}
          </button>
        </form>

        <div className="panel action-panel action-panel-refresh">
          <h2>TTBL Full Refresh</h2>
          <p className="hint">
            Discover all available TTBL seasons and rescrape them without touching WTT files.
          </p>
          <p className="hint">
            This is a weaker master sync: TTBL all-time + player registry rebuild only.
          </p>
          <button
            className="btn btn-secondary btn-block"
            disabled={busyKey !== null}
            onClick={onRunTTBLAllTime}
            type="button"
          >
            {busyKey === "TTBL full refresh" ? "Running..." : "TTBL full refresh (keep WTT)"}
          </button>
        </div>

        <div className="panel action-panel action-panel-refresh">
          <h2>WTT Full Refresh</h2>
          <p className="hint">
            Discover all available years and scrape WTT/ITTF data without touching TTBL files.
          </p>
          <p className="hint">
            This is a weaker master sync: WTT all-time + player registry rebuild only, limited to men&apos;s/women&apos;s singles and youth excluded by default.
          </p>
          <button
            className="btn btn-secondary btn-block"
            disabled={busyKey !== null}
            onClick={onRunWTTAllTime}
            type="button"
          >
            {busyKey === "WTT full refresh" ? "Running..." : "WTT full refresh (keep TTBL)"}
          </button>
        </div>

        <div className="panel action-panel action-panel-master">
          <h2>Master Sync</h2>
          <label>
            Master Password
            <input
              type="password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="Matches .env NEXT_PUBLIC_MASTER_SYNC_PASSWORD"
            />
          </label>
          <p className="hint">
            Discover all available TTBL seasons + WTT years, then run a full scrape into a
            fresh dataset.
          </p>
          <p className="hint">
            Uses full-history ranges and ignores the TTBL/WTT text-box values above.
          </p>
          <button
            className="btn btn-accent btn-block"
            disabled={busyKey !== null}
            onClick={onRunMasterSync}
            type="button"
          >
            {busyKey === "Master sync" ? "Running..." : "Master sync (all years)"}
          </button>
        </div>

        <div className="panel action-panel action-panel-danger">
          <h2>Data Controls</h2>
          <p className="hint">Hard reset all stored relational dataset rows.</p>
          <p className="hint">
            Uses the same master password field as Master Sync.
          </p>
          <button
            className="btn btn-danger btn-block"
            disabled={busyKey !== null}
            onClick={onDestroyData}
            type="button"
          >
            {busyKey === "Destroy data" ? "Destroying..." : "Destroy data"}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>Last Action Log</h2>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowActionLog((prev) => !prev)}
            type="button"
          >
            {showActionLog ? "Hide action log" : "Show action log"}
          </button>
        </div>
        <p className="hint">Live logs from TTBL, WTT, WTT full refresh, merge refresh, master sync, and destroy-data runs.</p>
        <p className="hint">
          <strong>{actionLogTitle}</strong>
        </p>
        <p className="hint">
          Job ID: <code>{actionJobId ?? "-"}</code>
        </p>
        {showActionLog ? (
          <div className="scrape-log-wrap">
            <pre className="scrape-log">
              {(actionLogs.length > 0 ? actionLogs : ["No action logs yet."]).join("\n")}
            </pre>
          </div>
        ) : null}

        <p className="hint" style={{ marginTop: "1rem" }}>
          <strong>Persistent background sync log (saved to Postgres)</strong>
        </p>
        <p className="hint">
          Includes scheduled time, run time, and what each background sync is checking.
        </p>
        <div className="scrape-log-wrap">
          <pre className="scrape-log">
            {(syncLogLines.length > 0
              ? syncLogLines
              : ["No background sync events recorded yet."]).join("\n")}
          </pre>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>Player Registry (What This Means)</h2>
          <button
            className="btn btn-secondary btn-sm"
            disabled={busyKey !== null}
            onClick={onRefreshMergeRegistryStrict}
            type="button"
          >
            {busyKey === "Merge refresh" ? "Running..." : "Refresh merge registry"}
          </button>
        </div>
        <p className="hint">
          After every TTBL/WTT scrape, the app rebuilds a canonical player registry.
          It groups source players under stable IDs so duplicates can be reviewed
          before downstream sync.
        </p>
        <p className="hint">
          <strong>Canonical players:</strong> {overview.players?.totals.canonicalPlayers ?? 0} |{" "}
          <strong>Merged:</strong> {overview.players?.totals.mergedPlayers ?? 0} |{" "}
          <strong>Merge candidates:</strong> {overview.players?.totals.candidates ?? 0}
        </p>
        <p className="hint">
          Merge candidates below are unresolved/ambiguous identity cases discovered during automatic linking.
        </p>
        <p className="hint">
          Trigger this from UI or from a background lambda by calling
          <code> POST /api/players/registry</code> with <code>{`{"strict": true}`}</code>.
          Strict mode fails the job when unresolved candidates remain.
        </p>
      </section>

      <section className="panel">
        <div className="section-head">
          <h2>Merge Candidates</h2>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowCanonicalKeys((prev) => !prev)}
            type="button"
          >
            {showCanonicalKeys ? "Hide canonical keys" : "Show canonical keys"}
          </button>
        </div>
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
              {mergeCandidates.map((candidate, index) => (
                <tr
                  key={`${candidate.leftCanonicalKey}:${candidate.rightCanonicalKey}:${candidate.reason}:${index}`}
                >
                  <td>
                    {candidate.leftName}
                    {showCanonicalKeys ? (
                      <>
                        <br />
                        <code>{candidate.leftCanonicalKey}</code>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {candidate.rightName}
                    {showCanonicalKeys ? (
                      <>
                        <br />
                        <code>{candidate.rightCanonicalKey}</code>
                      </>
                    ) : null}
                  </td>
                  <td>{candidate.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Endpoints</h2>
        <div className="endpoint-category-stack">
          {endpointGroups.map((group) => (
            <article key={group.category} className="endpoint-category">
              <h3>{group.category}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Path</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.endpoints.map((endpoint) => (
                      <tr key={`${group.category}:${endpoint.method}:${endpoint.path}`}>
                        <td>{endpoint.method}</td>
                        <td>
                          <code>{endpoint.path}</code>
                        </td>
                        <td>{endpoint.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      </section>

    </main>
  );
}
