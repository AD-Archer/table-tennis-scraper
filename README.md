# MLTT Scrape - Table Tennis Data Collection

A comprehensive data scraping project for collecting table tennis (ping pong) data from multiple sources including WTT/ITTF (international) and TTBL (German Bundesliga).

## Project Overview

This project aims to collect comprehensive table tennis data including:
- Player profiles and rankings
- Match results with game-by-game scores
- Tournament information
- Historical performance data
- League-specific statistics

The project uses multiple specialized AI agents to discover data sources and build robust scrapers for both international (WTT/ITTF) and domestic league (TTBL) data collection.

## Current Status

✅ **Working Components:**
- **WTT/ITTF International Data:**
  - Rankings scraper (`wtt_ittf_scraper.py`)
  - Comprehensive data collector (`comprehensive_collector.py`)
  - Player ID discovery (195+ known IDs, expandable)
  - Match data collection via Fabrik API
  - Gender-based player separation

- **TTBL German Bundesliga:**
  - Enhanced scraper (`scrape_ttbl_enhanced.py`)
  - Real-time match data collection
  - Player statistics and ELO verification
  - Complete season coverage

⚠️ **Limitations:**
- Historical rankings require browser automation (Cloudflare protected)
- Player DOB not available from public APIs
- Some endpoints require authentication

## Next.js Port

A new dashboard app now exists in [`web/`](web/README.md) with:
- UI controls to run TTBL and WTT scrapes
- Legacy season scraping support
- Player registry dedupe + merge candidate tracking
- Clean full-history scrape that rebuilds from scratch
- Data written only to `web/data` (no dependency on `TTBL/` or `ITTF/` folders)
- Endpoint explorer and data file location panels

Run:
```bash
cd web
npm install
npm run dev
```

## Scrapers Overview

### master_scrape.py - Master Match + Player Dataset

**Location:** `ITTF/WTT/scripts/master_scrape.py`

**Purpose:** Build a single consolidated dataset of players and matches (without rankings).

**What it collects (publicly available):**
- Matches (including game-by-game points) from results.ittf.link Fabrik JSON
- Player IDs + names + association codes observed in match rows

**Limitations:**
- DOB and team are usually not available from public match rows; these fields are saved as `null` unless a public source is added later.

**Run:**
```bash
python3 ITTF/WTT/scripts/master_scrape.py --years 2025,2024,2023
```

**Output:**
- `ITTF/WTT/artifacts/data/master/dataset.json`
- `ITTF/WTT/artifacts/data/master/players.json`
- `ITTF/WTT/artifacts/data/master/matches.json`
- `ITTF/WTT/artifacts/data/master/player_match_index.json`

### wtt_ittf_scraper.py - Rankings Scraper

**Location:** `ITTF/WTT/scripts/wtt_ittf_scraper.py`

**Purpose:** Collect current player rankings data from the WTT API.

**How it Works:**
- Makes HTTP requests to the WTT rankings API endpoint
- Implements retry logic with exponential backoff
- Supports single player, batch processing, and ID discovery modes
- Validates player IDs and extracts ranking information

**Key Features:**
- Rate limiting protection
- Error handling and logging
- JSON output with metadata
- CLI interface for easy operation

### comprehensive_collector.py - Unified Data Collector

**Location:** `ITTF/WTT/scripts/comprehensive_collector.py`

**Purpose:** Comprehensive collection of player and match data from multiple sources.

**How it Works:**
- Integrates rankings API and Fabrik match data API
- Processes player IDs from Agent 1 findings
- Extracts gender information from event codes
- Parses match data including game-by-game scores
- Expands player database via match discovery

**Key Features:**
- Gender separation (MS=Male, WS=Female)
- Game score parsing from space-separated strings
- Player database expansion
- Multi-year data collection
- Structured JSON outputs

### scrape_ttbl_enhanced.py - TTBL German Bundesliga Scraper

**Location:** `TTBL/scrape_ttbl_enhanced.py`

**Purpose:** Collect comprehensive match data, player statistics, and game results from the German Table Tennis Bundesliga (TTBL).

**How it Works:**
- Scrapes match schedule from TTBL website
- Fetches detailed match data via TTBL API endpoints
- Extracts player information and game-by-game scores
- Calculates win/loss statistics and rankings
- Supports real-time data collection (results available as soon as matches finish)

