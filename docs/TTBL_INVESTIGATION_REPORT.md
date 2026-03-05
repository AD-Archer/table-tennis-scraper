# Complete Investigation: TTBL.de for Automated Bundesliga Pipeline

---

## 1. Site Infrastructure

- **Framework**: Next.js (SSR with client-side hydration)
- **CDN**: CloudFront (AWS)
- **Auth**: AWS Cognito (for admin panel)
- **Data fetching**: React Query (TanStack Query) with polling for live matches
- **CMS**: Ghost CMS for news content
- **Domain**: `www.ttbl.de` (note: `ttble.de` is unreachable/non-existent)

---

## 2. Discovered API Endpoints

### Public (no auth required)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/internal/match/{matchId}` | GET | Full match data with point-by-point scoring updates |
| `/_next/data/{buildId}/{route}.json` | GET | Pure JSON from any SSR page (bypasses HTML parsing) |

### Authenticated (401 without credentials)

| Endpoint | Status | Description |
|----------|--------|-------------|
| `/api/v1/*` | 401 | REST API v1 (admin CRUD) |
| `/api/v2/*` | 401 | REST API v2 |
| `/api/graphql` | 401 | GraphQL API |
| `/api/scoring/*` | 401 | Live scoring API (aliased from `/livetickerapi/*`) |
| `/api/dyn/*` | 200 but "invalid authentication" | Proxy to dyn.sport livestream service |
| `/api/auth/cognito-identity` | POST | AWS Cognito auth |
| `/api/auth/logout` | GET | Session logout |

---

## 3. Next.js Data Routes (Best for Scraping)

The `buildId` changes on each deployment (currently `1OAu_9Rd-54dDfS_w3OPv`). These return pure JSON, no HTML parsing needed:

| Route | Data Available |
|-------|---------------|
| `/de/bundesliga/gameschedule/{season}/{gameday}/all.json` | All matches for a gameday with teams, scores, timestamps |
| `/de/bundesliga/gameday/{season}/{gameday}/{matchId}.json` | Full match detail with `selectedMatch` (games, scoring updates, players, stats) |
| `/de/bundesliga/table/{season}/{gameday}.json` | Team standings with full stats |
| `/de/bundesliga/ranking/{teamId}/{type}/{season}/{gameday}.json` | Player rankings with 76+ players, all stats |
| `/de/bundesliga/teams/{season}.json` | All 12 teams with rosters, standings, contact info |
| `/de/bundesliga/players.json` | Full player directory |
| `/de/bundesliga/players/{playerId}.json` | Individual player profile |
| `/de/bundesliga/spectators/{season}.json` | Attendance data |
| `/de/bundesliga/transferlist.json` | Transfer listing (Ghost CMS content) |
| `/de/bundesliga/finals.json` | Finals information |
| `/de/pokal/gameschedule/{season}/{gameday}/all.json` | Pokal (cup) matches |
| `/de/pokal/gameday/{season}/{gameday}/{matchId}.json` | Pokal match detail |

---

## 4. Data Model (from match detail)

### Match (`selectedMatch`)

- `id`, `matchState`, `timeStamp`, `spectators`, `livestreamUrl`, `ticketshopUrl`
- `updateCount` (useful for change detection!)
- `homeTeam`/`awayTeam`: `id`, `seasonTeamId`, `name`, `rank`, `plusPoints`, `gameWins`, `setWins`
- `homeGames`, `awayGames`, `homeSets`, `awaySets`, `homeBalls`, `awayBalls`
- 6 player slots per side (3 starting + 3 substitutes)
- `venue`: `name`, `address`, `zipCode`, `place`, `imageUrl`
- `games[]`: Array of individual games

### Game (within match)

