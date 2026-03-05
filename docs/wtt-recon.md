# WTT (worldtabletennis.com) — Recon Report

**Date:** 2026-03-05  
**Target:** https://www.worldtabletennis.com  
**Method:** Playwright browser session (no Cloudflare/WAF blocking)

---

## 1. Stack Overview

| Layer | Technology |
|---|---|
| Server | Express.js (`x-powered-by: Express`) |
| CDN | Azure Front Door (`*.a01.azurefd.net`) |
| Auth | Azure AD B2C (`worldtabletennisb2c.b2clogin.com`) |
| Storage | Azure Blob Storage (`wttwebcmsprod.blob.core.windows.net`) |
| Video | Azure Media Player (`amp.azure.net`) |
| Scoring | TTU (Table Tennis Unit) API (`wttcmsapigateway-new.azure-api.net`) |
| Analytics | Google Tag Manager, Facebook Pixel, Wordfence |

---

## 2. Source Maps

**Result: NOT accessible.**

- `https://www.worldtabletennis.com/main.7bb6e7ff5556e6bf6c93.js.map` → HTTP 200 but returns HTML (Express SPA catch-all route), `content-type: text/html`, 6438 bytes — not a real sourcemap.
- The Express server serves the Angular SPA's `index.html` for unknown routes, masking the 404.
- **No sourcemaps exposed publicly.**

---

## 3. JS Bundles

| File | URL | Notes |
|---|---|---|
| Main App | `/main.7bb6e7ff5556e6bf6c93.js` | Angular app bundle — all business logic |
| Vendor | `/vendor.a58995a657344f36ca2a.js` | Third-party libraries |

---

## 4. Page Routes (Frontend SPA Routes)

From navigation snapshot + `routes_all_list.json`:

### Core Routes
| Route | Description |
|---|---|
| `/home` | Homepage with live scores ticker |
| `/news` | News listing |
| `/news?search=:query` | News search |
| `/headervideo` | Videos listing |
| `/headervideo?vid=:videoId` | Single video player |
| `/playerslist` | Players listing |
| `/eventslist` | Events listing |
| `/matches` | Match results |
| `/rankings` | Rankings |
| `/livevideo` | Live streaming |
| `/signup` | Subscribe / registration |
| `/aboutus` | About WTT |
| `/hostevent` | Host a WTT event |
| `/BrandPartnerships` | Brand partnerships |
| `/contact-us` | Contact |
| `/team` | WTT team |
| `/technicaldocuments` | Technical documents |
| `/terms` | Terms and conditions |
| `/privacy` | Privacy notice |
| `/media_portal` | Media portal |
| `/description?artId=:id` | Article detail |
| `/playerDescription?playerId=:ittfId` | Player profile |

### Event-Specific Custom Routes (from `routes_all_list.json`)
These are named event pages served at `/:routeName`:

| Route | Event | eventId |
|---|---|---|
| `/fukuoka` | WTT Finals Fukuoka 2024 | 2947 |
| `/goa` | WTT Star Contender Goa 2023 | 2696 |
| `/nagoya` | WTT Finals Women Nagoya 2023 | 2776 |
| `/Frankfurt` | WTT Champions Frankfurt 2025 | 3100 |
| `/doha` | WTT Champions Doha 2026 | 3231 |
| `/incheon` | WTT Champions Incheon 2025 | 3087 |
| `/montpellier` | WTT Champions Montpellier 2025 | 3099 |
| `/chinasmash` | China Smash 2025 | 3098 |
| `/macao` (2024) | WTT Champions Macao 2024 | 2983 |
| `/USSmash` | United States Smash 2025 | 3082 |
| `/chongqing` | WTT Champions Chongqing 2026 | 3235 |
| `/skopje` | WTT Youth Star Contender Skopje 2025 | 3061 |
| `/ljubljana` | WTT Star Contender Ljubljana 2025 | 3091 |
| `/zagreb` | WTT Contender Zagreb 2025 | 3092 |
| `/lagos` | WTT Contender Lagos 2025 | 3121 |
| `/buenosaires` | WTT Contender Buenos Aires 2025 | 3175 |
| `/fozdoiguacu` | WTT Star Contender Foz do Iguaçu 2025 | 3093 |
| `/yokohama` | WTT Champions Yokohama 2025 | 3094 |
| `/europesmash` | Europe Smash - Sweden 2025 | 3128 |
| `/almaty` | WTT Contender Almaty 2025 | 3096 |
| `/macao` (2025) | WTT Champions Macao 2025 | 3097 |
| `/london` | WTT Star Contender London 2025 | 3110 |
| `/muscat` | WTT Star Contender Muscat 2025 | 3176 |
| `/hongkong` | WTT Finals Hong Kong 2025 | 3112 |
| `/singapore` | Singapore Smash 2026 | 3234 |
| `/chennai` | WTT Star Contender Chennai 2026 | 3233 |

