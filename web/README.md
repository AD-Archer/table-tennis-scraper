# TTBL + ITTF/WTT Next.js Control Deck

Next.js port of the Python scraping workflow for:
- TTBL Bundesliga match/game data
- ITTF/WTT public match data (Fabrik list API, men/women singles only)
- Multi-season TTBL history scraping
- Unified player registry with duplicate-merge tracking

## Run

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:3000`.

All scraper reads/writes are hard-locked to `web/data` (the app does not read from `../TTBL` or `../ITTF`, and path env overrides are ignored).

## What The UI Gives You

- Simple scraper controls:
  - `Scrape TTBL` by entering `2025` or `2025-2026` (CSV)
  - `Scrape WTT` by entering years (CSV)
  - `Master sync (all years)` to discover/scrape full TTBL + WTT history (ignores text-box values)
  - `Destroy data` hard reset button
- Player registry + merge candidate table
- Per-action scrape logs for TTBL/WTT/master-sync/destroy runs
- Endpoint explorer (scraper + registry endpoints)
- Data file location cards so you can see exactly where artifacts are saved
- Plain-language panel describing what player registry rebuild means

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

## Data Output Paths

- TTBL active read dir: latest season under `data/ttbl/seasons/*` (or `data/ttbl/current` if newer)
- TTBL current season alias output: `data/ttbl/current`
- TTBL legacy seasons: `data/ttbl/seasons`
- TTBL legacy index: `data/ttbl/legacy_index.json`
- WTT dataset: `data/wtt`
- Player registry files: `data/players`
- Manual alias merges: `data/players/manual_merges.json`

## Clean Scrape

Use `POST /api/scrape/clean` to:
1. Delete `web/data`
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
- `list_matches` (today, ongoing, not finished, legacy, current filters)
- `list_places`
- `health_check`