- `id`, `index`, `gameState`, `winnerSide`
- `homeSets`, `awaySets`, set-by-set scores (1-5)
- `homePlayer`/`awayPlayer`: `id`, `firstName`, `lastName`, `imageUrl`
- `homeTimeoutUsed`, `awayTimeoutUsed`, `cards[]`
- **Advanced stats**: `homePointsOnServe`, `awayPointsOnServe`, `homePointsOnReturn`, `awayPointsOnReturn`, `homePointsInARow`, `awayPointsInARow`, `homeLuckyPoints`, `awayLuckyPoints`, `homeHighestLead`, `awayHighestLead`, `homeMatchPoints`, `awayMatchPoints`
- **`scoringUpdates[]`**: Point-by-point data (86+ per game)

### Scoring Update (within game)

- `id`, `matchId`, `gameId`, `type` (`Create`, `Point`, `EventSetStart`, `EventGameEnd`)
- `ts` (millisecond timestamp), `playerId`, `set`, `result`
- `bwRating` (player performance rating per point)
- `isAcePoint`, `isServerErrorPoint`, `isLuckyShot`, `isNetRoller`, `isEdgeBall`

---

## 5. Live Data Mechanism

- **No WebSocket/SSE for public consumers** — the `EventSource`/`WebSocket` references in JS bundles are from framework polyfills
- **React Query polling**: The video widget (`useGetVideoWidget`) polls every **5 seconds** when `matchState === "Active"`
- **`/api/scoring/*`** exists but requires authentication (admin-only live ticker API)
- **`updateCount`** field on matches can be used as a lightweight change-detection watermark

---

## 6. Comparison: Current TTBL Scraper vs Optimal Approach

| Aspect | Current Scraper | Optimal Pipeline |
|--------|----------------|-----------------|
| Discovery | HTML scraping of gameschedule pages | Next.js data routes (pure JSON) |
| Match data | `/api/internal/match/{id}` | Same, but also `/_next/data` routes for richer context |
| Player profiles | HTML parsing for `__NEXT_DATA__` | `/_next/data/{buildId}/de/bundesliga/players/{id}.json` |
| Season detection | Trial-and-error HTTP requests | Data route for `/bundesliga/table` returns seasons list |
| Standings | Not scraped | `/bundesliga/table/{season}/{gameday}.json` |
| Rankings | Not scraped | `/bundesliga/ranking/all/single/{season}/{gameday}.json` |
| Spectator data | Not scraped | `/bundesliga/spectators/{season}.json` |
| Pokal (cup) | Not scraped | Same routes under `/pokal/` prefix |
| Point-by-point | `scoringUpdates` in match API | Already available, not yet persisted |
| Advanced game stats | Available in API but not captured | `pointsOnServe`, `luckyPoints`, `highestLead`, etc. |
| Change detection | Full re-scrape | Poll `updateCount` on match, only re-fetch when changed |
| BuildId dependency | None (HTML parsing) | Needs buildId refresh on deployments |

---

## 7. Current State: What You Already Have

Your existing TTBL scraper (`src/lib/scrapers/ttbl.ts`) does:

- HTML scraping of gameschedule pages to discover match UUIDs
- `/api/internal/match/{id}` for match JSON (games, set scores, players)
- `__NEXT_DATA__` parsing from player profile HTML pages
- Season auto-discovery, youth/doubles filtering, player stats aggregation
- Full Prisma persistence (6 TTBL tables)

---

## 8. What's New: Untapped Data Sources

### 8.1 Next.js Data Routes (Pure JSON, No HTML Parsing)

The site's `buildId` (currently `1OAu_9Rd-54dDfS_w3OPv`) unlocks direct JSON endpoints at `/_next/data/{buildId}/de/...json`:

