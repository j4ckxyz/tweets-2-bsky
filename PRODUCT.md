# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primarily one person: the self-hosting admin who runs the instance. Other user accounts exist in the code (per-user permissions for managing own/all mappings, groups, backfills, run-now) but are rare in practice. The admin opens the dashboard to:

1. Check health and mirror delay — is every mirror keeping up, which ones are broken or lagging.
2. Add or edit accounts — map new Twitter/X accounts to Bluesky accounts, tweak per-account settings.
3. Debug a failure — activity logs, failed queue, rechecks, unjam, cache clears.

Browsing mirrored posts is secondary.

## Product Purpose

tweets-2-bsky mirrors Twitter/X accounts to Bluesky: it reads tweets via `@the-convocation/twitter-scraper` using the admin's cookies, posts them with `@atproto/api` (threads, images, video, link cards), and tracks history in SQLite to avoid duplicates. A scheduler polls continuously; the dashboard can trigger a run. Success: every mirror posts within minutes of the source tweet, and when one doesn't, the admin can see which and why in seconds.

## Positioning

A self-hosted, single-instance mirror operator running dozens of bot-labelled mirror accounts (currently ~64, target ~80) under a shared handle domain, with per-account health, delay tracking, and recovery tools — not a one-account crossposter.

## Operating Context

- Runs as Docker or a PM2/Bun process; dashboard served by the same Express server on port 3000.
- Admin checks it from a desktop browser and from a phone.
- Scale: 60–80 mapped accounts; lists and health views must stay usable at that size.
- Terminology in use: mapping/account, mirror, source (Twitter) handle, Bluesky handle, run now, backfill, recheck, unjam, pacing, sweep, group, discovery, bot label.

## Capabilities and Constraints

- Tabs today: Overview, Accounts (+ account detail route `/accounts/<id>`), Posts, Activity, Settings.
- Multi-user auth with JWT; admin-only sections (users, runtime version/update status).
- Theme: light, dark, and follow-system; follow-system is the default.
- Stack: React 19 + Vite + Tailwind 3 + lucide-react, built into `web/dist`.
- No product logo exists; the "T2B" tile in the sidebar is a placeholder the admin dislikes.

## Brand Commitments

- Must stay minimal and useful: a working tool, not a showcase.
- Light and dark mode both first-class, following the OS automatically.

## Evidence on Hand

- Real data lives only on the running instance; no screenshots or fixtures are committed. Do not fabricate statistics in product copy.

## Product Principles

1. Problems first: lagging, failing, or misconfigured mirrors surface before anything healthy.
2. Scales to 80: every list is scannable, searchable, and sortable at 60–80 accounts.
3. Quiet by default: healthy state is calm; colour and emphasis are reserved for things that need action.
4. One place per job: health, account management, debugging, and settings each have a clear home.
