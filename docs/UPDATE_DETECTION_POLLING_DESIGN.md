# Polling-Based Match-Result Update Detection Design

## 1) Scope and goal

Detect when match results are updated on:

- `worldtabletennis.com`
- `eventresults.ittf.com`
- `results.ittf.link`
- `ttbl.de`

Design is polling-only (no webhooks/SSE/websockets) and normalizes updates into one event stream:

- `match_started`
- `score_changed`
- `match_finished`
- `metadata_changed`

All detection logic is based on repeated API reads + deterministic diffing.

---

## 2) Shared polling contract

### 2.1 Poll cycle (global)

1. **Fetch sources** in a bounded concurrency queue (e.g., 4–8 in flight max).
2. **Compute deltas** against last-seen state:
   - `added` (new match IDs)
   - `status_changed`
   - `score_changed`
   - `important_meta_changed` (date/round/stage/player info)
3. **Emit change event** records for each changed item.
4. **Adjust cadence** based on signal density:
   - active matches present → shorter interval
   - idle/finished state → longer interval
.5. **Persist state**: latest watermarks, hashes, and pending retries.

### 2.2 Canonical match record and diff

Persist a canonical object per match with:

- `match_id` (provider-specific)
- `source` (`wttf`, `eventresults`, `results_link`, `ttbl`)
- `status` (`scheduled|live|finished|abandoned|...`)
- `scores` (`sets`, `games`, `points`, raw score blob)
- `updated_at_source` if provided
- `participants` and venue/group metadata
- `raw_hash` (stable hash of normalized payload)
- `raw_payload` (optionally compressed)

Diff rules:

- `status_changed` when `status` differs.
- `score_changed` when `raw_hash` differs in score fields only.
- `metadata_changed` when other fields differ.
- Always suppress duplicates using `(match_id, raw_hash)` per source.

---

## 3) Site-specific adapters

### 3.1 `worldtabletennis.com`

- **Discovery endpoint**
  - `GET /ttu/Events/GetEvents`
  - header: `ApiKey` required.
- **Live match endpoint**
  - `GET /ttu/Matches/GetLiveMatches?EventId={eventId}`
- Strategy:
  1. Poll events every 60s when no active matches.
  2. For each in-progress/featured event, poll `GetLiveMatches` every 5–15s.
  3. Track event-level watermark (`last_event_count`, `eventId`) and per-match watermark.
- Change triggers:
  - New active match appears in live list.
  - `status`/`score` change in any live match.
- Backoff:
  - If `GetLiveMatches` returns empty 3 cycles in a row for an event, reduce polling to 30s, then 60s.

### 3.2 `eventresults.ittf.com`

- **Primary approach**
  - Use same/related ITTF match APIs discovered by bundle analysis (Event/Match list semantics aligned with `worldtabletennis` data model).
  - Apply exactly the same event→live-match polling pattern.
- Strategy:
  1. Keep polling event feed (or equivalent recent-match feed) every 45s initially.
  2. Promote active events to a faster poll schedule (5–15s) while they contain live matches.
  3. Deactivate fast polling once all matches in scope are finished/abandoned for 2+ cycles.
- Change triggers:
  - Live match status/score transitions.
  - New match IDs appearing under the active event.

### 3.3 `results.ittf.link`

- **Feed endpoint**
  - `GET /index.php?option=com_fabrik&view=list&listid=31&format=json&limit=1&orderby=vw_matches___id&orderdir=desc`
- Strategy:
  1. Poll ordered list endpoint in short bursts (2s–10s when active change suspected, otherwise 20–60s).
  2. Maintain `last_seen_match_id` (max id seen).
  3. Poll with `limit` and same ordering; if first record ID equals `last_seen_match_id`, fetch page increments only when changed.
- Change triggers:
  - New record id greater than last seen.
  - `match_record.updated`/status/score diff for known IDs.
