# TTBL + ITTF/WTT Next.js Control Deck

Next.js control deck and data pipeline for:
- TTBL Bundesliga match/game scraping, season discovery, and full-history refreshes
- ITTF/WTT singles scraping with TTU as the default backend and Fabrik as an optional fallback
- Postgres-backed player registry, merge-candidate audit tooling, and player detail pages
- Optional background follow-up jobs, polling pipelines, MCP tools, and Spindex sync routes

## Project Overview

- Dashboard at `/` for TTBL/WTT scrape jobs, full refreshes, master sync, destroy-data, job logs, sync activity, and endpoint discovery
- Player explorer at `/players` with filters for source, gender, country, season/year, match count, and merge-candidate state
- Player detail pages at `/players/[slug]` with source profiles plus cross-source match history
- Match detail pages at `/players/match?source=ttbl|wtt&matchId=...` with TTBL set scores or WTT game scores
- Scrapes persist operational data to Postgres and also write JSON artifacts under `data/` for inspection and pipeline state

## Setup

```bash
pnpm install
pnpm prisma:generate
pnpm prisma:migrate:dev --name init
pnpm dev
```

Open `http://localhost:3000`.

Start from `.env.example`.

Notes:

- `postinstall` already runs `prisma generate`.
- `DATABASE_URL` is required for the dashboard, scrape jobs, player registry, TTBL profile cache, sync activity log, and destroy/clean workflows.
- The repo currently includes `prisma/schema.prisma` but no committed `prisma/migrations/` directory. On a fresh database, create a local migration before starting the app.

## Environment

Required:

- `DATABASE_URL=postgresql://...`
- `NEXT_PUBLIC_MASTER_SYNC_PASSWORD=...` used by the dashboard UI to gate `Master sync` and `Destroy data`. This is a frontend check, not API auth.

Optional:

- `SPINDEX_API_BASE_URL=...` upstream base URL for Spindex compare/push routes
- `SPINDEX_API_TOKEN=...` auth token for Spindex routes that compare against or update the remote service
- `WTT_PIPELINE_ENABLED=true` start the WTT polling pipeline on server boot
- `TTBL_PIPELINE_ENABLED=true` start the TTBL polling pipeline on server boot
- `WTT_SCRAPER_BACKEND=ttu|fabrik` choose the WTT scrape backend; default is `ttu`

Additional runtime-only timing overrides used in code:

- `TTBL_FOLLOWUP_DELAY_MS`
- `TTBL_FOLLOWUP_RETRY_DELAY_MS`
- `WTT_FOLLOWUP_DELAY_MS`
- `WTT_FOLLOWUP_RETRY_DELAY_MS`

## What The UI Gives You

- Scrape controls for `Scrape TTBL`, `Scrape WTT`, `TTBL full refresh`, `WTT full refresh`, `Master sync`, and `Destroy data`
- Job polling, cancellation, last-action logs, and persistent background sync activity from Postgres
- Player registry totals, merge candidates, and a strict registry rebuild trigger
- Player explorer drilldowns into source profiles, country-aware merge comparisons, player detail pages, and match detail pages
- Endpoint catalog for MCP, internal scrape routes, Spindex routes, and utility routes

## Usage

Dashboard defaults:

- `Scrape TTBL` accepts `2025` or `2025-2026` (CSV). TTBL youth matches are excluded by default.
- `Scrape WTT` accepts CSV years. Ingestion is still hard-filtered to gendered singles events, and youth events are included by default.
- `TTBL full refresh` discovers seasons from `1995` through `currentYear + 1` by default and keeps WTT data.
- `WTT full refresh` discovers years from `2017` through `currentYear` by default and keeps TTBL data.
- `Master sync` clears relational rows and `data/`, then runs TTBL all-time scrape, WTT all-time scrape, and player-registry rebuild.
- `Destroy data` clears relational dataset rows and removes `data/`.

Example API calls:

```bash
curl -X POST http://localhost:3000/api/scrape/ttbl \
  -H "content-type: application/json" \
  -d '{"seasons":["2025-2026"],"delayMs":300}'

curl -X POST http://localhost:3000/api/scrape/wtt \
  -H "content-type: application/json" \
  -d '{"years":[2026,2025],"includeYouth":true,"profileEnrichMaxPlayers":600}'
```

