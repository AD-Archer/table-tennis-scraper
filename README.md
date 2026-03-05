# TTBL + ITTF/WTT Next.js Control Deck

Next.js port of the Python scraping workflow for:
- TTBL Bundesliga match/game data
- ITTF/WTT public match data (Fabrik list API, men/women singles only)
- Multi-season TTBL history scraping
- Unified player registry with duplicate-merge tracking

## Run

```bash
pnpm install
just
just dev
```

Open `http://localhost:3000`.

`just` recipes run `pnpm` scripts through Infisical (`infisical run -- ...`), so secrets from your Infisical project are loaded automatically.
Make sure both CLIs are installed: `just` and `infisical` (this repo already includes `.infisical.json`).

Available commands:

- `just` or `just list` (list commands)
- `just dev`
- `just build`
- `just start`
- `just lint`
- `just prisma-generate`
- `just prisma-migrate-dev`
- `just prisma-migrate-deploy`
- `just prisma-studio`

All scraper reads/writes are hard-locked to `data/` (the app does not read from `../TTBL` or `../ITTF`, and path env overrides are ignored).

## Environment

Set these in `.env`:

- `DATABASE_URL=postgresql://...` (required for Prisma/Postgres mode)
- `NEXT_PUBLIC_MASTER_SYNC_PASSWORD=...` (frontend-only check for master sync and destroy-data buttons)
- `ADMIN_CONSOLE_PASSWORD=...` (server-side password for `/console/errors` + `/api/admin/*`)
- `DATA_STORE_MODE=postgres` (`files`, `hybrid`, or `postgres`; default is `postgres`)
- `SERVER_LOG_LEVEL=info` (optional: `debug`, `info`, `warn`, `error`)
- `SERVER_LOG_PRETTY=true` (optional; pretty multi-line logs in non-prod by default)

You can start from `.env.example`.

Notes:

- `hybrid`: keeps file output and mirrors artifacts into Postgres.
- `postgres`: reads/writes artifacts from Postgres only (no local `data/` files are created).
- Apply included migration with `pnpm prisma:migrate:deploy` after configuring `DATABASE_URL`.

## What The UI Gives You

- Simple scraper controls:
  - `Scrape TTBL` by entering `2025` or `2025-2026` (CSV)
  - `Scrape WTT` by entering years (CSV)
  - `Master sync (all years)` to discover/scrape full TTBL + WTT history (ignores text-box values)
  - `Destroy data` hard reset button
- Player registry + merge candidate table
- Per-action scrape logs for TTBL/WTT/master-sync/destroy runs
- Admin error console (`/console/errors`) for scrape/merge failure triage:
  - persistent timestamped error records
  - copyable full error payloads
  - manual alias fixes for merge resolution
- Endpoint explorer (scraper + registry endpoints)
- Data file location cards so you can see exactly where artifacts are saved
- Plain-language panel describing what player registry rebuild means
- Dashboard debug hooks to simulate scrape/merge errors and validate admin tooling end-to-end

## API Endpoints (App)

- `POST /api/scrape/ttbl`
- `POST /api/scrape/ttbl/all`
- `POST /api/scrape/wtt`
- `POST /api/scrape/wtt/all`
- `POST /api/scrape/clean`
- `POST /api/data/destroy`
- `GET /api/mcp` (MCP metadata + tools)
- `POST /api/mcp` (MCP JSON-RPC transport)
- `GET /api/scrape/ttbl?jobId=<id>` (poll action status/logs)
- `GET /api/scrape/ttbl/all?jobId=<id>` (poll TTBL all-time job logs)
- `GET /api/scrape/wtt?jobId=<id>` (poll action status/logs)
- `GET /api/scrape/wtt/all?jobId=<id>` (poll WTT all-time job logs)
- `GET /api/players/registry?status=1&jobId=<id>` (poll registry job status/logs)
- `GET /api/players/registry`
- `POST /api/players/registry`
- `GET /api/players/slugs`
- `GET /api/overview`
- `GET /api/endpoints`
- `GET/POST/DELETE /api/admin/errors` (admin password required, triage + simulation)
- `PATCH/DELETE /api/admin/errors/:id` (admin password required)
- `GET/POST/DELETE /api/admin/manual-aliases` (admin password required)

## Data Artifact Keys

- TTBL current metadata: `ttbl/current/metadata.json`
- TTBL season prefix: `ttbl/seasons/*`
- TTBL legacy index: `ttbl/legacy_index.json`
- WTT dataset: `wtt/dataset.json`
- Player registry: `players/player_registry.json`
- Manual alias merges: `players/manual_merges`

## Clean Scrape

Use `POST /api/scrape/clean` to:
1. Delete all existing artifacts
2. Discover and scrape TTBL all-time seasons
3. Discover and scrape ITTF/WTT all-time years
4. Rebuild merged player registry

Use `POST /api/scrape/wtt/all` to run all-time WTT discovery+scrape+registry rebuild without deleting TTBL data (still singles-only, youth excluded by default).

Use `POST /api/scrape/ttbl/all` to run all-time TTBL discovery+scrape+registry rebuild without deleting WTT data.

## MCP Endpoint

`POST /api/mcp` exposes MCP-compatible JSON-RPC methods:
- `initialize`
- `tools/list`
- `tools/call`

Tools include:
- `get_overview`
- `start_ttbl_scrape`
- `start_wtt_scrape`
- `start_master_scrape`
- `get_scrape_status`
- `list_matches` (filters + `view`/`fields` projection controls)
- `list_match_status` (lightweight status payload)
- `list_match_context` (venue/event/player-focused payload)
- `list_match_participants` (player+score payload)
- `list_places` (filters + `view`/`fields` projection controls)
- `list_place_activity` (today/ongoing totals payload)
- `health_check` (samples are opt-in via `includeSamples=true`)