---

## 5. API Architecture

Three distinct backend systems, all behind Azure Front Door:

### 5.1 CMS / Website API
**Base URL:** `https://wtt-website-api-prod-3-frontdoor-bddnb2haduafdze9.a01.azurefd.net`

This is the main content API. All paths are `/api/cms/...` or `/api/...`.

**Observed live calls:**
```
GET /api/cms/GetAppSetting/website_show_header_score_cards
GET /api/cms/GetAppSetting/live_video_streaming_event_id?q={timestamp}
GET /api/cms/GetWTTVideosListByDefaultCategory/1/0?site_name=wtt
GET /api/cms/GetFeaturedPlayer/1/0
```

**Full method catalog (extracted from main bundle):**

#### App Settings
- `GetAppSetting/{key}` — feature flags and config values
- `GetApplicationSetting`
- `GetApplicationSettingEventInfo`
- `GetApplicationSettingParaEventIds`

#### Articles / News
- `GetAllArticleCategory`
- `GetArticleByCategoryId`
- `GetArticleByCategoryIds`
- `GetArticleByID`
- `GetArticleByIDWithUserId`
- `GetArticleContent`
- `GetArticleDescription`
- `GetArticleDetailsByID`
- `GetArticleList`
- `GetArticles`
- `GetArticlesWithIds`
- `GetDBArticleData`
- `GetDetailedFavouriteArticle`
- `GetFeaturedArticles`
- `GetLatestArticle`
- `GetLatestArticleFilters`
- `GetLatestArticles`
- `GetLatestArticlesIsFeatured`
- `GetLatestArticlesWithFilter`
- `GetNewlyPublishedArticle`
- `GetNonFeaturedArticlePlayers`
- `GetRelatedArticles`
- `GetTopStoriesArticles`
- `GetPlayersArticles`

#### Players
- `GetAllFeaturePlayers`
- `GetAllNonFeaturePlayers`
- `GetAllPlayers`
- `GetAllPlayersWithFilter`
- `GetAllPlayersWithLanguage`
- `GetAllPlayersWithUserId`
- `GetFavouritePlayers`
- `GetFeaturedPlayer`
- `GetJSONPlayerNameList`
- `GetPlayerBios`
- `GetPlayerCardDetails`
- `GetPlayerDetails`
- `GetPlayerEntriesforEvent`
- `GetPlayerEntriesforEventBySubEventId`
- `GetPlayerListWithName`
- `GetPlayerNames`
- `GetPlayerProfile`
- `GetPlayerProfilePicWithIttfId`
- `GetPlayerRankingDetails`
- `GetPlayerSummary`
- `GetPlayerUpcomingEvent`
- `GetPlayersByPID` — by player ID
- `GetPlayersByPIDAndUID` — by player ID + user ID (auth required)
- `GetPlayersDataByID`
- `GetPlayersDataByUserId`
- `GetPlayersHeadToHead?Player1=&Player2=`
- `GetPlayersListByFilters`
- `GetPlayersListByLanguage`
- `GetPlayersListByUserId`
- `GetPlayersListWithIds`
- `GetPlayersListWithFilter`
- `GetPlayersMatchData`
- `GetPlayersNameData`
- `GetPlayersNameOnly`
- `GetPlayersNameWithId`
- `GetPlayersOfSubEvents`
- `GetPlayersPrizeMoney`
- `GetPlayersWithFilter`
- `GetTopFavouritePlayers`
- `GetNonFeaturedArticlePlayers`

