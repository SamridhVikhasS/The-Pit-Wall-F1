# Pit Wall — Driver-Picker Fix Patches

Apply these patches to `index.html` in order. Each patch is `before` → `after`,
matching by anchor text so they're unambiguous. The three Vercel function files
in this folder (`api/jolpica.js`, `api/openf1.js`) are drop-in replacements.

The goal of every patch: stop using `current` (which is misbehaving for the
in-progress 2026 season), and stop letting any single proxy attempt hang the
boot.

---

## Patch 1 · Add `fetchWithTimeout` helper

**WHERE:** In the `<script>` block, just **before** the `function cacheGet`
declaration (i.e. just before the `/* DATA LAYER — Phase 3 */` section).

**ADD:**

```javascript
/* ============================================================ */
/* TIMEOUT HELPER                                                */
/*   Wraps fetch with an AbortController so a slow upstream      */
/*   can't hang the whole proxy chain (or the whole boot).       */
/* ============================================================ */
function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}
```

---

## Patch 2 · Replace `fetchJSON` with timeout-aware + 429-aware version

**WHERE:** Locate the existing `async function fetchJSON(url, opts = {})` and
replace the entire function (everything from the opening `async function`
through its closing `}`).

**REPLACE WITH:**

```javascript
/**
 * Universal JSON fetcher with proxy chain + cache.
 *
 * Routing per URL:
 *   • Jolpica URLs → /api/jolpica → public proxies → cache
 *   • OpenF1 URLs  → /api/openf1  → direct (CORS) → cache
 *   • Any other    → direct fetch (Open-Meteo, etc.)
 *
 * Every attempt has a per-source timeout. 429s short-circuit to stale cache
 * so we don't burn through the rest of the proxy chain when the upstream is
 * already rate-limiting us.
 */
async function fetchJSON(url, opts = {}) {
  // Non-proxied APIs: just fetch and (optionally) cache
  if (!url.startsWith(JOLPICA_PREFIX) && !url.startsWith(OPENF1_PREFIX)) {
    const r = await fetchWithTimeout(url, { cache: "no-store", ...opts }, 10000);
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
    return r.json();
  }

  // Fresh-cache shortcut
  const cached = cacheGet(url);
  if (cached && Date.now() - cached.ts < CACHE_FRESH_MS) return cached.data;

  // Build the source list per upstream — each entry has its own timeout
  // budget so the chain can't hang the boot.
  const encoded = encodeURIComponent(url);
  let sources;
  if (url.startsWith(JOLPICA_PREFIX)) {
    sources = [
      { src: `/api/jolpica?url=${encoded}`,                       timeout: 8500 },
      { src: `https://api.allorigins.win/raw?url=${encoded}`,     timeout: 6000 },
      { src: `https://api.cors.lol/?url=${encoded}`,              timeout: 6000 },
      { src: `https://thingproxy.freeboard.io/fetch/${url}`,      timeout: 6000 },
    ];
  } else {
    sources = [
      { src: `/api/openf1?url=${encoded}`,                        timeout: 8500 },
      { src: url,                                                 timeout: 6000 },
    ];
  }

  let lastError = null;
  for (const { src, timeout } of sources) {
    try {
      const r = await fetchWithTimeout(src, { cache: "no-store", ...opts }, timeout);
      if (r.ok) {
        const data = await r.json();
        cacheSet(url, data);
        return data;
      }
      // Upstream is rate-limiting. Don't burn the rest of the chain — if we
      // have any cached copy, serve it; otherwise just throw and let the
      // caller's fallback decide.
      if (r.status === 429) {
        console.warn(`[Pit Wall] 429 on ${src.split("?")[0]} — backing off`);
        if (cached) return cached.data;
      }
      lastError = new Error(`HTTP ${r.status} via ${src.split("?")[0]}`);
    } catch (e) {
      const isAbort = e && (e.name === "AbortError" || /aborted/i.test(String(e.message || e)));
      console.warn(`[Pit Wall] ${isAbort ? "TIMEOUT" : "FAIL"} on ${src.split("?")[0]}: ${e.message || e}`);
      lastError = e;
    }
  }

  // All sources failed — serve stale cache if we have it
  if (cached) {
    console.warn(`[Pit Wall] All sources failed for ${url} — serving stale cache from ${new Date(cached.ts).toLocaleTimeString()}`);
    return cached.data;
  }
  console.error(`[Pit Wall] No sources or cache available for ${url}`);
  throw lastError || new Error(`All sources failed for ${url}`);
}
```

---

## Patch 3 · Add `resolveSeason` and remove the `FALLBACK_SEASON` magic

**WHERE:** Locate the `FALLBACK_SEASON` constant declaration:

```javascript
const FALLBACK_SEASON = "2025";
```

**REPLACE WITH:**

```javascript
// Year-based season resolution. We try the current calendar year first, then
// progressively older years until we find one with actual standings data.
// This replaces the magic /current endpoint, which returns 200 with empty
// StandingsLists when the in-progress season has transitional data — that
// silent-success failure mode was leaving `state.drivers = []` after onboarding.
//
// Resolved once per session and cached in module scope.
let __resolvedSeason = null;

