---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/components/AccountHealth.tsx"]
---

# Dashboard (web/src/App.tsx) — surface brief

Scope: the whole authenticated dashboard (shell, Overview, Accounts + detail, Posts, Activity, Settings) and login. Mode: Operate.
Audience/job: the single self-hosting admin; check mirror health/delay, add/edit accounts, debug failures. 60–80 accounts.
Constraints: minimal and useful; light/dark follows OS by default (manual override kept); keep every existing function, route and permission check.
Memorable moment: the routes list where a late mirror's transit bar runs long and red while on-time ones are a dot-to-dot tick.
Unresolved: product mark (no logo exists; placeholder T2B tile removed).

## Direction contract

THESIS: Every mirror is a forwarding route and the dashboard reads transit time first. Refuses the KPI-card-grid admin default (stat tiles + card wall) that the incumbent ships.

OWN-WORLD: Aerogramme pale-blue paper ground in light, postal-navy ground in dark; airmail blue as the single brand/action colour; cancellation-ink red reserved for late/failed; amber for slow. All neutrals from one blue-tinted ramp. Hairline rules, not filled cards; small radius; one sans family with tabular figures.

STORY: Admin lands, sees how many routes are late and the average transit, scans the late routes at the top, opens one to recheck/unjam, or switches to Accounts to add/edit. Healthy routes stay quiet.

FIRST VIEWPORT: Left rail (wordmark, Overview/Accounts/Posts/Activity/Settings, theme + user at foot). Header: page title, one-line route summary (N routes · N late · avg transit), Run now + Add account on the right. Then running jobs as a compact single strip, then the routes table: source → Bluesky handle, transit bar, avg/worst, last post, cadence; sorted slowest first, late rows grouped on top.

FORM: Airmail Forwarding (assigned, position 5 of 7). seed:070bce1afd9972c8
Raises: one tonal ramp (Exposure Record); essentials-first rows with detail on focus (Title Card Wall); hairline rules instead of boxes (Centre-Rail); one family every size (Bitmap Specimen); post volume as size-ramped dot (Star Atlas).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