#### Events
- `GetAllEventList`
- `GetAllEventPrize`
- `GetAllEventPrizeById`
- `GetAllEventTickets`
- `GetAllEventWinners`
- `GetAllEventsByUserID`
- `GetAllEventsOnlyWithEventName`
- `GetAllEventsWithIds`
- `GetAllLiveOrActiveEvents`
- `GetAllLiveOrActiveEventsDetails`
- `GetAllLiveOrActiveSubEventsDetails`
- `GetAvailableEvents`
- `GetAvailableEventsList`
- `GetAvailableLiveEvents`
- `GetEventBrackets`
- `GetEventCategoryDetailsById`
- `GetEventData`
- `GetEventDescWithEventID`
- `GetEventDescription`
- `GetEventDetails`
- `GetEventDocumentsList`
- `GetEventDrawDetails`
- `GetEventDraws`
- `GetEventEquipment`
- `GetEventGroupStatus`
- `GetEventGroupsData`
- `GetEventMedalists`
- `GetEventName`
- `GetEventPlayerLeaderboard`
- `GetEventPlayersListByGender`
- `GetEventPrizeMoney`
- `GetEventSchedule`
- `GetEventSubEventForMatch`
- `GetEventTableNames`
- `GetEventTeamsList`
- `GetEventType`
- `GetEventTypeDetails`
- `GetEventTypeDetailsByCategoryId`
- `GetEventVenue`
- `GetEventVenueDetailById`
- `GetEventWinnerById`
- `GetEventWinners`
- `GetEventWinnersByEventId`
- `GetEventsByEventId`
- `GetEventsForMatches`
- `GetEventsPlayersByEventId`
- `GetOfficialEventWinnerList`
- `GetSubEvents`
- `GetSubEventsPlayers`
- `GetSubEventsPlayersBySubEventId`
- `GetWTTEventsList`
- `GetAllNAParticipants`

#### Rankings
- `GetAllPlayersRakingList`
- `GetAllRankingPlayers`
- `GetExternalPairData`
- `GetExternalPairDataFromWTTAPI`
- `GetExternalPairDataWithCountryFilter`
- `GetExternalPlayerData`
- `GetPlayersRaceWttFinalListDoubles`
- `GetPlayersRaceWttFinalListSingles`
- `GetPlayersRankingData`
- `GetPlayersRankingDataBasedOnittfid`
- `GetPlayersRankingDataBasedOnittfidFromTTUAPI`
- `GetPlayersRankingDataBasedOnittfidFromWTTAPI`
- `GetPlayersRankingDataFromJSON`
- `GetPlayersRankingDataFromWTTAPI`
- `GetPlayersRankingDataWithCountryFilter`
- `GetPlayersRankingDataWithFilter`
- `GetPlayersWithAgeFilterRankingDataFromWTTAPI`
- `GetPlayersStatDataBasedOnittfid`
- `GetRankersListByFilters`
- `GetRankingData`
- `GetRankingHistoryEvents`
- `GetRankingHistoryEventsIndividuals`
- `GetRankingHistoryEventsPairs`
- `GetRankingHistoryIndividual`
- `GetRankingHistoryMatches`
- `GetRankingHistoryMatchesIndividuals`
- `GetRankingHistoryMatchesPairs`
- `GetRankingHistoryMatchesPairsByPairId`
- `GetRankingHistoryMatchesStatsIndividuals`
- `GetRankingHistoryMatchesStatsPairs`
- `GetRankingHistoryMatchesStatsPairsByPaidId`
- `GetRankingHistoryPairs`
- `GetRankingIndividuals`
- `GetRankingLatPublishedDate`
- `GetRankingPairs`
- `GetRankingPlayerDetails`
- `GetRankingPointsBreakdown`
- `GetTop5Rankers`
- `GetTopFiveRankersList`

#### Match Results
- `GetDrawDetails`
- `GetEventDrawDetails`
- `GetGameDetails`
- `GetGameStats`
- `GetGetMatchCardDetails`
- `GetLiveMatchCardDetails`
- `GetLiveMatchCommentaryJSON`
- `GetLiveResult`
- `GetMatchCard`
- `GetMatchCardDetails`
- `GetMatchCommentary`
- `GetMatchDetailByPlayers`
- `GetMatchDetails`
- `GetMatchLatestMessages`
- `GetMatchPoints`
- `GetMatchPollData`
- `GetMatchResults`
- `GetMatchResultsById`
- `GetMatchStats`
- `GetMultipleMatchStats`
- `GetOfficialMatches`
- `GetOfficialResult`
- `GetPastResults`
- `GetPreMatchCardList`
- `GetResultsIntermediate`