TTBL/WTT scrape jobs, all-time refresh jobs, the clean job, and the destroy-data job expose `GET` status endpoints with optional `?jobId=<id>` polling. `GET /api/players/registry?status=1` returns the latest registry rebuild job state.

## Scripts

- `pnpm dev` start the Next.js dev server
- `pnpm build` run `prisma generate` and build the app
- `pnpm start` start the production server
- `pnpm lint` run ESLint
- `pnpm prisma:generate` regenerate the Prisma client
- `pnpm prisma:migrate:dev` create/apply a development migration
- `pnpm prisma:migrate:deploy` apply committed migrations
- `pnpm prisma:studio` open Prisma Studio

## API Endpoints (App)

Scrape and job routes:

- `POST/GET /api/scrape/ttbl`
- `POST/GET /api/scrape/ttbl/all`
- `POST/GET /api/scrape/ttbl/followup`
- `POST/GET /api/scrape/wtt`
- `POST/GET /api/scrape/wtt/all`
- `POST/GET /api/scrape/wtt/followup`
- `POST/GET /api/scrape/clean`
- `POST/GET /api/data/destroy`
- `GET/POST /api/players/registry`

Player, sync, and utility routes:

- `GET /api/overview`
- `GET /api/endpoints`
- `GET /api/pipeline/status` (WTT pipeline status)
- `GET /api/players/slugs`
- `GET /api/players/source-profiles`
- `GET /api/players/country-conflicts`
- `GET /api/countries/match`
- `GET /api/sync/activity`

Spindex routes:

- `GET /api/spindex/ping`
- `POST /api/spindex/players/check`
- `POST /api/spindex/players/update`
- `POST /api/spindex/sync` (legacy compatibility alias)

MCP routes:

- `GET /api/mcp`
- `POST /api/mcp`
- `DELETE /api/mcp?cancel=1` to cancel active jobs, optionally with `jobId`, `target`, `includeQueued`, and `clearFollowups`

## Data Artifact Keys

Scrapes still write JSON artifacts under `data/`:

- `data/ttbl/current/metadata.json`
- `data/ttbl/current/matches_summary.json`
- `data/ttbl/current/players/*.json`
- `data/ttbl/current/stats/*.json`
- `data/ttbl/seasons/<season>/...`
- `data/ttbl/legacy_index.json`
- `data/wtt/players.json`
- `data/wtt/matches.json`
- `data/wtt/player_match_index.json`
- `data/wtt/dataset.json`
- `data/pipeline/ttbl_state.json`
- `data/pipeline/wtt_state.json`

Player registry state, canonical members, merge candidates, TTBL player profiles, WTT players, TTBL matches/games, and sync activity are stored in Postgres tables.

## Clean Scrape

Use `POST /api/scrape/clean` to:

1. Delete relational dataset rows
2. Remove and recreate `data/`
3. Discover and scrape TTBL all-time seasons
4. Discover and scrape WTT all-time years
5. Rebuild the merged player registry
6. Schedule follow-up TTBL/WTT jobs when unfinished or ongoing matches remain

Use `POST /api/scrape/wtt/all` to refresh WTT history without deleting TTBL data. It remains singles-only, with youth events included by default. Use `POST /api/scrape/ttbl/all` to refresh TTBL history without deleting WTT data.

## Background Automation

- `POST /api/scrape/ttbl/followup` and `POST /api/scrape/wtt/followup` schedule delayed re-scrapes when recent jobs detect live or unfinished matches
- `WTT_PIPELINE_ENABLED=true` starts a polling pipeline that watches live and official WTT singles results and ingests newly completed matches
- `TTBL_PIPELINE_ENABLED=true` starts a polling pipeline that watches TTBL current-season gamedays and ingests newly completed Bundesliga matches
- WTT pipeline status is available at `GET /api/pipeline/status`

## MCP Endpoint

`POST /api/mcp` exposes MCP-compatible JSON-RPC methods including:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/templates/list`

Current tools include:

- `get_overview`
- `start_ttbl_scrape`
- `start_wtt_scrape`
- `start_wtt_all_time_scrape`
- `start_master_scrape`
- `get_scrape_status`
- `cancel_scrape_jobs`
- `list_matches`
- `list_places`
- `health_check`
- `match_country`
- `audit_country_conflicts`
- `field_mapping`