| Route | Data | Currently Scraped? |
|-------|------|--------------------|
| `bundesliga/gameschedule/{season}/{gd}/all` | Matches with teams, scores | **Partially** (via HTML) |
| `bundesliga/gameday/{season}/{gd}/{matchId}` | Full match + `scoringUpdates` + `comparisonMatches` | **No** (uses `/api/internal`) |
| `bundesliga/table/{season}/{gameday}` | Team standings (W/L, game diff, points) | **No** |
| `bundesliga/ranking/all/single/{season}/{gd}` | 76 players with full stats | **No** |
| `bundesliga/teams/{season}` | 12 teams with rosters | **No** |
| `bundesliga/players` | Full player directory | **No** |
| `bundesliga/spectators/{season}` | Attendance data | **No** |
| `pokal/gameschedule/{season}/{gd}/all` | Cup matches | **No** |
| `pokal/gameday/{season}/{gd}/{matchId}` | Cup match detail | **No** |

These routes eliminate all HTML parsing and regex extraction.

### 8.2 Point-by-Point Scoring Data

Each match contains `scoringUpdates[]` arrays (86+ entries per game) with:

- `ts` — millisecond timestamp per point
- `playerId` — who scored
- `result` — running score (e.g., "4:3")
- `bwRating` — per-point performance rating
- `isAcePoint`, `isServerErrorPoint`, `isLuckyShot`, `isNetRoller`, `isEdgeBall`
- `type` — `Create`, `Point`, `EventSetStart`, `EventGameEnd`

**This is not currently captured by your scraper.**

### 8.3 Advanced Game Statistics

Each game object includes stats not currently persisted:

- `homePointsOnServe` / `awayPointsOnServe`
- `homePointsOnReturn` / `awayPointsOnReturn`
- `homePointsInARow` / `awayPointsInARow`
- `homeLuckyPoints` / `awayLuckyPoints`
- `homeHighestLead` / `awayHighestLead`
- `homeMatchPoints` / `awayMatchPoints`
- `homeTimeoutUsed` / `awayTimeoutUsed`

### 8.4 Change Detection via `updateCount`

The `selectedMatch` object has an `updateCount` field. This is a lightweight watermark — you can poll match listings, compare `updateCount`, and only re-fetch matches that changed. This aligns directly with your `UPDATE_DETECTION_POLLING_DESIGN.md` section 3.4.

### 8.5 Authenticated APIs (Not Publicly Accessible)

| Endpoint | Status | Notes |
|----------|--------|-------|
| `/api/v1/*`, `/api/v2/*` | 401 | REST APIs (admin CRUD) |
| `/api/graphql` | 401 | GraphQL API |
| `/api/scoring/*` | 401 | Live ticker (aliased from `/livetickerapi/*`) |
| `/api/dyn/*` | Auth required | Proxy to dyn.sport livestream |
| `/api/auth/cognito-identity` | POST | AWS Cognito auth flow |

These would provide richer access but require credentials.

---

## 9. Technical Notes on the Optimal Pipeline Approach

| Consideration | Detail |
|---------------|--------|
| Data format | `/_next/data` routes return structured JSON, removing the need for HTML parsing or `__NEXT_DATA__` regex extraction |
| `buildId` dependency | The `buildId` is deployment-scoped and will change on each site redeployment; it can be resolved programmatically from the homepage and cached until a `404` is returned on a data route |
| `buildId`-independent endpoint | `/api/internal/match/{id}` does not require a `buildId` and remains stable across deployments, making it suitable as a primary or fallback source for match detail |
| Change detection | The `updateCount` field on match objects provides a lightweight watermark to determine whether a match has been updated since the last fetch, avoiding unnecessary re-requests |
| Available but uncaptured data | Point-by-point scoring (`scoringUpdates[]`), advanced game stats, spectator data, Pokal matches, and transfer list data are all present in existing endpoints but not currently persisted |
| Pipeline compatibility | The polling-based model described in `UPDATE_DETECTION_POLLING_DESIGN.md` applies directly to the TTBL data structure without requiring a separate architectural pattern |

---

## 10. Recommended Pipeline Architecture

Modeled after your existing WTT pipeline (`wtt-detector.ts` + `wtt-cms.ts` + `wtt-ingestion.ts`):

