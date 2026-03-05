# ittf.com Reconnaissance Report

> **Target:** https://www.ittf.com  
> **Method:** Cloudflare bypass via Playwright, inline JS config extraction, WP REST API enumeration  
> **Date:** 2026-03-05

---

## Key Finding: Not Next.js

**`www.ittf.com` is WordPress, not Next.js.** There are no `/_next/` paths.  
The `_next/static/chunks/*.js.map` pattern does **not apply here**.

- Platform: **WordPress** (theme: `ittf`, builder: Bornan — https://www.bornan.net)
- Cloudflare WAF is active — direct `curl` returns HTTP 403 with bot challenge
- The raw JS files (`ittf.js`) are also Cloudflare-protected at the URL level, but accessible from within a browser session

---

## Tech Stack

| Component | Detail |
|-----------|--------|
| CMS | WordPress |
| Theme | `ittf` (custom, `/wp-content/themes/ittf/`) |
| Builder/Agency | Bornan (https://www.bornan.net) |
| WAF | Cloudflare (managed challenge, bot fight mode) |
| Analytics | Google Tag Manager (`GTM-P2TST3`), GA4 (`G-FNXVH4KHWT`, `G-C5E6Y3BPDF`), UA (`UA-41921233-1`, `UA-81820650-1`) |
| Font | MTI Project `cf03c1e4-10be-44b7-bb6d-bc7bffe74091` |
| SEO | Yoast SEO |
| Security | Wordfence |
| Metrics | ExactMetrics |
| Social share | Ultimate Social Media Icons |
| Countdown | HurryTimer |
| Video | YouTube Embed Plus |
| Comments | Disqus |
| Email subs | follow.it |
| Frontend JS | jQuery 2.2.4, Underscore.js 1.13.4, jQuery UI 1.13.2 |

---

## Subdomains Discovered

| Subdomain | Purpose |
|-----------|---------|
| `www.ittf.com` | Main WordPress site |
| `data-api.ittf.com` | Tournament/draws/standings data API (`v1`) — DNS only resolves from inside Cloudflare network |
| `pdf.ittf.com` | PDF draw generation service |
| `results.ittf.link` | Stats portal (separate app, LiteSpeed) |
| `equipment.ittf.com` | Equipment approval app (hash-router SPA: `/#/equipment/`) |
| `directory.ittf.com` | Member directory |

---

## data-api.ittf.com — Tournament Data API

Discovered from the `_ittf` global config object injected inline on every tournament/draws page:

```javascript
var _ittf = {
  "ittv": "1",
  "api": {
    "hello":       "https://data-api.ittf.com/v1",
    "tournaments": "https://data-api.ittf.com/v1/tournaments",
    "draws":       "https://data-api.ittf.com/v1/draws",
    "today":       "https://data-api.ittf.com/v1/todays/matches",
    "standings":   "https://data-api.ittf.com/v1/standings"
  },
  "tpdfc": {
    "data": "https://pdf.ittf.com"
  },
  "features": { "worldTour": true }
};
```

### Confirmed API Endpoints

```
GET  https://data-api.ittf.com/v1/tournaments
GET  https://data-api.ittf.com/v1/tournaments/filters
GET  https://data-api.ittf.com/v1/tournaments/:id
GET  https://data-api.ittf.com/v1/draws
GET  https://data-api.ittf.com/v1/todays/matches
GET  https://data-api.ittf.com/v1/standings
```

> **Note:** `data-api.ittf.com` does **not resolve from public DNS** — it's an internal hostname only accessible through Cloudflare's network (the browser resolves it via Cloudflare's CDN edge; direct `curl` fails with `ERR_NAME_NOT_RESOLVED`). These calls are made client-side from the browser.

### Filter fields (tournament calendar filter UI)
- `type` — tournament type
- `stage` — bracket stage
- `bracketStage` — bracket sub-stage
- `country` — country filter
- `month` / `year` — date filters

### Round label map (from `_ittf.l10n.roundLabelMap`)
```
KO-2    → Final
KO-4    → Semi Finals
KO-8    → Quarter Finals
KO-16   → Round of 16
KO-32   → Round of 32
KO-64   → Round of 64
KO-128  → Round of 128
KO-256  → Round of 256
KO-102  → Positions 1-2
KO-304  → Positions 3-4
KO-912  → Positions 9-12
... (full position bracket map for 36+ position slots)
```

### Standing event codes
```
MS → Mens Singles
WS → Womens Singles
MD → Mens Doubles
WD → Womens Doubles
M2 → U21 Boys Singles
W2 → U21 Girls Singles
```

---

## ITTV Livestream API

Discovered from theme JS (`ittf.js`), driven by `window.ittf.ittv`. Base URL is set dynamically via a `data-base` HTML attribute per-page. Pattern:

```
GET  {base}livestream/true/custom_stream_state/4
GET  {base}livestream/true/datestart/1900-01-01/competition/{ittvId}/limit/999
GET  {base}livestream/true/datestart/1900-01-01/team/{ittvId}/limit/999
GET  {base}ondemand/true/datestart/1900-01-01/competition/{ittvId}/limit/{perPage}/page/{page}
GET  {base}ondemand/true/datestart/1900-01-01/team/{ittvId}/limit/{perPage}/page/{page}
GET  {base}page/{n}/
```

Response contains: `title`, `stream.start/end`, `images`, `link.web`, `competition.name`, `court.name`, `saison.name`, `league.name`.

---

## WordPress REST API — Fully Enumerated

Base: `https://www.ittf.com/wp-json/`

### Exposed Namespaces
```
oembed/1.0
wordfence/v1          ← Security scanner (admin-only)
yoast/v1              ← SEO plugin
4bf130/v1             ← Custom ITTF plugin (auth-required)
exactmetrics/v1       ← Analytics plugin
wp/v2                 ← Standard WP REST API
wp-site-health/v1
wp-block-editor/v1
```

### Custom ITTF Plugin (`4bf130/v1`)
```
POST /wp-json/4bf130/v1/606a/a30e712d   ← Returns 401 without auth
```
This endpoint is called directly from the tournament calendar page (observed in network requests). The obfuscated namespace (`4bf130`) and route hash (`606a/a30e712d`) suggest anti-enumeration intent.

### Standard WordPress REST API (`wp/v2`)

| Route | Notes |
|-------|-------|
| `GET /wp/v2/posts` | Public posts (news articles) |
| `GET /wp/v2/posts/:id` | Single post |
| `GET /wp/v2/pages` | Public pages |
| `GET /wp/v2/pages/:id` | Single page |
| `GET /wp/v2/media` | Media library |
| `GET /wp/v2/media/:id` | Single media item |
| `GET /wp/v2/categories` | Post categories |
| `GET /wp/v2/tags` | Post tags |
| `GET /wp/v2/users` | **403 — user listing disabled** |
| `GET /wp/v2/users/me` | Returns auth user info (requires login) |
| `GET /wp/v2/menus` | Nav menus |
| `GET /wp/v2/search` | Site-wide search |
| `GET /wp/v2/types` | Post types |
| `GET /wp/v2/taxonomies` | Taxonomy list |
| `GET /wp/v2/comments` | Public comments |
| Full CRUD on posts, pages, media, blocks, etc. | Auth required |

### Yoast SEO (`yoast/v1`)

| Route | Notes |
|-------|-------|
| `GET /yoast/v1/get_head` | SEO head metadata for any URL |
| `GET /yoast/v1/meta/search` | SEO meta search |
| Various indexing/config endpoints | Admin-only |

### Wordfence (`wordfence/v1`)

| Route | Notes |
|-------|-------|
| `POST /wordfence/v1/authenticate` | Wordfence login |
| `POST /wordfence/v1/scan` | Trigger scan |
| `GET /wordfence/v1/scan/issues` | List scan issues |
| `POST /wordfence/v1/config` | Config management |

> All Wordfence routes require admin authentication.

### ExactMetrics (`exactmetrics/v1`)

```
GET /exactmetrics/v1/popular-posts/themes/:type
GET /exactmetrics/v1/terms/:slug
GET /exactmetrics/v1/taxonomy/:slug
```

---

## WordPress Admin AJAX

URL: `https://www.ittf.com/wp-admin/admin-ajax.php`

Exposed in multiple places:
- `_EPYT_.ajaxurl` (YouTube Embed Plus plugin)
- `_chameleon.ajaxUrl`
- `sfsi_icon_ajax_object.ajax_url`
- `hurrytimer_ajax_object.ajax_url`

Standard WP AJAX endpoint — requires knowing action names and nonces for most operations.

---

## WordPress Page Structure

### Key Public URL Patterns (from site navigation)

```
/                              → Homepage
/news/                         → News archive
/category/general-news/        → News by category
/category/pr/                  → Press releases
/2026/MM/DD/post-slug/         → Individual news articles
/tournaments/                  → Tournament calendar (broken — DB migration)
/tournament/:id/               → Tournament detail (e.g. /tournament/2982/)
/tournament/:id/#information   → Tournament info tab
/2026-events-calendar/         → Current year calendar
/YYYY-events-calendar/         → Archive calendars (2017–2025)
/rankings/                     → Rankings
/summit-2026/                  → Summit microsite
/para-table-tennis/            → Para TT section
/hpd/                          → HP & Development
/search/                       → Search
/integrity/                    → Integrity section
/careers/                      → Careers
/sustainability/               → Sustainability
/governance/                   → Governance
/media/                        → Media section
/offices/                      → Offices
/contact-us/                   → Contact
/history/                      → History
/statutes/                     → Handbook/Statutes
/documents/                    → Documents
/privacy-policy/               → Privacy Policy
```

---

## Key Observations

1. **No Next.js** — `www.ittf.com` is WordPress. The `_next/static/chunks/` path does not exist.
2. **`data-api.ittf.com` is DNS-internal only** — not publicly resolvable. The API is called browser-side through Cloudflare's CDN which handles resolution internally. Cannot be directly `curl`'d.
3. **Tournament database migration in progress** — The page displays: *"Due to the transition of the ITTF database, the information you are trying to access can't be provided at this time."* All tournament calendar/filter calls are 503-ing or DNS-failing.
4. **WordPress REST API is open** — `wp/v2/posts`, `pages`, `media`, `categories`, `tags`, `search`, `comments` are all publicly readable with no auth.
5. **User enumeration blocked** — `/wp/v2/users` returns 403. Good hardening.
6. **Wordfence is installed** — Security scanner running; its own REST API is exposed at `/wordfence/v1/` (auth required).
7. **Obfuscated custom REST namespace** — `4bf130/v1/606a/a30e712d` is called on page load. The hash-style naming suggests intentional anti-enumeration, but it's still discoverable via `wp-json/` index.
8. **Multiple analytics IDs** — Two GA4 properties, one UA (legacy), GTM container. Full user tracking stack.
9. **ITTF ecosystem has separate apps** — `results.ittf.link` (stats), `equipment.ittf.com` (SPA), `directory.ittf.com` — each is a separate application not enumerated here.