**Key Features:**
- **Real-time data access** - No caching delays, fresh results immediately after matches
- Point-by-point scoring with millisecond precision
- Player win/loss rate tracking
- ELO data verification system
- Complete season coverage (all gamedays)
- Structured JSON output for analysis

## Installation & Setup

### Dependencies

```bash
pip install requests
```

### Directory Structure

```
mltt-scrape/
├── ITTF/
│   └── WTT/
│       ├── research/
│       │   └── agents/
│       │       ├── agent1/
│       │       │   └── player_ids.json       # Known player IDs
│       │       └── agent4/
│       │           └── findings.md
│       ├── scripts/
│       │   ├── wtt_ittf_scraper.py
│       │   └── comprehensive_collector.py
│       └── artifacts/                     # WTT/ITTF generated output (gitignored)
│           └── data/
│               └── wtt_ittf/
│                   ├── players/
│                   ├── matches/
│                   └── rankings/
└── TTBL/                                 # German Bundesliga scraper
    ├── scrape_ttbl_enhanced.py          # Main scraper script
    ├── verify_elo_data.py               # ELO verification
    ├── docs/                            # TTBL documentation
    ├── ttbl_data/                       # TTBL output directory
    │   ├── metadata.json
    │   ├── matches/
    │   ├── players/
    │   └── stats/
    └── README.md                        # TTBL-specific README
```

### Environment Setup

1. Ensure Python 3.7+ is installed
2. Install dependencies: `pip install requests`
3. Create output directories if needed

## Usage Examples

### Rankings Scraper

**Single Player Rankings:**
```bash
cd ITTF/WTT/scripts
python3 wtt_ittf_scraper.py --player 121558
```

**Batch Processing:**
```bash
python3 wtt_ittf_scraper.py --batch 121558,101919,105649
```

**Player ID Discovery:**
```bash
python3 wtt_ittf_scraper.py --discover 110000 110050
```

### Comprehensive Collector

**Full Data Collection:**
```bash
cd ITTF/WTT/scripts
python3 comprehensive_collector.py --agent1-file ../research/agents/agent1/player_ids.json --years 2025
```

**Multi-Year Collection:**
```bash
python3 comprehensive_collector.py --agent1-file ../research/agents/agent1/player_ids.json --years 2025,2024,2023
```

**Custom Output Directory:**
```bash
python3 comprehensive_collector.py --output-dir ./my_data --years 2025
```

### TTBL Scraper

**Full Season Collection:**
```bash
cd TTBL
python3 scrape_ttbl_enhanced.py
```

**Check Results:**
```bash
# View metadata
cat ttbl_data/metadata.json | jq '.'

# Get top 10 players by win rate
jq '.[0:10] | .[] | {name, gamesPlayed, wins, losses, winRate}' ttbl_data/stats/player_stats_final.json

# Verify data for ELO system
python3 verify_elo_data.py
```

## Data Collected

### Player Data Structure

```json
{
  "ittf_id": "121558",
  "first_name": "Chuqin",
  "last_name": "WANG",
  "full_name": "WANG Chuqin",
  "nationality": "CHN",
  "gender": "M",
  "source": "rankings_api",
  "rankings": {
    "ms_rank": 1,
    "ws_rank": null,
    "points": 9925,
    "event_codes": ["MS", "MDI"]
  },
  "scraped_at": "2026-01-09T22:30:00Z"
}
```

### Match Data Structure

```json
{
  "match_id": "10602874",
  "year": "2025",
  "tournament": "WTT Youth Contender San Francisco 2026",
  "event": "U11MS",
  "stage": "Main Draw",
  "round": "Final",
  "player_a": {
    "id": 209656,
    "name": "SUN Frank (USA)",
    "association": "USA"
  },
  "player_b": {
    "id": 209645,
    "name": "BAVISKAR Shuban (USA)",
    "association": "USA"
  },
  "games": [
    {"game_number": 1, "player_score": 3, "opponent_score": 11},
    {"game_number": 2, "player_score": 3, "opponent_score": 11},
    {"game_number": 3, "player_score": 8, "opponent_score": 11},
    {"game_number": 4, "player_score": 11, "opponent_score": 8}
  ],
  "winner_id": 209645,
  "walkover": false
}
```

### Rankings Data Structure

