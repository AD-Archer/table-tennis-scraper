# ttbl.de Reconnaissance Report

> **Target:** https://www.ttbl.de  
> **Method:** Next.js sourcemap enumeration via public `/_next/static/chunks/*.js.map`  
> **Date:** 2026-03-05

---

## Sourcemap Exposure

All JS chunks expose sourcemaps with **no access control** (HTTP 200, publicly cached via CloudFront).  
Sourcemaps contain **original TypeScript source code** — the full `src/` directory is recoverable.

| File | Size |
|------|------|
| `pages/_app-3a0dae27eabc118d.js.map` | 954 KB |
| `8902-8875cbeb2fc0641c.js.map` | 414 KB |
| `framework-b78bc773b89d3272.js.map` | 363 KB |
| `304-50e53b4925486ba5.js.map` | 262 KB |
| `main-f344cf70ee96ebc6.js.map` | 555 KB |
| `385-327a4246eec55931.js.map` | 159 KB |
| `6893-766606de074d3080.js.map` | 159 KB |
| `5577-24ea6f6269034915.js.map` | 145 KB |
| `3733-fdcd42a115e17544.js.map` | 121 KB |
| `1371-797cea61d930117b.js.map` | 127 KB |
| `2420-da4e781fe68ba686.js.map` | 128 KB |
| `338-c643b9c4ed551f89.js.map` | 115 KB |
| `5103-ee3a111eae17ca87.js.map` | 90 KB |
| `4833-097fab5be860b188.js.map` | 38 KB |
| `1664-ad3f43586524b26f.js.map` | 41 KB |
| `5675-03a9b3eb36fdcf58.js.map` | 55 KB |

---

## Tech Stack

Recovered from sourcemap `sources` and `sourcesContent`:

- **Framework:** Next.js (Pages Router) + TypeScript
- **ORM:** Prisma (PostgreSQL)
- **Data fetching:** React Query (`react-query`)
- **UI primitives:** Radix UI (Dialog, DropdownMenu, Select)
- **Styling:** Tailwind CSS
- **Error tracking:** Bugsnag (`src/bugsnag.js`)
- **CMS (news):** Ghost (`@tryghost/content-api`)
- **Streaming partner:** DYN Sport (hardcoded affiliate link in `src/helper/urlHelper.ts`)
- **Analytics:** Google Tag Manager (`G-WT0170VGM7`)

---

## URL Rewrites

Discovered in `_buildManifest.js` (`__rewrites.afterFiles`):

```
/:locale(de|en)/uploads/:path*         →  passthrough (unmodified)
/:locale(de|en)/livetickerapi/:path*   →  /:locale/api/scoring/:path*
```

The `/livetickerapi/` path is a **public alias** for the internal scoring API.

---

## Page Routes

Build ID: `1OAu_9Rd-54dDfS_w3OPv`  
Full route list from `/_next/static/1OAu_9Rd-54dDfS_w3OPv/_buildManifest.js`.

### Public Frontend

```
/
/imprint
/privacy
/newsletter
/tickets
/tippspiele
/move-your-sport

/news/post/[newsId]
/news/[tag]/[page]

/about
/about/downloads
/about/jobs
/about/partners
/about/press
/about/rules
/about/structure
/about/team
/about/ttblsportgmbh

/bundesliga/finals
/bundesliga/transferlist
/bundesliga/playerranking
/bundesliga/spectators
/bundesliga/spectators/[season]
/bundesliga/players
/bundesliga/players/[player]
/bundesliga/teams
/bundesliga/teams/[season]
/bundesliga/teams/[season]/[team]
/bundesliga/teams/[season]/[team]/widget
/bundesliga/table
/bundesliga/table/widget
/bundesliga/table/[season]
/bundesliga/table/[season]/widget
/bundesliga/table/[season]/[gameday]
/bundesliga/table/[season]/[gameday]/widget
/bundesliga/ranking/[teamId]/[type]
/bundesliga/ranking/[teamId]/[type]/[season]
/bundesliga/ranking/[teamId]/[type]/[season]/[gameday]
/bundesliga/gameschedule/[season]/[gameday]/[team]
/bundesliga/gameschedule/[season]/[gameday]/[team]/widget
/bundesliga/gameday/[season]/[gameday]/[match]
/bundesliga/gameday/[season]/[gameday]/[match]/details
/bundesliga/gameday/[season]/[gameday]/[match]/videowidget

/pokal/finals
/pokal/gameschedule/[season]/[gameday]/[team]
/pokal/gameschedule/[season]/[gameday]/[team]/widget
/pokal/gameday/[season]/[gameday]/[match]
/pokal/gameday/[season]/[gameday]/[match]/details
/pokal/gameday/[season]/[gameday]/[match]/videowidget
```

### Admin (Auth-Protected)

```
/adminlogin
/admin
/admin/[seasonId]

/admin/[seasonId]/bundesliga/calculateBundesliga
/admin/[seasonId]/bundesliga/gameschedule
/admin/[seasonId]/bundesliga/gameschedule/add
/admin/[seasonId]/bundesliga/gameschedule/edit/[id]
/admin/[seasonId]/bundesliga/gameschedule/debug/[id]
/admin/[seasonId]/bundesliga/playerranking
/admin/[seasonId]/bundesliga/table
/admin/[seasonId]/bundesliga/teams

/admin/[seasonId]/pokal/gameschedule
/admin/[seasonId]/pokal/gameschedule/add
/admin/[seasonId]/pokal/gameschedule/edit/[id]
/admin/[seasonId]/pokal/gameschedule/debug/[id]
/admin/[seasonId]/pokal/teams

/admin/[seasonId]/players
/admin/[seasonId]/players/add
/admin/[seasonId]/players/edit/[id]

/admin/[seasonId]/teams
/admin/[seasonId]/teams/add
/admin/[seasonId]/teams/edit/[id]

/admin/[seasonId]/venues
/admin/[seasonId]/venues/add
/admin/[seasonId]/venues/edit/[id]

/admin/[seasonId]/settings/currentSeason
/admin/[seasonId]/settings/outfitter
/admin/[seasonId]/settings/outfitter/add
/admin/[seasonId]/settings/outfitter/edit/[id]
/admin/[seasonId]/settings/season
/admin/[seasonId]/settings/season/add
/admin/[seasonId]/settings/season/duplicate/[id]
/admin/[seasonId]/settings/season/edit/[id]
/admin/[seasonId]/settings/user
/admin/[seasonId]/settings/user/add
/admin/[seasonId]/settings/user/edit/[id]
```