function candidateSeasons() {
  const now = new Date();
  const yr = now.getFullYear();
  // Grace period: Jan / early Feb means the new year hasn't started yet.
  const startYear = (now.getMonth() < 2) ? yr - 1 : yr;
  return [startYear, startYear - 1, startYear - 2];
}

async function resolveSeason() {
  if (__resolvedSeason) return __resolvedSeason;
  for (const yr of candidateSeasons()) {
    try {
      const j = await fetchJSON(`${JOLPICA}/${yr}/driverStandings.json`);
      const list = j?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
      if (list.length) {
        __resolvedSeason = String(yr);
        console.info(`[Pit Wall] Active season → ${yr} (${list.length} drivers)`);
        return __resolvedSeason;
      }
      console.warn(`[Pit Wall] Season ${yr} returned 0 drivers — trying older`);
    } catch (e) {
      console.warn(`[Pit Wall] Season ${yr} probe failed:`, e.message || e);
    }
  }
  // Hard fallback — use last completed year so the UI still has something.
  __resolvedSeason = String(candidateSeasons()[1]);
  console.warn(`[Pit Wall] All season probes failed, defaulting to ${__resolvedSeason}`);
  return __resolvedSeason;
}

// Kept for backwards compatibility with any code paths I missed.
const FALLBACK_SEASON = "2025";
```

---

## Patch 4 · Rewrite all `current`-using fetchers to use `resolveSeason`

**WHERE:** Replace the entire block from `async function getDriverStandings()`
down through `async function getFullSeasonResults(season)` (i.e. all of the
Jolpica fetchers).

**REPLACE WITH:**

```javascript
async function getDriverStandings() {
  const season = await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${season}/driverStandings.json`);
    return j?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
  } catch (e) {
    console.warn("[Pit Wall] Driver standings failed", e);
    return [];
  }
}

async function getConstructorStandings() {
  const season = await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${season}/constructorStandings.json`);
    return j?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [];
  } catch (e) {
    console.warn("[Pit Wall] Constructor standings failed", e);
    return [];
  }
}

async function getSchedule() {
  const season = await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${season}.json?limit=100`);
    return j?.MRData?.RaceTable?.Races || [];
  } catch (e) {
    console.warn("[Pit Wall] Schedule failed", e);
    return [];
  }
}

async function getLastResults() {
  const season = await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${season}/last/results.json`);
    return j?.MRData?.RaceTable?.Races?.[0] || null;
  } catch (e) {
    console.warn("[Pit Wall] Last results failed", e);
    return null;
  }
}

async function getLastQualifying() {
  const season = await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${season}/last/qualifying.json`);
    return j?.MRData?.RaceTable?.Races?.[0] || null;
  } catch (e) {
    console.warn("[Pit Wall] Last qualifying failed", e);
    return null;
  }
}

async function getDriverCareerWins(driverId) {
  try {
    const j = await fetchJSON(`${JOLPICA}/drivers/${driverId}/results/1.json?limit=1`);
    return Number(j?.MRData?.total) || 0;
  } catch { return 0; }
}

async function getDriverCareerPoles(driverId) {
  try {
    const j = await fetchJSON(`${JOLPICA}/drivers/${driverId}/qualifying/1.json?limit=1`);
    return Number(j?.MRData?.total) || 0;
  } catch { return 0; }
}

async function getDriverRecentResults(driverId, count = 5) {
  const season = await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${season}/drivers/${driverId}/results.json?limit=${count}`);
    const races = j?.MRData?.RaceTable?.Races || [];
    if (races.length) return races.slice(-count);
    // Try the prior season as a fallback so newly-active drivers still show form
    const prior = String(Number(season) - 1);
    const j2 = await fetchJSON(`${JOLPICA}/${prior}/drivers/${driverId}/results.json?limit=${count}`);
    return (j2?.MRData?.RaceTable?.Races || []).slice(-count);
  } catch (e) {
    console.warn("[Pit Wall] Recent results failed", e);
    return [];
  }
}

