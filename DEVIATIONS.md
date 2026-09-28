# Deviations from the Briefing Pack

This file tracks where the actual implementation diverges from the six documents in `vibe-coding-brief/`. Anything logged here either represents a practical issue (the doc's idea didn't survive contact with reality), an oversight in the docs (something the docs didn't anticipate), or a deliberate refinement during build. At the end of the build, every entry here is rolled into a `v2` revision of the relevant doc.

Format per entry:

> **[Phase X] · [affected-doc.md] · short title**
> What the doc said: …
> What we built: …
> Why: …

---

## Open Deviations

> **[Phase 3] · 06-implementation-plan.md · Shorter fallback chain for OpenF1**
> What the doc said: "For OpenF1 URLs: same chain but with `/api/openf1` first" — implying four sources like Jolpica (`/api/openf1`, then three public proxies).
> What we built: A two-source chain for OpenF1 — `/api/openf1` (with edge cache) first, then direct OpenF1 (`api.openf1.org/v1/...`). No public proxies in the OpenF1 chain.
> Why: OpenF1 already sends `Access-Control-Allow-Origin: *`, so a direct browser fetch works without any proxy. The public proxies (AllOrigins, cors.lol, thingproxy) only exist as a workaround for Jolpica's lack of CORS, and they routinely rate-limit. Adding them as fallbacks for OpenF1 would slow down the failure path without adding any reliability — direct OpenF1 is already the same network behaviour as a public-proxy hop, minus the rate-limit risk. Doc 06's wording should be tightened in v2 to make this distinction explicit.

> **[Phase 5] · 03-app-flow.md, 06-implementation-plan.md · Race weekend detection bridges two APIs**
> What the doc said: The state machine in `detectWeekendState()` "queries OpenF1's `/sessions` endpoint for the current weekend's meeting" — implying we can ask OpenF1 directly for "the current meeting."
> What we built: A two-step join — first fetch the schedule from Jolpica (`current.json`) to find the target race, then fetch OpenF1 sessions for the current year and filter to those within ±5 days of the target race date. The state (LIVE / PRE-SESSION / DEFAULT) is then determined from the filtered sessions.
> Why: OpenF1 has no "current meeting" concept — `/meetings` and `/sessions` are date-stamped, but selecting "the right one" requires anchoring to a calendar that knows what "next race" means, and Jolpica's schedule is the cleanest source for that. The two-API join lets the dashboard correctly identify which OpenF1 sessions belong to "this weekend" even between races. Doc 03 and 06 should be updated in v2 to describe the actual join.

> **[Phase 5] · 06-implementation-plan.md · "±2 hours buffer" was ambiguous**
> What the doc said: App Flow says "current time is within ±2 hours of a session's official start/end window" — could be read as 2h before start AND 2h after end. Implementation plan says only "PRE-SESSION if any session starts within the next 2 hours."
> What we built: Strictly the Implementation Plan's reading. LIVE = `now ∈ [date_start, date_end]`. PRE-SESSION = `0 < (date_start − now) ≤ 2h`. POST-SESSION (the symmetric `now − date_end ≤ 2h`) is not implemented — the dashboard simply falls back to DEFAULT once a session ends, and the Cool-Down Lap section naturally updates as new race results land.
> Why: A post-session "freshly finished" state would have been a fourth UI variant for little incremental value — the Cool-Down Lap card already shows the most recent race's podium within minutes of completion. Doc 03's wording should be tightened in v2 to remove the misleading `±` and match the Impl Plan's forward-only logic, or vice versa if we decide to add POST-SESSION.

> **[Phase 6] · 05-schema.md, 04-uiux-brief.md · Worm plot end-labels use 3-letter code, fallback to family-name slice**
> What the doc said: Schema doesn't specify the label format. UI/UX brief says "driver labels are at the end of each line" without saying what the label is.
> What we built: Each end label is the driver's broadcast `code` field (e.g. "LEC", "VER"). If `code` is missing (older drivers in archival data sometimes don't have one), we fall back to the first 3 letters of `familyName` uppercased.
> Why: The 3-letter acronym is what broadcast graphics use, matches our team-color stripe convention elsewhere, and stays readable at the small font size. Worth documenting in v2 of doc 04.

## Resolved Deviations

> **[Phase 4] · 05-schema.md · `team` field is the display name, not constructorId**
> What the doc said: Schema lists `team: string` in `pitwall.profile.v2` with example "Ferrari" — display name.
> What we built: As specified — `team` is the display name. But this caused a downstream friction: when we want to highlight "your constructor's row" in the Constructors' Cup, matching `profile.team === s.Constructor.name` is fragile across Jolpica's various ways of spelling teams over a season (e.g. "Sauber" vs "Kick Sauber"). The current build does match by name, but it should match by `constructorId` for robustness.
> Why: We're keeping the match-by-name behaviour for now because adding `constructorId` to the saved profile requires re-onboarding everyone, which the current build doesn't migrate gracefully. v2 of the schema should add `constructorId: string` to the profile shape and the Constructor row highlight should switch to that field. The previous-build profiles will need a one-time read-only fallback or a migration that pulls the constructorId from the existing driverId.
> Resolution: the driver picker now also saves `constructorId` to the profile, and the Constructors' Cup highlight matches on it. Profiles saved before this change have no `constructorId` and fall back to matching by name until the user re-picks via `/ edit profile`.