#### Videos
- `GetDefaultWTTVideoList`
- `GetLatestVideoFilters`
- `GetLiveStreams`
- `GetLiveStreamsData`
- `GetStaticLiveStreams`
- `GetVideoDataWithFilter`
- `GetVideoDetails`
- `GetVideoList`
- `GetVideoListByCatgory`
- `GetVideoListByCatgoryId`
- `GetVideoListByDocumentId`
- `GetVideosByCategories`
- `GetVideosWithIds`
- `GetWTTVideoById`
- `GetWTTVideoListByCatagory`
- `GetWTTVideoListOnPageLoad`
- `GetWTTVideoListWithCategory`
- `GetWTTVideosListByCategory`
- `GetWTTVideosListByDefaultCategory/{page}/{offset}?site_name=wtt`
- `GetWttvideocategories`

#### Users / Auth
- `GetAllUsers`
- `GetExternalChatBotConnectToken`
- `GetFavouritePlayers`
- `GetProfiles`
- `GetUserInformationByEmailId`
- `GetWatchCountry`
- `/api/WTTUserProfiles`
- `/api/tokens`

#### Misc
- `GetAllCountry`
- `GetAllDocumentCategory`
- `GetAllGalleryCategoryList`
- `GetAllGalleryList`
- `GetAllSitemapList`
- `GetAllSponsorsList`
- `GetAllWTTGalleryList`
- `GetBlobData`
- `GetBlobDataWithLanguage`
- `GetBlobFileData`
- `GetBrackets`
- `GetCategoryList`
- `GetColorCode`
- `GetComponentData`
- `GetCountriesList`
- `GetDocumentAllList`
- `GetGalleryCategoryId`
- `GetGalleryDetailsById`
- `GetGalleryPhotosListByGalleryID`
- `GetGlobalSearchResult`
- `GetHeadtoHeadComparison`
- `GetITTFInduviualName`
- `GetLeadingPlayersListByGender`
- `GetMediaDocumentList`
- `GetMediaDocuments`
- `GetModulesData`
- `GetOrganizationList`
- `GetPageList`
- `GetParticipents`
- `GetPhotosByGalleryId`
- `GetPoolStandings`
- `GetPrizeMoneyForEvent`
- `GetPrizeMoneyForIndivisualPlayer`
- `GetProfilePicList`
- `GetProvisionalData`
- `GetRenderPageList`
- `GetRoutesAllList`
- `GetRoundName`
- `GetRoundsNames`
- `GetSiteDocumentsList`
- `GetSponsorDetail`
- `GetSponsorDetails`
- `GetSponsorDetailsByCategory`
- `GetSponsorLogo`
- `GetSponsors`
- `GetSponsorsNameOnly`
- `GetSubEventDrawSize`
- `GetSubEventsPlayersListBySubEventId`
- `GetTeamsDetails`
- `GetTechnicalDocumentList`
- `GetTechnicalDocuments`
- `GetTechnicalDocumentsList`
- `/api/Individuals`
- `/api/Web/Storage/List`

---

### 5.2 TTU Connect API (Live Scoring)
**Base URL:** `https://wttcmsapigateway-new.azure-api.net` (via gateway)  
**Front Door Mirror:** `https://wtt-ttu-connect-frontdoor-g6gwg6e2bgc6gdfm.a01.azurefd.net`

This is the real-time scoring system sourced from **TTU (Table Tennis Unit)** — the live data provider.

**Observed live calls:**
```
GET /ttu/Matches/GetLiveMatches?EventId=3267&TableId=T01&q={timestamp}
GET /Players/GetPlayers?IttfId={ittfId}&q={timestamp}
```

**Methods extracted from bundle:**
```
GET /ttu/Matches/GetLiveMatches?EventId={id}&TableId={tableCode}
GET /Players/GetPlayers?IttfId={ittfId}
GET /Players/GetPlayersByPID?PlayerId={pid}
GET /Players/GetPlayersByPIDAndUID?PlayerId={pid}&UserId={uid}
GET /Players/GetPlayersDataByID/{id}
GET /Players/GetStatsByPlayer
GET /Players/GetRankingHistoryMatchesStatsIndividuals
GET /Players/GetRankingHistoryMatchesStatsPairs
GET /Players/GetRankingHistoryMatchesStatsPairsByPaidId
GET /Matches/GetMatchDetails
GET /Events/GetEventDetails
GET /Rankings/GetRankingData
```