- Anti-noise filter:
  - Ignore non-terminating ordering anomalies unless `last_seen_match_id` regresses for a limited number of consecutive polls.

### 3.4 `ttbl.de`

- **Match endpoint**
  - `GET /api/internal/match/{matchId}`
- **Related endpoint found in client route map**
  - `/videoWidget/{matchId}` (used by client for state refresh).
- Strategy:
  1. Maintain current active match set from prior reads.
  2. For each active match, poll `/api/internal/match/{matchId}` every 5s.
  3. Poll non-active matches every 120s for completion/status sanity checks.
  4. Optionally sample `/videoWidget/{matchId}` every 10–15s when match is live to catch UI state transitions.
- Change triggers:
  - Match enters/exits finished state.
  - Any score object delta.
  - Player names/team/round changes from metadata diff.

---

## 4) Concrete scheduler behavior (recommended values)

- **Global tick:** 1 second loop that dispatches domain workers based on next-due timestamp.
- **Initial base intervals**
  - Discovery phase: `worldtabletennis` 30s, `eventresults` 45s, `results.link` 20s, `ttbl` 60s
  - Active match refresh: 5s
- **Jitter**
  - Add random jitter 0.5–3.5% per request to reduce synchronization spikes.
- **Retry policy**
  - On network error: 1 retry after 2s, 2nd after 8s, 3rd after 30s.
  - After 3 failures, exponential backoff multiplier 2x up to 10 min.
- **Timeout**
  - 4s for lightweight list endpoints.
  - 8s for detailed match endpoints.
- **401/403 handling**
  - Mark source as degraded.
  - Keep low-frequency polling (e.g., 5 minutes) and alert check; stop fast loops until successful auth recovery.
- **429 handling**
  - Increase interval with exponential backoff.
  - Respect server hints if `Retry-After` is provided.

---

## 5) Watermarks and idempotency

- **Match watermark map**: `source + match_id -> last_raw_hash`
- **Event watermark map**: `source + event_id -> last_event_seen`
- **Cursor for results.ittf.link**: `source -> max_match_id_seen`

When a poll returns no changes, simply extend `last_success_at` and do not emit.

Before emitting:
- `if current_hash == previous_hash => no event`
- if changed: emit one normalized change event and store new hash atomically.

---

## 6) Failure and accuracy trade-offs

- **Missed updates**: if a request is missed, next poll fetches full latest snapshot and reconciles.
- **Duplicate events**: dedupe by `(source, match_id, event_type, score_hash, status, window_start_ts)`.
- **Partial payloads**: ignore deltas if required fields missing; requeue same match for immediate re-check.
- **Clock skew**: use local poll timestamp for sequencing, not client-provided timezone-sensitive strings.

---

## 7) Proposed output schema (change event)

- `id`
- `source`
- `match_id`
- `event_type`
- `detected_at`
- `poll_latency_ms`
- `old_value`
- `new_value`
- `source_payload_meta` (status code, etag, headers of interest)
- `raw_patch` (optional)

Store events in append-only order for replay and audit.

---

## 8) Alerting and observability

- Success rate target per source (>= 99.5% over rolling 1h where auth is valid)
- Poll lag metric:
  - `match_detected_lag_seconds = now - source_updated_at` for finished matches
- Change detection rate:
  - changes/minute per source
- Error taxonomy:
  - auth, transport, parse, no-change, parse-miss, throttling
- Dead sources:
  - if no successful poll in 10 minutes, raise health alert and reduce fanout to that source.

---

## 9) Summary architecture

Use a **single orchestrator** with **four source adapters** and a **shared state store**:

- `orchestrator` controls interval schedule.
- `adapters` know source endpoints and normalization rules.
- `differ` computes deterministic deltas.
- `event_store` records concrete change events.
- `watchdog` raises health issues and auto-adjusts polling pressure.

This design stays resilient without push channels and is optimized for low-latency detection while controlling request volume.
