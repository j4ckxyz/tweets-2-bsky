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

Prerequisite: Docker Desktop (macOS/Windows) or Docker Engine (Linux).

Start with the included compose file:

```bash
docker compose up -d
```

Open `http://localhost:3000`.

If you prefer `docker run`:

```bash
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  j4ckxyz/tweets-2-bsky:latest
```

Important: keep a persistent volume (`-v tweets2bsky_data:/app/data`) so mappings/history survive container recreation.

Useful Docker commands:

```bash
docker logs -f tweets-2-bsky
docker exec -it tweets-2-bsky bun dist/cli.js status
docker stop tweets-2-bsky
docker start tweets-2-bsky
```

Update Docker deployment:

```bash
docker pull j4ckxyz/tweets-2-bsky:latest
docker stop tweets-2-bsky
docker rm tweets-2-bsky
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  j4ckxyz/tweets-2-bsky:latest
```

Alternative image: `ghcr.io/j4ckxyz/tweets-2-bsky:latest`.

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

Upgrading from an older version needs no manual steps: the queue table is created automatically on first boot and existing history is untouched (Docker users keep the same `data` volume; source installs just run `./update.sh`).

## Built-in PDS Mode (Optional)

Instead of creating Bluesky accounts by hand, tweets-2-bsky can run its own AT Protocol PDS (personal data server). Every mirrored Twitter account then gets a Bluesky account created **automatically** as `[twitterhandle].yourdomain.com` — no signup, no app passwords, no email verification (a placeholder email is marked verified directly in the PDS database, backdated 30 days).

Requirements:

- A server with a **public IP** and a domain you control.
- DNS `A` records for both `@` and `*` (wildcard) pointing at the server.
- Ports 80/443 reachable for TLS (a ready-to-use Caddyfile is generated for you).
- Node.js 22+ installed alongside Bun (the PDS runs as a Node child process; its dependency tree does not load under Bun). The Docker image already includes it.

Setup is PDS-first, then walks you through the tweets-2-bsky side:

```bash
bun run cli -- setup-pds
```

The wizard validates the hostname, checks your DNS, generates and stores PDS secrets in `.env`, writes `data/pds/Caddyfile`, starts the PDS, prompts for Twitter cookies and the check interval, and then asks for Twitter usernames to mirror — each one is provisioned live (invite code → account → verified email → bot label → profile mirror) with progress streamed to the terminal, ending with an optional streamed backfill of recent tweets.

Add more accounts at any time:

```bash
bun run cli -- add-pds-account jack someotheruser
```

After setup, `bun start` runs everything together: the PDS starts first, then the mirror scheduler and dashboard. Regular (non-PDS) operation is completely unaffected — mappings pointing at `bsky.social` or any other service keep working, and both kinds can coexist.

### Network exposure

The PDS listens on **127.0.0.1 only**. `@atproto/pds` itself binds `0.0.0.0`, which on a public-IP server would serve the whole PDS — including logins — over unencrypted HTTP and bypass the TLS proxy entirely; tweets-2-bsky overrides the bind address to prevent that. Only ports 80 and 443 ever need to be open.

Because of this, your reverse proxy has to reach loopback, so run Caddy on the host or with `--network host`. If it genuinely cannot (a bridge-networked container, a proxy on another machine), set `PDS_BIND_HOST=0.0.0.0` in `.env` — and then **firewall the PDS port yourself**, e.g. `sudo ufw deny 3010/tcp`. Under Docker Compose, prefer publishing it to host loopback instead: uncomment the `127.0.0.1:3010:3010` port mapping and `PDS_BIND_HOST` in `docker-compose.yml`.

### Notes

- PDS data lives in `data/pds/` (accounts, blobs, `pds.log`). Backups of `data/` cover it. Together with `.env`, that directory is now the **only** copy of credentials for real accounts — the generated passwords are not recoverable from anywhere else, so treat both as secrets and back them up.
- Signups on your PDS still require invite codes, so strangers cannot register on your server; the wizard mints a single-use code per account internally.
- Twitter underscores become hyphens in handles (DNS labels cannot contain `_`): `some_user` → `some-user.yourdomain.com`.
- Handle labels must be 3–18 characters, an AT Protocol rule. Twitter's 15-character cap covers the upper bound, but legacy 1–2 character usernames cannot be mirrored to the built-in PDS; use a manually created account for those.
- Each account's email is a placeholder like `someuser@yourdomain.com` that **does not receive mail** — verification is written straight into the PDS database instead. The PDS's own password-reset and email-change flows therefore cannot work for these accounts; rotate credentials with `add-pds-account`, which resets the password through the admin API.
- If a Twitter account is already mirrored somewhere else (e.g. a `bsky.social` account), `add-pds-account` will spot the clash and ask, rather than silently creating a second mirror that double-posts every tweet.
- If the PDS crashes while `bun start` is running, it is restarted automatically with exponential backoff (1s up to 60s); check `data/pds/pds.log`.
- PDS dependencies install on first use into `pds-service/node_modules` (via npm, kept separate from the main app on purpose). The Docker image bakes them in at build time.
- For a local run without a domain, use a `.test` hostname such as `t2b.test`. Plain `localhost` does **not** work — the AT Protocol rejects handles under `.localhost`, and `@atproto/pds` restricts a `localhost` hostname to `.test` handles anyway. The wizard rejects unusable hostnames up front.
- There is a smoke test for the whole flow, but note that provisioning an account registers a **permanent** `did:plc` on the public, append-only `plc.directory` registry. It therefore refuses to run unless you opt in: `T2B_PDS_TEST_ALLOW_PLC=1 bun run test:pds`.

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

## Troubleshooting

See `TROUBLESHOOTING.md`.

Common native module recovery:

```bash
bun run rebuild:native
bun run build
bun run start
```

## License

MIT