**Live score polling logic (from console logs):**
- Polls `GetLiveMatches` continuously when live event is active
- Match data is fetched per document code:
  ```
  GET /matchdata/{eventId}/{documentCode}.json
  ```

---

### 5.3 Static File CDN (No-Cache)
**Base URL:** `https://wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net`

Fresh/live JSON files — polled frequently:

```
GET /websitestaticapifiles/articles/wtt_new_articles.json
GET /websitestaticapifiles/articles/wtt_top_stories_article.json
GET /websitestaticapifiles/general/wtt_live_results_event_id.json
GET /websitestaticapifiles/{eventId}/{eventId}_active_live_event_details.json
GET /websitestaticapifiles/{eventId}/{eventId}_take_10_official_results.json
GET /websitestaticapifiles/{eventId}/{eventId}_livematchids.json?EventId={eventId}
GET /matchdata/{eventId}/{documentCode}.json   ← live match score JSON
```

**Sample livematchids response:**
```json
[
  { "eventId": "3267", "documentCode": "TTEWSINGLES-----------QFNL000100----------", "subEventType": "Women Singles" },
  { "eventId": "3267", "documentCode": "TTEWSINGLES-----------QFNL000200----------", "subEventType": "Women Singles" }
]
```

---

### 5.4 Static File CDN (Cached)
**Base URL:** `https://wtt-web-frontdoor-cthahjeqhbh6aqe3.a01.azurefd.net`

Cached/slower-changing data:

```
GET /websitestaticapifiles/general/wtt_static_pages_list.json
GET /websitestaticapifiles/{eventId}/{eventId}_wtt_override_tablenames.json
GET /staticfiles/jsonfiles/View_Players_WithNationalityandOrgCode_Different.json?q={timestamp}
GET /staticfiles/jsonfiles/event_venue_override.json
GET /staticfiles/jsonfiles/routes_all_list.json?q={timestamp}
GET /websitefiles/images/general/...    ← image assets
GET /eventimages/...                     ← event logos
GET /articledetailimages/...             ← article images
```

---

### 5.5 Auth System
**Provider:** Azure AD B2C  
**Tenant:** `worldtabletennisb2c.onmicrosoft.com`  
**Policy:** `B2C_1_Wtt_Web_SignIn`

```
GET https://worldtabletennisb2c.b2clogin.com/worldtabletennisb2c.onmicrosoft.com/v2.0/.well-known/openid-configuration?p=B2C_1_Wtt_Web_SignIn
GET https://worldtabletennisb2c.b2clogin.com/worldtabletennisb2c.onmicrosoft.com/discovery/v2.0/keys?p=b2c_1_wtt_web_signin
```

Standard OAuth2/OIDC. JWT tokens sent as Bearer. Some player endpoints expose data unauthenticated; personal/subscriber data requires auth.

---

### 5.6 ITTF Admin API
**Base URL:** `https://ittf-admin-api-ehaug5ghbvbpdpd7.a01.azurefd.net`

Found in bundle as a base URL reference. Not observed in live network calls from homepage. Likely used in admin sections.

---

## 6. Live Scoring System — Deep Dive

### Document Code Format
```
{SPORT_CODE}{DISCIPLINE}--{DISCIPLINE_SUFFIX}-----{ROUND_CODE}{LEG_CODE}{MATCH_NUM}----------
```

Examples:
- `TTEWSINGLES-----------QFNL000100----------` → Table Tennis, Women's Singles, Quarterfinal, Match 1
- `TTEMDOUBLES-----------SFNL000200----------` → Men's Doubles, Semifinal, Match 2
- `TTEXDOUBLES-----------SFNL000100----------` → Mixed Doubles, Semifinal, Match 1
- `TTEMSINGLES-----------8FNL000100----------` → Men's Singles, Round of 16, Match 1

**Round codes found:**
| Code | Round |
|---|---|
| `QFNL` | Quarterfinal |
| `SFNL` | Semifinal |
| `8FNL` | Round of 16 (last 16) |
| `FNLS` | Final (presumed) |

