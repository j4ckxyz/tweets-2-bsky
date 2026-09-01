# tweets-2-bsky

Cross-post from Twitter/X to Bluesky with thread support, media handling, account mapping, and a web dashboard.

This repo is also mirrored on Tangled: [j4ck.xyz/tweets2bsky](https://tangled.org/j4ck.xyz/tweets2bsky)

## How It Works (Simple)

1. You connect one or more Twitter/X source accounts to a Bluesky account.
2. The app reads tweets from X using `@the-convocation/twitter-scraper` with your cookies (`auth_token` + `ct0`).
3. It posts to Bluesky using the official AT Protocol client (`@atproto/api`).
4. It tracks what was already posted in SQLite so it does not repost duplicates.
5. A scheduler runs automatically, and you can also trigger `Run now` from the dashboard or CLI.

## Installation (Pick One Path)

Use either:

- Docker (recommended)
- Source install (PM2 or manual runtime)

Do not do both on the same machine unless you intentionally want two separate deployments.

### Option A: Docker (Recommended)

Prerequisites: `git`, and Docker Desktop (macOS/Windows) or Docker Engine (Linux).

Build the image from your own clone, so what runs is the code in this repo:

```bash
git clone https://github.com/j4ckxyz/tweets-2-bsky
cd tweets-2-bsky
docker compose up -d --build
```

Open `http://localhost:3000`.

Important: keep the persistent volume (`tweets2bsky_data`, already declared in
`docker-compose.yml`) so mappings and post history survive container recreation.

Useful Docker commands:

```bash
docker compose logs -f
docker compose exec tweets-2-bsky bun dist/cli.js status
docker compose stop
docker compose start
```

Update a Docker deployment — pull the code, rebuild, restart:

```bash
git pull
docker compose up -d --build
```

If you prefer `docker run` over compose, build the image first:

```bash
docker build -t tweets-2-bsky:local .
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  tweets-2-bsky:local
```

Prebuilt images are also published to `ghcr.io/j4ckxyz/tweets-2-bsky:latest` and
`j4ckxyz/tweets-2-bsky:latest`. Building locally is recommended instead: it is
the only way to be certain you are running the current code, and it needs no
registry availability.

### Option B: Source Install (PM2 or Manual)

Prerequisites:

- `git`
- Bun 1.x+ (the installer auto-installs/upgrades Bun when needed)
- PM2 (optional, but recommended for background runtime)

Clone and install:

```bash
git clone https://github.com/j4ckxyz/tweets-2-bsky
cd tweets-2-bsky
chmod +x install.sh
./install.sh
```

`install.sh` does install/build/start and uses:

- PM2 when PM2 is available
- `nohup` when PM2 is not installed

Useful installer commands:

```bash
./install.sh --status
./install.sh --stop
./install.sh --start-only
./install.sh --no-start
./install.sh --port 3100
```

#### PM2 Manual Runtime (if you want direct PM2 control)

```bash
bun install
bun run build
pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
pm2 logs tweets-2-bsky
pm2 save
```

#### Manual Foreground Runtime (no PM2)

```bash
bun install
bun run build
bun run start
```

#### Manual Nohup Runtime (no PM2)

```bash
mkdir -p data/runtime
nohup bun run start > data/runtime/tweets-2-bsky.log 2>&1 &
echo $! > data/runtime/tweets-2-bsky.pid
```

Stop nohup process:

```bash
kill "$(cat data/runtime/tweets-2-bsky.pid)"
```

## First-Time Setup (After Install)

1. Open `http://localhost:3000`.
2. Register the first user (this account becomes admin).
3. In Settings, add Twitter cookies (`auth_token`, `ct0`; backup pair optional).
4. Add a mapping (Twitter source usernames -> Bluesky account).
5. Click `Run now`.

## Twitter/X Integration Notes

- This project does not use Twitter's paid official API.
- It uses `@the-convocation/twitter-scraper` and authenticated browser cookies to read account/tweet data.
- Required cookies: `auth_token` and `ct0`.
- If cookies expire, update them in Settings.
- Keep cookies private; they are sensitive credentials.

For some quote-tweet screenshot fallbacks, Chromium is used (bundled in Docker, optional dependency for source installs).

## Crossposting Pipeline (Fetch Sweep + Post Queue)

The daemon splits each cycle into two independent halves so posting never delays detection:

1. **Fetch sweep** (Twitter side): every enabled source account's timeline is checked on the configured interval. All Twitter calls go through one global rate limiter, so the request rate to Twitter is the same no matter how many accounts post at once. New tweets are written to a durable queue (`post_queue` table in `data/database.sqlite`).
2. **Post workers** (Bluesky side): several accounts post from the queue in parallel (one worker per mapping, so threads stay in order). A slow video upload or long thread on one account never blocks the others.

The queue survives restarts: anything mid-flight when the process dies is re-armed on boot, and duplicates are impossible because the queue and the processed-history table share the same tweet-id key. Tweets that repeatedly fail to post are parked as `failed` (visible in the dashboard, with admin Retry/Clear buttons) instead of retrying forever.

The dashboard's queue numbers read straight from SQLite, so what you see queued is exactly what will post.

Tuning (optional `.env` values, sensible defaults built in):

| Variable | Default | Meaning |
|---|---|---|
| `SCRAPER_MIN_GAP_MS` / `SCRAPER_JITTER_MS` | `800` / `400` | Global minimum gap (+ random jitter) between Twitter API calls. The one knob that controls scraper-account risk. |
| `FETCH_CONCURRENCY` | `4` | Parallel timeline fetches during a sweep (rate still bounded by the gap above). |
| `POST_WORKER_CONCURRENCY` | `5` | How many Bluesky accounts post from the queue at once. |
| `POST_PACING_MIN_MS` / `POST_PACING_MAX_MS` | `3000` / `8000` | Pause between posts within one account (cosmetic pacing; per-account only). |
| `QUEUE_MAX_ATTEMPTS` | `8` | Retries (with exponential backoff) before a tweet is parked as failed. |
| `SWEEP_FETCH_TIMEOUT_MS` | `180000` | Watchdog for a single account's timeline fetch. |
| `SCRAPER_REQUEST_TIMEOUT_MS` | `25000` | Deadline for one HTTP request to Twitter. Fails fast so a hung request retries instead of holding a fetch slot until the watchdog above fires. |
| `ADAPTIVE_POLLING` | `1` | Check quiet accounts less often (see below). Set to `0` to check every account on every sweep. |
| `QUEUE_FAILED_RETENTION_DAYS` | `14` | How long parked failures stay visible before being pruned. |

**Adaptive polling.** Accounts are not all worth checking equally often, so each one earns a minimum interval from how recently it last posted: an active account (posted within 6 hours) is checked every sweep, then 10 minutes for the last day, 30 minutes for the last week, and hourly beyond that. Nothing is starved — the coldest tier still has an hourly ceiling, a newly added account starts in the hot tier so its first tweet mirrors immediately, and a single new tweet promotes an account straight back to the top. This keeps the sweep short for the accounts that are actually posting, which is what mirror delay depends on. Set `ADAPTIVE_POLLING=0` to check everything every sweep.

A tweet is stamped with its Bluesky URI the moment the post is accepted, before any other bookkeeping. If the process dies (or the database is busy) between publishing and recording, the queue repairs the record from that stamp instead of re-posting — so a post that is live on Bluesky can never show up as "failed", and a retry can never duplicate it.

Upgrading from an older version needs no manual steps: the queue table is created automatically on first boot and existing history is untouched (Docker users keep the same `data` volume; source installs just run `./update.sh`).

## Logs and Diagnostics

Every stage of the pipeline writes a structured entry to a queryable log stored alongside the rest of the data in `data/database.sqlite`. Console output is unchanged, so `pm2 logs` and `docker logs -f` still work as before — the stored copy is what the dashboard reads.

In the dashboard, **Activity** has three views:

- **Migration outcomes** — what was mirrored, skipped or failed, per tweet.
- **System log** — the full event stream, filterable by level, pipeline stage, account, tweet id or free text. Expand any row for the underlying error: HTTP status, provider error code, cause chain and stack.
- **Failed queue** — parked tweets grouped by reason, with attempt counts and the stage each one failed at.

From the System log you can **Copy** the current selection to the clipboard, or **Download** it as plain text, JSON, NDJSON or CSV. Admins also get a **full diagnostics bundle**: one JSON file containing recent logs, the live queue state, grouped failure reasons and a redacted configuration summary — the right thing to attach to a bug report.

Credentials (app passwords, `auth_token`, `ct0`, JWTs) are redacted before anything is written, so exports are safe to share.

Retention is bounded by age and row count, and pruned automatically:

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_LOG_RETENTION_DAYS` | `30` | Maximum age of a stored log entry. |
| `EVENT_LOG_MAX_ROWS` | `250000` | Hard row cap; oldest entries drop first. |
| `EVENT_LOG_LEVEL` | `debug` | Minimum level recorded. `info` cuts volume noticeably. |
| `EVENT_LOG_FLUSH_MS` | `400` | Write-buffer interval. `0` writes synchronously. |

API endpoints behind the same auth as the rest of the dashboard, scoped to the mappings the caller can see:

```text
GET    /api/logs?level=warn,error&stage=post&q=<text>&limit=200
GET    /api/logs/stats
GET    /api/logs/tweet/:twitterId      # everything recorded about one tweet
GET    /api/logs/export?format=txt|json|ndjson|csv
GET    /api/logs/diagnostics           # admin: full bundle
GET    /api/queue/failures             # parked tweets, grouped by reason
DELETE /api/logs                       # admin
```

## CLI Quick Commands

Always run CLI commands as:

```bash
bun run cli -- <command>
```

Common commands:

```bash
bun run cli -- status
bun run cli -- list
bun run cli -- run-now
bun run cli -- run-now --dry-run
bun run cli -- add-mapping
bun run cli -- backfill <mapping-id-or-handle> --limit 50
```

## Updating

Source installs:

```bash
./update.sh
```

Useful flags:

```bash
./update.sh --no-restart
./update.sh --skip-install --skip-build
```

Docker installs:

```bash
git pull
docker compose up -d --build
```

The `tweets2bsky_data` volume is untouched by a rebuild, so mappings, users and
post history carry over.

## Data and Security

Important files:

- `config.json` (mappings, credentials, users)
- `data/database.sqlite` (processed history)
- `data/.jwt-secret` (generated signing key when `JWT_SECRET` is unset)
- `.env` (runtime env values)

Security basics:

- First registered user becomes admin.
- Prefer Bluesky app passwords instead of your full Bluesky password.
- Set an explicit `JWT_SECRET` in `.env` for predictable secret management.
- Keep `config.json`, cookie values, and `.env` private.

## Development

```bash
bun run dev
bun run dev:web
bun run build
bun run typecheck
bun run lint
```

`bun run build` and `bun run typecheck` cover both the server and the web
dashboard.

Offline tests (no network, no real database — each uses a throwaway data dir):

```bash
bun run test:scraper-fetch    # request timeout + retry classification
bun run test:text-split       # post splitting and thread chunking
bun run test:mirror-lag       # per-account mirror delay statistics
bun run test:polling          # adaptive polling tiers and activity bookkeeping
bun run test:video-limits     # Bluesky video size/duration ceilings
bun run test:account-health    # account outage detection and backoff
```

## Troubleshooting

See `TROUBLESHOOTING.md`.

Common native module recovery:

```bash
bun run rebuild:native
bun run build
bun run start
```

## Releasing

Releases are cut from a version tag. Bump `version` in `package.json`, commit,
then:

```bash
bun run release:tag
```

That tags the version and pushes it, which starts the `Release` workflow: it
builds, type-checks, runs the offline tests, verifies the tag matches
`package.json`, and publishes a GitHub release with generated notes. The Docker
workflows build images for the same tag, so releases and images stay in step.

## License

MIT
