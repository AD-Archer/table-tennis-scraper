const TTBL_BASE_URL = "https://www.ttbl.de";
const REQUEST_TIMEOUT_MS = 15_000;
const BUILD_ID_REGEX = /"buildId"\s*:\s*"([^"]+)"/;

const TTBL_HEADERS: Record<string, string> = {
  "User-Agent": "TTBL-NextJS-Scraper/1.0",
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedBuildId: string | null = null;
let resolvedAt: number = 0;

// Re-resolve if the cached value is older than 30 minutes,
// or immediately on 404 via `invalidateBuildId()`.
const MAX_AGE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal fetch helper (mirrors wtt-cms.ts pattern)
// ---------------------------------------------------------------------------

async function ttblFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: TTBL_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// BuildId resolution
// ---------------------------------------------------------------------------

async function fetchBuildIdFromHomepage(): Promise<string | null> {
  try {
    const response = await ttblFetch(TTBL_BASE_URL);
    if (!response.ok) return null;

    const html = await response.text();
    const match = BUILD_ID_REGEX.exec(html);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Returns the current TTBL Next.js buildId.
 *
 * Resolution strategy:
 *  1. Return the in-memory cached value if still fresh.
 *  2. Fetch the ttbl.de homepage and extract `"buildId":"..."` from the HTML.
 *  3. Cache the result in memory for up to MAX_AGE_MS.
 *
 * Returns `null` only if the homepage is unreachable or the buildId cannot
 * be extracted (site structure changed).
 */
export async function resolveBuildId(): Promise<string | null> {
  if (cachedBuildId && Date.now() - resolvedAt < MAX_AGE_MS) {
    return cachedBuildId;
  }

  const buildId = await fetchBuildIdFromHomepage();
  if (buildId) {
    cachedBuildId = buildId;
    resolvedAt = Date.now();
  }
  return buildId;
}

/**
 * Invalidate the cached buildId. Call this when a `/_next/data/` route
 * returns 404 — it means the site was redeployed and the buildId changed.
 */
export function invalidateBuildId(): void {
  cachedBuildId = null;
  resolvedAt = 0;
}

/**
 * Returns the cached buildId without making any HTTP requests.
 * Useful for logging/diagnostics.
 */
export function getCachedBuildId(): string | null {
  return cachedBuildId;
}

// ---------------------------------------------------------------------------
// Data route helpers
// ---------------------------------------------------------------------------

/**
 * Construct a full `/_next/data/{buildId}/de/...json` URL.
 *
 * @param buildId - The resolved buildId
 * @param route   - The route path without leading slash, e.g.
 *                  "bundesliga/gameschedule/2025-2026/18/all"
 */
export function dataRouteUrl(buildId: string, route: string): string {
  return `${TTBL_BASE_URL}/_next/data/${buildId}/de/${route}.json`;
}

/**
 * Fetch a Next.js data route, returning the parsed `pageProps` object.
 *
 * Handles buildId invalidation automatically: if the route returns 404,
 * the cached buildId is invalidated, a fresh one is resolved, and the
 * request is retried once.
 *
 * Returns `null` on failure (network error, non-JSON, redirect response,
 * or if both attempts fail).
 */
export async function fetchDataRoute<T = Record<string, unknown>>(
  route: string,
): Promise<T | null> {
  let buildId = await resolveBuildId();
  if (!buildId) return null;

  const result = await attemptDataRoute<T>(buildId, route);
  if (result !== undefined) return result;

  // 404 — buildId likely stale. Re-resolve once and retry.
  invalidateBuildId();
  buildId = await resolveBuildId();
  if (!buildId) return null;

  const retry = await attemptDataRoute<T>(buildId, route);
  return retry !== undefined ? retry : null;
}

/**
 * Internal: attempt a single data route fetch.
 * Returns `undefined` specifically on 404 (to distinguish from data-level null).
 */
async function attemptDataRoute<T>(
  buildId: string,
  route: string,
): Promise<T | null | undefined> {
  try {
    const url = dataRouteUrl(buildId, route);
    const response = await ttblFetch(url);

    if (response.status === 404) return undefined;
    if (!response.ok) return null;

    const json = (await response.json()) as { pageProps?: T & { __N_REDIRECT?: string } };
    const props = json.pageProps;

    // Next.js soft redirects indicate an invalid route (e.g. wrong season format)
    if (!props || props.__N_REDIRECT) return null;

    return props as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Match API (buildId-independent fallback)
// ---------------------------------------------------------------------------

/**
 * Fetch match detail from the buildId-independent internal API.
 * This endpoint remains stable across deployments.
 */
export async function fetchMatchInternal<T = Record<string, unknown>>(
  matchId: string,
): Promise<T | null> {
  try {
    const response = await ttblFetch(
      `${TTBL_BASE_URL}/api/internal/match/${matchId}`,
    );
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