### Live Match Data Flow
1. `GET /websitestaticapifiles/general/wtt_live_results_event_id.json` → get active event ID
2. `GET /websitestaticapifiles/{eventId}/{eventId}_livematchids.json` → get list of live match doc codes
3. For each doc code: `GET /matchdata/{eventId}/{documentCode}.json` → score data
4. Parallel: `GET /ttu/Matches/GetLiveMatches?EventId={id}` → aggregate live matches list

The `(SM)new_sequence_number` console logs indicate a **sequence number polling mechanism** — each live match JSON has a sequence number; client polls until the number changes, indicating new score data.

### External Link Config
```
GET https://wttwebcmsprod.blob.core.windows.net/imagedocuments/ExternalLink.json?q={random}
```
Contains dynamic external link overrides (e.g., for redirecting nav links to sponsor sites).

---

## 7. Other API Notes

- `GetPlayersHeadToHead?Player1={ittfId}&Player2={ittfId}` — head-to-head stats
- `GetPlayersRankingDataFromWTTAPI` uses params: `TopN`, `CategoryCode`, `SubEventCode`, `AgeCategoryCode`
- `GetPlayersRaceWttFinalListSingles/Doubles` — WTT Finals race/qualification standings
- `GetPlayersSeedListforEventBySubEventId_WithParticDetails` — seedings with participant details
- `GetEventGroupStatus` + `GetEventGroupsData` — round-robin group phase data
- `GetBrackets` / `GetEventBrackets` / `GetEventDrawDetails` — knockout draw tree
- `GetMatchCommentary` / `GetLiveMatchCommentaryJSON` — point-by-point commentary
- `GetMatchStats` / `GetGameStats` / `GetGameDetails` — per-game and per-match stats
- `/api/odf/generate/DT_PARTIC_TEAMS/2410` — ODF (Olympic Data Feed) format export; numeric ID is event-related

---

## 8. Subdomains / Related Sites

| Subdomain | Purpose |
|---|---|
| `www.worldtabletennis.com` | Main site |
| `careers.worldtabletennis.com` | Job listings (separate site) |
| `worldtabletennisb2c.b2clogin.com` | Azure AD B2C auth |

---

## 9. Scraping Notes

### Easy / Open
- All static JSON files on `wtt-web-frontdoor-cthahjeqhbh6aqe3.a01.azurefd.net` and `wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net` — **no auth, no CORS issues, directly fetchable**
- Live match data at `/matchdata/{eventId}/{docCode}.json` — public, fast, great for live scoring
- `wtt_live_results_event_id.json` + `{eventId}_livematchids.json` — your entry points for scraping live events
- Player data via `GetPlayers?IttfId=` on TTU API — no auth observed

### Auth Required
- Subscriber-only video content
- User watchlist / favourites
- Personal profile data

### Rate Limiting
- `?q={timestamp}` cache-busting params on many calls — server expects these
- Azure Front Door CDN — may have rate limits but none observed during session

### Key Scraping Entry Points
```
# Active live event
https://wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net/websitestaticapifiles/general/wtt_live_results_event_id.json

# Live match IDs for event
https://wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net/websitestaticapifiles/{eventId}/{eventId}_livematchids.json?EventId={eventId}

# Live match score data
https://wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net/matchdata/{eventId}/{documentCode}.json

# All events list
https://wtt-web-frontdoor-cthahjeqhbh6aqe3.a01.azurefd.net/websitestaticapifiles/general/wtt_all_events_only_name.json

# All players list
https://wtt-web-frontdoor-cthahjeqhbh6aqe3.a01.azurefd.net/websitestaticapifiles/general/wtt_all_players_only_name.json

# Top stories / news
https://wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net/websitestaticapifiles/articles/wtt_top_stories_article.json

# Event details (active live event)
https://wtt-web-frontdoor-withoutcache-cqakg0andqf5hchn.a01.azurefd.net/websitestaticapifiles/{eventId}/{eventId}_active_live_event_details.json

# Player data (TTU API)
https://wtt-ttu-connect-frontdoor-g6gwg6e2bgc6gdfm.a01.azurefd.net/Players/GetPlayers?IttfId={ittfId}

# Live matches aggregate (TTU API)
https://wttcmsapigateway-new.azure-api.net/ttu/Matches/GetLiveMatches?EventId={eventId}&TableId={tableCode}
```