---

## API Routes

All routes are Next.js API routes under `/api/`.  
Base URL pattern: `basePath + "/api" + path` (from `src/hooks/common/useBackendUrl.ts`).

Auth appears to be **cookie-based** — the admin SPA calls `/api/auth/logout` then redirects to `/adminlogin`.

### Authentication

| Method | Path |
|--------|------|
| GET | `/api/auth/logout` |

### Seasons

| Method | Path |
|--------|------|
| GET | `/api/seasons` |
| POST | `/api/seasons` |
| PATCH | `/api/seasons` |
| GET | `/api/seasons/current` |
| PATCH | `/api/seasons/current` |
| POST | `/api/seasons/duplicate` |
| GET | `/api/seasons/getByStartYear/:startYear` |
| GET | `/api/seasons/:id` |
| DELETE | `/api/seasons/:seasonId` |
| GET | `/api/seasons/:seasonId/players` |
| GET | `/api/seasons/:seasonId/teams` |

### Matches

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/matches` | |
| GET | `/api/matches/:id` | |
| GET | `/api/internal/match/:id` | Live match detail — frontend polls every **15s** when `matchState === "Active"` |
| GET | `/api/gameday/:id/matches` | |
| GET | `/api/season/:seasonId/bundesliga/matches` | |
| GET | `/api/season/:seasonId/pokal/matches` | |
| GET | `/api/videoWidget/:matchId` | Likely proxies DYN Sport video embed |

### Teams

| Method | Path |
|--------|------|
| GET | `/api/teams` |
| POST | `/api/teams` |
| PATCH | `/api/teams` |
| GET | `/api/teams/:id` |
| DELETE | `/api/teams/:teamId` |
| GET | `/api/teams/:teamId/players` |

### Players

| Method | Path |
|--------|------|
| GET | `/api/players` |
| POST | `/api/players` |
| PATCH | `/api/players` |
| GET | `/api/players/:id` |
| DELETE | `/api/players/:playerId` |
| GET | `/api/players/:playerId/team` |

### Venues

| Method | Path |
|--------|------|
| GET | `/api/venues` |
| POST | `/api/venues` |
| PATCH | `/api/venues` |
| GET | `/api/venues/:id` |
| DELETE | `/api/venues/:venueId` |

### Outfitters

| Method | Path |
|--------|------|
| GET | `/api/outfitters` |
| POST | `/api/outfitters` |
| PATCH | `/api/outfitters` |
| GET | `/api/outfitters/:id` |
| DELETE | `/api/outfitters/:outfitterId` |

### Scoring (via rewrite alias)

```
/livetickerapi/:path*   →   /api/scoring/:path*
```

The internal scoring system uses a `ScoringUpdates` table (Prisma model) with event types:  
`Point`, `EventSetStart`, and others. Set scores tracked as `"home:away"` result strings.

---

## Notable Source Files Recovered

```
src/pages/_app.tsx
src/pages/index.tsx
src/bugsnag.js
src/helper/api.ts
src/helper/urlHelper.ts
src/helper/util.ts
src/helper/time.ts
src/helper/color.ts
src/helper/match.ts
src/helper/matchStats.ts
src/helper/scoresHelper.ts
src/hooks/common/useBackendUrl.ts        ← API base path construction
src/hooks/common/useBackendQueryFunction.ts
src/hooks/common/useBackendMutationFunction.ts
src/hooks/common/useUrl.ts
src/hooks/season.ts
src/hooks/teams.ts
src/hooks/players.ts
src/hooks/venue.ts
src/hooks/outfitter.ts
src/hooks/match.ts
src/hooks/frontend/match.ts              ← live polling logic
src/components/common/Nav.tsx            (admin)
src/components/common/FrontendNav.tsx    (public)
src/components/CurrentMatches/CurrentMatchesList.tsx
src/components/Gameday/GamedayView.tsx
src/components/Gameday/GamedayMatchDetail.tsx
src/components/Gameschedule/GamescheduleMatchList.tsx
src/pages/admin/[seasonId]/players/index.tsx
src/pages/admin/[seasonId]/teams/index.tsx
src/pages/admin/[seasonId]/venues/index.tsx
```

---

## Key Observations

1. **Full source exposure** — sourcemaps serve original `.tsx`/`.ts` files verbatim, including business logic, Prisma model shapes, and internal scoring algorithms.
2. **Admin API surface is entirely client-enumerable** — all CRUD endpoints discoverable without any authentication.
3. **Live scoring endpoint** — `GET /api/internal/match/:id` is the real-time data feed, polled every 15 seconds by the public gameday page when a match is active.
4. **`/livetickerapi/`** is a documented public rewrite alias pointing to `/api/scoring/` — likely used by external integrators or the scoring tablet app.
5. **`/api/videoWidget/:matchId`** exists separately from the gameday page, suggesting an embeddable widget endpoint.
6. **Bugsnag** is initialized in `_app.tsx` — error reports from production users will include stack traces referencing original source paths.