```json
{
  "IttfId": "121558",
  "PlayerName": "WANG Chuqin",
  "CountryCode": "CHN",
  "SubEventCode": "MS",
  "RankingYear": "2026",
  "RankingWeek": "2",
  "RankingPointsYTD": "9925",
  "CurrentRank": "1",
  "PreviousRank": "1"
}
```

### TTBL Match Data Structure

```json
{
  "match_id": "bf29638f-9165-4203-982a-6a25f36452be",
  "season": "2025-2026",
  "gameday": 1,
  "home_team": "Borussia Düsseldorf",
  "away_team": "1. FC Saarbrücken",
  "players": [
    {
      "name": "Bastian Steger",
      "team": "Borussia Düsseldorf",
      "games": [11, 11, 8, 11],
      "opponent_games": [8, 7, 11, 9]
    }
  ],
  "result": "3:2",
  "state": "Finished",
  "timestamp": "2026-01-09T20:00:00Z"
}
```

### TTBL Player Statistics Structure

```json
{
  "id": "bf29638f-9165-4203-982a-6a25f36452be",
  "name": "Bastian Steger",
  "gamesPlayed": 15,
  "wins": 12,
  "losses": 3,
  "winRate": 80,
  "lastMatch": "95c232f8-7ac8-4d66-ad27-1e3cb6205d34"
}
```

## Data Sources

### Rankings API
- **Endpoint:** `https://wttcmsapigateway-new.azure-api.net/internalttu/RankingsCurrentWeek/CurrentWeek/GetRankingIndividuals`
- **Authentication:** None required
- **Parameters:** `IttfId={id}&q=1`
- **Rate Limit:** None observed, but use delays
- **Data:** Current week rankings for all events

### Fabrik Match API
- **Endpoint:** `https://results.ittf.link/index.php?option=com_fabrik&view=list&listid=31&format=json`
- **Authentication:** None required
- **Parameters:** `vw_matches___yr[value]={year}&limit={n}`
- **Data:** Match results, game scores, player IDs
- **Format:** Space-separated game scores: `"3:11 3:11 8:11"`

### Player ID Sources
- **Agent 1 Findings:** 195 known IDs from rankings pages
- **Match Data:** Additional IDs discovered via Fabrik API
- **Range:** 100000-150000 (most active players)

### TTBL APIs
- **Match Data:** `https://www.ttbl.de/api/internal/match/{matchId}`
- **Schedule:** `https://www.ttbl.de/bundesliga/gameschedule/{season}/{gameday}/all`
- **Authentication:** None required
- **Rate Limit:** 1 second delay recommended
- **Data:** Real-time match results, point-by-point scoring, player stats

## File Structure

### Output Directories

**WTT/ITTF Output:**
```
ITTF/WTT/artifacts/data/wtt_ittf/
├── players/
│   ├── players_database.json     # All players
│   ├── gender/
│   │   ├── players_men.json      # Male players
│   │   ├── players_women.json    # Female players
│   │   └── players_mixed.json    # Mixed doubles
│   └── players_by_id/            # Individual files
├── matches/
│   ├── matches_2025.json         # Year-specific
│   ├── matches_2024.json
│   └── matches_by_player/        # Per player
├── rankings/
│   └── rankings_current.json     # Current rankings
└── collection_report.json        # Statistics
```

**Master Output (consolidated):**
```
ITTF/WTT/artifacts/data/master/
├── dataset.json
├── players.json
└── matches.json
```

**TTBL Output:**
```
ttbl_data/
├── metadata.json                 # Scrape session metadata
├── match_ids.txt                 # All match IDs
├── matches_summary.json          # Match summaries
├── matches/                      # Individual match JSON files
├── players/
│   ├── all_players.json          # All players (with duplicates)
│   └── unique_players.json       # Deduplicated player list
└── stats/
    ├── player_stats_final.json   # Player stats by win rate
    ├── top_players.json          # Top 20 players (min 5 games)
    ├── games_data.json           # Individual game results
    └── match_states.json         # Match state breakdown
```

### Source Files