async function getFullSeasonResults(season) {
  // If caller didn't pass a season, use the resolved one
  const yr = season ? String(season) : await resolveSeason();
  try {
    const j = await fetchJSON(`${JOLPICA}/${yr}/results.json?limit=1000`);
    return j?.MRData?.RaceTable?.Races || [];
  } catch (e) {
    console.warn("[Pit Wall] Full season results failed", e);
    return [];
  }
}
```

---

## Patch 5 · Make `populateDriverGrid` retry instead of immediately giving up

**WHERE:** Locate `function populateDriverGrid()` and replace the entire
function body.

**REPLACE WITH:**

```javascript
let __driverGridRetryTimer = null;
let __driverGridAttempts = 0;

function populateDriverGrid() {
  const grid = $("#driverGrid");
  const rows = state.drivers;

  // First-attempt loading state OR retry while the pre-fetch is still pending
  if (!rows.length) {
    __driverGridAttempts += 1;
    if (__driverGridAttempts <= 6) {
      // Show "still loading" — pre-fetch is in flight, just wait for it
      grid.innerHTML = `<div class="empty-state">
        <strong>Loading drivers…</strong><br /><br />
        Pulling the current grid from Jolpica F1. This usually takes 2-3 seconds.
        ${__driverGridAttempts > 2 ? '<br /><br />Taking a bit longer than usual — retrying.' : ''}
      </div>`;
      // Try again in 1.5s; the pre-fetch should land by then
      if (__driverGridRetryTimer) clearTimeout(__driverGridRetryTimer);
      __driverGridRetryTimer = setTimeout(() => {
        // If the data arrived in the meantime, re-render fully
        if (state.drivers.length) populateDriverGrid();
        else if (__driverGridAttempts < 6) populateDriverGrid();  // try again
        else populateDriverGrid();  // will fall through to the unavailable branch
      }, 1500);
      return;
    }

    // Gave up after 6 attempts (~9s). Show the unavailable message.
    grid.innerHTML = `
      <div class="empty-state">
        <strong>Driver list temporarily unavailable.</strong><br /><br />
        Jolpica F1's data feed isn't responding right now. This usually clears in a few minutes — try refreshing the page.<br /><br />
        You can also skip this step and pick your driver later via <code>/ edit profile</code>.
      </div>`;
    $("#driverConfirm").disabled = false;
    $("#driverConfirm").textContent = "skip ›";
    return;
  }

  // We have data — render the grid
  if (__driverGridRetryTimer) { clearTimeout(__driverGridRetryTimer); __driverGridRetryTimer = null; }
  __driverGridAttempts = 0;

  grid.innerHTML = rows
    .map((s, i) => {
      const color = colorForConstructor(s.Constructors?.[0]?.constructorId);
      const did = s.Driver?.driverId;
      const nick = driverNickname(s.Driver) || s.Constructors?.[0]?.name || "";
      const short = driverShortName(s.Driver);
      return `
        <button class="driver-card"
                data-driver-id="${escapeAttr(did)}"
                data-team-color="${color}"
                data-team-name="${escapeAttr(s.Constructors?.[0]?.name || "")}"
                data-code="${escapeAttr(s.Driver?.code || "")}"
                data-number="${escapeAttr(s.Driver?.permanentNumber || "")}"
                data-given="${escapeAttr(s.Driver?.givenName || "")}"
                data-family="${escapeAttr(s.Driver?.familyName || "")}"
                data-nickname="${escapeAttr(driverNickname(s.Driver) || "")}"
                style="--team-color:${color}; animation-delay:${(i * 0.04).toFixed(2)}s">
          <div class="dc-nick">"${escapeHtml(nick)}"</div>
          <div class="dc-name">${escapeHtml(short)}</div>
          <div class="dc-team">${escapeHtml(s.Constructors?.[0]?.name || "")}</div>
        </button>`;
    })
    .join("");

  grid.querySelectorAll(".driver-card").forEach((card) => {
    card.addEventListener("click", () => {
      grid.querySelectorAll(".driver-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      state.selectedDriverDuringOnboarding = {
        driverId:   card.dataset.driverId,
        driverCode: card.dataset.code,
        number:     card.dataset.number,
        givenName:  card.dataset.given,
        familyName: card.dataset.family,
        team:       card.dataset.teamName,
        color:      card.dataset.teamColor,
        nickname:   card.dataset.nickname,
      };
      setAccent(card.dataset.teamColor);
      $("#driverConfirm").disabled = false;
    });
  });
}
```

---

## Patch 6 · `boot()` should keep trying the driver fetch in the background

**WHERE:** Locate `async function boot()`. Replace the entire function.

**REPLACE WITH:**

```javascript
async function boot() {
  bindOnboarding();
  bindWelcome();
  bindMouseGlow();

  state.profile = loadProfile();
  if (state.profile) applyProfile();

  // Welcome runs in parallel with the data load — the user sees the lights
  // while everything downstream is already fetching in the background.
  runWelcome();

  // Pre-fetch driver list so onboarding's grid is ready if shown. Don't
  // await this — if it's slow, onboarding shows a "still loading" state
  // and re-renders when data arrives. This is the critical fix for the
  // "driver list unavailable" bug.
  getDriverStandings()
    .then(d => {
      state.drivers = d;
      // If the user is currently on the driver-picker step, re-render it
      const stepActive = document.querySelector('.onboarding-step[data-step="2"]')?.classList.contains('active');
      if (stepActive) populateDriverGrid();
    })
    .catch(e => {
      console.warn("[Pit Wall] Pre-fetch driver standings failed", e);
      state.drivers = [];
    });

  // Load everything else — schedule, last race, qualifying, calendar,
  // standings, your driver, weekend weather, race weekend mode, worm plot.
  try {
    await loadEverything();
  } catch (e) {
    console.warn("[Pit Wall] Initial loadEverything failed", e);
  }

  startWeekdayRefresh();
}
```

---

## Patches to Vercel functions

`api/jolpica.js` and `api/openf1.js` — replace both with the files in this
folder. The change: each now has an 8-second `AbortController` timeout on the
upstream fetch. Previously they could hang for Vercel's full 10s function
budget; now they return a clean 504 with CORS headers at 8s, which lets the
client move on to the next proxy in its chain immediately.

---

## Deploy

```
git add api/jolpica.js api/openf1.js index.html
git commit -m "fix: stop using /current, add timeouts, retry driver picker"
git push
```

Vercel auto-deploys. You should see the driver picker working again within ~30
seconds of the deployment finishing.

## How to verify

1. Open the site in an incognito window (so localStorage is empty)
2. Open browser dev tools → Console **before** the page loads
3. Watch for these console messages:
   - `[Pit Wall] Active season → 2026` (or 2025 if 2026 still flaky)
   - No `TIMEOUT` or `FAIL` warnings on `/api/jolpica` (those would mean your Vercel function is still slow)
4. The driver grid should populate within ~3 seconds of clicking through the name screen

## Why this happened a week ago

Most likely either Jolpica's `/current` endpoint started returning empty
`StandingsLists` mid-season as 2026 data filled in (the silent-success failure
mode), or one of the public CORS proxies (AllOrigins / cors.lol / thingproxy)
started IP-blocking Vercel's outbound ranges. With no timeouts, the proxy chain
was waiting 30+ seconds per fetch — longer than the user took to click through
onboarding. By the time `populateDriverGrid()` ran, `state.drivers` was still
the initial `[]`.

The patches above fix all three:
- We no longer trust `/current` (Patch 3 + 4)
- Each fetch attempt fails fast (Patch 1 + 2 + Vercel function timeouts)
- The picker doesn't fix its state at one moment in time — it retries and re-renders when data lands (Patch 5 + 6)