```
ttbl-pipeline/
├── ttbl-resolver.ts      # Resolve current buildId from homepage
├── ttbl-discovery.ts     # Season/gameday/match discovery via data routes
├── ttbl-ingestion.ts     # Match detail → DB persistence (enhanced)
├── ttbl-detector.ts      # Polling orchestrator (idle/active/cooldown)
└── ttbl-state.ts         # Pipeline state persistence
```

### Key design decisions

1. **BuildId resolver**: Fetch homepage, extract `"buildId":"..."` — cache until a data route returns 404 (indicates redeployment), then re-resolve. Fallback: `/api/internal/match/{id}` works without buildId.

2. **Discovery via data routes**: Replace HTML gameday scanning with `/_next/data/{bid}/de/bundesliga/gameschedule/{season}/{gd}/all.json` — returns structured match list as JSON.

3. **Match ingestion**: Keep `/api/internal/match/{id}` as primary (no buildId dependency), but augment with data route for `comparisonMatches`, `matchNews`, and season context.

4. **Change detection**: Track `updateCount` per match. On each poll cycle, fetch gameday listing, compare `updateCount` values, only re-fetch changed matches.

5. **Polling cadence** (from your design doc):
   - Discovery: 60s
   - Active match refresh: 5s
   - Idle match sanity check: 120s
   - Full standings/rankings refresh: 30min

6. **New data to capture**: standings, player rankings, spectator data, Pokal matches, point-by-point scoring updates, advanced game statistics.

---

## 11. Recommended Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    TTBL Pipeline                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. BuildId Resolver                                    │
│     - Fetch ttbl.de homepage, extract buildId           │
│     - Cache until 404 on data routes                    │
│                                                         │
│  2. Season/Gameday Discovery                            │
│     - GET /_next/data/{bid}/de/bundesliga/table.json    │
│     - Returns all seasons + current gameday             │
│                                                         │
│  3. Match Discovery (per season/gameday)                │
│     - GET /_next/data/{bid}/de/bundesliga/              │
│       gameschedule/{season}/{gameday}/all.json           │
│     - Returns all matches with IDs + states             │
│                                                         │
│  4. Match Detail Ingestion                              │
│     - Primary: /api/internal/match/{id}                 │
│       (no buildId dependency, always works)             │
│     - Fallback: /_next/data route                       │
│     - Captures: games, scoringUpdates, stats            │
│                                                         │
│  5. Standings + Rankings (periodic)                     │
│     - Table: /bundesliga/table/{season}/{gameday}.json  │
│     - Rankings: /bundesliga/ranking/all/single/...json  │
│                                                         │
│  6. Change Detection                                    │
│     - Track updateCount per match                       │
│     - Only re-fetch when updateCount changes            │
│     - Active matches: poll every 5-10s                  │
│     - Idle: poll every 30-60min                         │
│                                                         │
│  7. Pokal Integration (same patterns, /pokal/ prefix)   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 12. Concrete Next Steps

1. **Add buildId resolver** — small utility to extract and cache buildId
2. **Replace HTML gameschedule parsing** with Next.js data routes for match discovery
3. **Extend `TtblGame` schema** with advanced stats columns (`pointsOnServe`, `luckyPoints`, etc.)
4. **Add `TtblScoringUpdate` model** for point-by-point data
5. **Add `TtblStanding` / `TtblRanking` models** for team/player standings per gameday
6. **Add Pokal support** — same route patterns under `/pokal/` prefix
7. **Build `ttbl-detector.ts`** following the WTT pipeline pattern — singleton polling loop with idle/active/cooldown modes
8. **Wire into `instrumentation.ts`** alongside the WTT pipeline

---

## 13. Rate Limiting Notes

- No explicit rate limiting headers observed
- CloudFront CDN fronts all requests
- The existing scraper uses 300ms delay between requests
- Recommend: 200-500ms delay for bulk scraping, 5s polling for live matches
- The authenticated APIs (`/api/v1`, `/api/v2`, `/api/graphql`) are inaccessible without Cognito credentials