**WTT/ITTF Source Files:**
```
ITTF/WTT/
├── research/
│   └── agents/
│       ├── agent1/
│       │   ├── findings.md           # Discovery report
│       │   └── player_ids.json       # Initial player IDs
│       ├── agent2/findings.md        # Historical limitations
│       ├── agent3/findings.md        # Match API discovery
│       └── agent4/
│           ├── findings.md           # Implementation notes
│           └── findings_run2.md
├── scripts/                       # Runnable scrapers/tools
└── docs/                         # Documentation
    ├── API_DISCOVERY.md
    ├── NEXT_STEPS.md
    └── UNIFIED_STRATEGY.md
```

**TTBL Source Files:**
```
TTBL/
├── scrape_ttbl_enhanced.py       # Main scraper script
├── verify_elo_data.py            # ELO data verification
├── docs/
│   ├── CHANGELOG.md             # Version history
│   ├── DATA_COVERAGE.md         # Data catalog & freshness
│   ├── ELO_DATA_VERIFICATION.md # ELO verification guide
│   └── ENHANCED_SCRAPER_GUIDE.md # Detailed usage guide
└── README.md                     # TTBL-specific documentation
```

## Troubleshooting

### Common Issues

**LSP Cache Issues (Python 3.14)**
```
Error: Module not found
Solution: Use Python 3.8-3.11, or run manually without LSP
```

**No Data Returned**
```
Check: Is the player ID valid?
Test: curl "https://wttcmsapigateway-new.azure-api.net/internalttu/RankingsCurrentWeek/CurrentWeek/GetRankingIndividuals?IttfId=121558&q=1"
```

**Rate Limiting**
```
Add delays: time.sleep(1) between requests
Use batch processing sparingly
```

**Fabrik API Returns HTML**
```
Issue: Sometimes returns HTML instead of JSON
Solution: Use browser automation or retry with different parameters
```

**TTBL Data Quality Issues**
```
Run verification: python3 verify_elo_data.py
Check for missing player names (scheduled but not announced matches)
```

**TTBL No Matches Found**
```
Check schedule URL: curl -sL "https://www.ttbl.de/bundesliga/gameschedule/2025-2026/1/all" | head -50
Verify season format and gameday numbers
```

### Error Messages

- `{"Result": null}` → Invalid player ID
- `401 Unauthorized` → Authentication required (blocked endpoint)
- `403 Forbidden` → Cloudflare protection (historical data)
- `ModuleNotFoundError` → Install dependencies: `pip install requests`

### Performance Tips

- Use batch processing for multiple players
- Add delays between API calls (1-2 seconds)
- Process data in chunks for large collections
- Monitor output file sizes

## Contributing

### Adding New Scrapers

1. Follow the pattern in `wtt_ittf_scraper.py`
2. Use `ScraperConfig` dataclass for settings
3. Implement retry logic with exponential backoff
4. Add CLI interface with argparse
5. Document data sources and limitations

### Extending Data Collection

1. **New APIs:** Test authentication requirements first
2. **New Data Types:** Update data models and JSON schemas
3. **Historical Data:** Implement browser automation for Cloudflare bypass
4. **Third-Party APIs:** Evaluate SportDevs/Sportradar for missing data

### Testing

```bash
# Test single player
python3 wtt_ittf_scraper.py --player 121558

# Test comprehensive collection
python3 comprehensive_collector.py --agent1-file ../../agent1/player_ids.json --years 2025 --limit 10

# Verify output
ls -la data/wtt_ittf/
```

### Code Standards

- Use type hints and dataclasses
- Include docstrings for all functions
- Handle exceptions gracefully
- Log important operations
- Follow PEP 8 style guidelines

## License & Credits

This project was developed using specialized AI agents for data discovery and scraper implementation.

**Agents Used:**
- Agent 1: Player ID Discovery
- Agent 2: Historical Rankings Research
- Agent 3: Match Data API Discovery
- Agent 4: Scraper Implementation

**Data Sources:**
- World Table Tennis (WTT)
- International Table Tennis Federation (ITTF)
- results.ittf.link (Fabrik CMS)
- TTBL (German Table Tennis Bundesliga)

## Contact & Support

For issues with the scrapers or data collection:
1. Check the agent findings in `ITTF/WTT/research/agents/agent*/findings.md`
2. Test API endpoints manually with curl
3. Review troubleshooting section above
4. Check for rate limiting or authentication changes

---

**Last Updated:** January 9, 2026
**Version:** 1.0
**Status:** Production Ready for WTT/ITTF and TTBL Data Collection
