# tweets-2-bsky
This repo can also be found on Tangled at [j4ck.xyz/tweets2bsky](https://tangled.org/j4ck.xyz/tweets2bsky)

Crosspost posts from Twitter/X to Bluesky with thread support, media handling, account mapping, and a web dashboard.

## Quick Start (Recommended: Docker)

Most people should use Docker. It is the simplest setup and includes full feature parity (backend API + scheduler + frontend dashboard + Chromium).

Prerequisite: Docker Desktop (Windows/macOS) or Docker Engine (Linux). On Windows, use Docker Desktop in Linux container mode.

### 1) Run the latest image

macOS/Linux (bash):

```bash
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  j4ckxyz/tweets-2-bsky:latest
```

Windows (PowerShell):

```powershell
docker run -d --name tweets-2-bsky -p 3000:3000 -v tweets2bsky_data:/app/data --restart unless-stopped j4ckxyz/tweets-2-bsky:latest
```

Open `http://localhost:3000`.

If port `3000` is already in use, change only the first port (example: `-p 3001:3000`).

### 2) Complete first-time setup

1. Register the first user (this user becomes admin).
2. Add Twitter cookies in Settings.
3. Add at least one mapping via the guided "Add account" flow (Twitter sources -> Bluesky account -> credential validation -> verify email + create).
4. Click `Run now`.

### 3) Useful Docker commands

```bash
docker logs -f tweets-2-bsky
docker exec -it tweets-2-bsky bun dist/cli.js status
docker stop tweets-2-bsky
docker start tweets-2-bsky
```

### 4) Update to newest release

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

Alternative image registry: `ghcr.io/j4ckxyz/tweets-2-bsky:latest`.

## Source Install Quick Start (No Docker)

If you prefer running from source and do not want to manage PM2 manually, use the installer script.

### 1) Clone the repo

```bash
git clone https://github.com/j4ckxyz/tweets-2-bsky
cd tweets-2-bsky
```

### 2) Run install + background start

```bash
chmod +x install.sh
./install.sh
```

What this does by default:

- auto-installs Bun (latest stable for your platform) when missing
- auto-upgrades Bun to latest stable before install/build
- installs dependencies
- builds server + web dashboard
- creates/updates `.env` with sensible defaults (`PORT=3000`, generated `JWT_SECRET` if missing)
- starts in the background
  - uses PM2 if installed
  - otherwise uses `nohup`
- prints your local web URL (for example `http://localhost:3000`)

### Useful installer commands

```bash
./install.sh --no-start
./install.sh --start-only
./install.sh --stop
./install.sh --status
./install.sh --port 3100
./install.sh --host 127.0.0.1
./install.sh --skip-native-rebuild
```

If you prefer full manual source setup details, skip to [Manual Setup](#manual-setup-technical).

After source install starts, open `http://localhost:3000` and follow the first-time setup steps in [Quick Start](#quick-start-recommended-docker).

## Docker (Single-Container, Backend + Frontend + Scheduler)

This repo now includes a single `Dockerfile` that runs:

- the backend API
- the scheduler/worker loop
- the built frontend dashboard
- Chromium (for quote-tweet screenshot fallback support)

The container aims for feature parity with normal installs while giving one-command startup.

### 1) Pull and run (recommended)

After publishing an image (see [Publishing](#publishing-multi-platform-images-linuxamd64--linuxarm64)), run:

```bash
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  j4ckxyz/tweets-2-bsky:latest
```

Open `http://localhost:3000`.

PowerShell equivalent:

```powershell
docker run -d --name tweets-2-bsky -p 3000:3000 -v tweets2bsky_data:/app/data --restart unless-stopped j4ckxyz/tweets-2-bsky:latest
```

Alternative registry mirror: `ghcr.io/j4ckxyz/tweets-2-bsky:latest`.

### 2) Build locally (if you do not want to pull)

```bash
docker build -t tweets-2-bsky:local .

docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --restart unless-stopped \
  tweets-2-bsky:local
```

### 3) Environment variables

Pass environment values with `-e` or `--env-file` (same values as normal install):

```bash
docker run -d \
  --name tweets-2-bsky \
  -p 3000:3000 \
  -v tweets2bsky_data:/app/data \
  --env-file .env \
  j4ckxyz/tweets-2-bsky:latest
```

Common variables:

- `PORT` (default `3000`)
- `JWT_SECRET` (recommended to set explicitly)
- `JWT_EXPIRES_IN`
- `CORS_ALLOWED_ORIGINS`
- `BSKY_APPVIEW_URL` (optional override)
- `SCHEDULED_ACCOUNT_TIMEOUT_MS` (default `480000` / 8 minutes, forces a skip when one source account hangs during scheduled checks)

### 4) Persistent data inside Docker

Store all app state in `/app/data` (mounted via volume):

- `/app/data/config.json` (mappings, users, credentials)
- `/app/data/database.sqlite`
- `/app/data/.jwt-secret`

Note: inside the container, `/app/config.json` is linked to `/app/data/config.json` so one volume preserves everything important.

### 5) CLI usage in container

You can run CLI commands without leaving Docker:

```bash
docker exec -it tweets-2-bsky bun dist/cli.js status
docker exec -it tweets-2-bsky bun dist/cli.js run-now
docker exec -it tweets-2-bsky bun dist/cli.js list
```

### 6) Updating Docker deployments

For Docker installs, update by pulling a newer image and recreating the container with the same volume:

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

### 7) Debug logs (especially useful on Raspberry Pi)

If runs appear stuck, stream logs live:

```bash
docker logs -f tweets-2-bsky
```

For source installs, use whichever runtime you started with:

```bash
pm2 logs tweets-2-bsky
# or
tail -f data/runtime/nohup.out
```

If an account hangs during a scheduled cycle, the scheduler now times out that account and moves on automatically. You can tune this with `SCHEDULED_ACCOUNT_TIMEOUT_MS`.

### 8) Platform support

The Docker build is designed for multi-platform images:

- `linux/amd64` (typical Linux servers, many Windows machines)
- `linux/arm64` (Apple Silicon Macs, ARM Linux servers)

This means the same image tag can be pulled on Docker Desktop (Windows/macOS) and Linux hosts.
On Windows, use Docker Desktop in **Linux container** mode.

### Publishing (multi-platform images: linux/amd64 + linux/arm64)

Automatic publishing is included via GitHub Actions:

- `.github/workflows/docker-publish.yml` for GHCR
- `.github/workflows/docker-publish-dockerhub.yml` for Docker Hub (only runs when Docker Hub secrets are set)

- pushes to `master` or `main` publish fresh multi-arch images and update `:latest`
- tags like `v2.0.0` publish versioned tags (`:2.0.0`, `:2.0`)
- manual publish is available with **Actions -> Publish Docker Image -> Run workflow**
- after first publish, set GHCR package visibility to **Public** so anyone can pull

To enable automatic Docker Hub publishing with GitHub CLI:

```bash
gh secret set DOCKERHUB_USERNAME --body "<dockerhub-username>"
gh secret set DOCKERHUB_TOKEN --body "<dockerhub-access-token>"
```

Users can always pull the newest build with:

```bash
docker pull j4ckxyz/tweets-2-bsky:latest
```

#### Option A: GitHub Container Registry (GHCR)

```bash
docker login ghcr.io -u <github-username>
docker buildx create --name t2b-builder --use
docker buildx inspect --bootstrap

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/j4ckxyz/tweets-2-bsky:latest \
  -t ghcr.io/j4ckxyz/tweets-2-bsky:2.0.0 \
  --push .
```

Then set the GHCR package visibility to **Public** in GitHub package settings.

#### Option B: Docker Hub

```bash
docker login
docker buildx create --name t2b-builder --use
docker buildx inspect --bootstrap

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t <dockerhub-user>/tweets-2-bsky:latest \
  -t <dockerhub-user>/tweets-2-bsky:2.0.0 \
  --push .
```

Once published, users only need `docker pull` + `docker run`.

## Linux VPS Without Domain (Secure HTTPS via Tailscale)

If you host on a public VPS (Linux) and do not own a domain, use the server installer:

```bash
chmod +x install-server.sh
./install-server.sh
```

What this does:

- runs the normal app install/build/start flow
- auto-selects a free local app port if your chosen/default port is already in use
- forces the app to bind locally only (`HOST=127.0.0.1`)
- installs and starts Tailscale if needed
- configures `tailscale serve` on a free HTTPS port so your dashboard is reachable over Tailnet HTTPS
- prints the final Tailnet URL to open from any device authenticated on your Tailscale account

Optional non-interactive login:

```bash
./install-server.sh --auth-key <TS_AUTHKEY>
```

Optional fixed Tailscale HTTPS port:

```bash
./install-server.sh --https-port 443
```

Optional public exposure (internet) with Funnel:

```bash
./install-server.sh --funnel
```

Notes:

- this does **not** replace or delete `install.sh`; it wraps server-hardening around it
- normal updates still use `./update.sh` and keep your local `.env` values
- if you already installed manually, this is still safe to run later

## What This Project Does

- crossposts tweets and threads to Bluesky
- handles images, videos, GIFs, quote tweets, and link cards
- stores processed history in SQLite to avoid reposting
- supports multiple Twitter source usernames per Bluesky target
- provides both:
  - web dashboard workflows
  - CLI workflows (including cron-friendly mode)

## Requirements

Recommended runtime:

- Docker Desktop / Docker Engine

If running from source instead of Docker:

- Bun 1.x+ (auto-installed/upgraded by `install.sh` and `update.sh`)
- git

Optional but recommended for source installs:

- PM2 (for managed background runtime)
- Chrome/Chromium (used for some quote-tweet screenshot fallbacks)
- build tools for native modules (`better-sqlite3`) if your platform needs source compilation

## Manual Setup (Technical)

### Standard run (foreground)

```bash
git clone https://github.com/j4ckxyz/tweets-2-bsky
cd tweets-2-bsky
bun install
bun run build
bun run start
```

Open: [http://localhost:3000](http://localhost:3000)

### Set environment values explicitly

```bash
cat > .env <<'EOF'
PORT=3000
JWT_SECRET=replace-with-a-strong-random-secret
# Optional: auth token lifetime (jsonwebtoken format), default is 30d.
# JWT_EXPIRES_IN=30d
# Optional: comma-separated browser origins allowed to call the API.
# Leave unset to allow all origins (default/backward-compatible).
# CORS_ALLOWED_ORIGINS=https://your-tailnet-host.ts.net,https://localhost:3000
EOF
```

### Rebuild native modules

```bash
bun run rebuild:native
bun run build
```

## First-Time Setup via CLI (Alternative to Web Forms)

```bash
bun run cli -- setup-twitter
bun run cli -- add-mapping
bun run cli -- run-now
```

`add-mapping` now runs a guided onboarding flow:

1. enter one or more Twitter source usernames
2. create Bluesky account (or use existing)
3. enter Bluesky identifier + app password (+ optional custom PDS URL)
4. verify email, then create mapping and auto-sync profile metadata from Twitter

## Recommended Command Examples

Always invoke CLI commands as:

```bash
bun run cli -- <command>
```

### Status and basic operations

```bash
bun run cli -- status
bun run cli -- list
bun run cli -- recent-activity --limit 20
```

### Credentials and configuration

```bash
bun run cli -- setup-twitter
bun run cli -- setup-ai
bun run cli -- set-interval 5
```

### Mapping management

```bash
bun run cli -- add-mapping
bun run cli -- sync-profile <mapping-id-or-handle> --source <twitter-username>
bun run cli -- edit-mapping <mapping-id-or-handle>
bun run cli -- remove <mapping-id-or-handle>
```

### Running syncs

```bash
bun run cli -- run-now
bun run cli -- run-now --dry-run
bun run cli -- run-now --web
```

### Backfill and history import

```bash
bun run cli -- backfill <mapping-id-or-handle> --limit 50
bun run cli -- import-history <mapping-id-or-handle> --limit 100
bun run cli -- clear-cache <mapping-id-or-handle>
```

### Dangerous operation (admin workflow)

```bash
bun run cli -- delete-all-posts <mapping-id-or-handle>
```

### Config export/import

```bash
bun run cli -- config-export ./tweets-2-bsky-config.json
bun run cli -- config-import ./tweets-2-bsky-config.json
```

Mapping references accept:

- mapping ID
- Bluesky handle/identifier
- Twitter username

## Cron / CLI-Only Operation

Run every 5 minutes:

```cron
*/5 * * * * cd /path/to/tweets-2-bsky && /usr/local/bin/bun run cli -- run-now >> /tmp/tweets-2-bsky.log 2>&1
```

Run one backfill once:

```bash
bun run cli -- backfill <mapping-id-or-handle> --limit 50
```

## Background Runtime Options

### Option A: use `install.sh` (recommended)

```bash
./install.sh
./install.sh --status
./install.sh --stop
```

### Option B: manage PM2 directly

```bash
pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
pm2 logs tweets-2-bsky
pm2 restart tweets-2-bsky --update-env
pm2 save
```

Do not use `--interpreter bun` with `dist/index.js` on PM2 installs that cannot `require()` async ESM modules. Use Bun as the process command instead (example above).

### PM2 migration help (older manual installs)

If you manually created PM2 processes on older versions, migrate once to the Bun binary launcher:

```bash
pm2 delete tweets-2-bsky || true
pm2 delete twitter-mirror || true
pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
pm2 save
```

If your existing process must keep the legacy name:

```bash
pm2 start "$HOME/.bun/bin/bun" --name twitter-mirror --cwd "$PWD" -- dist/index.js
```

### Option C: no PM2 (nohup)

```bash
mkdir -p data/runtime
nohup bun run start > data/runtime/tweets-2-bsky.log 2>&1 &
echo $! > data/runtime/tweets-2-bsky.pid
```

Stop nohup process:

```bash
kill "$(cat data/runtime/tweets-2-bsky.pid)"
```

## Updating

Use:

```bash
./update.sh
```

`update.sh`:

- stashes local uncommitted changes before pull and restores them after update
- pulls latest code (supports non-`origin` remotes and detached-head recovery)
- ensures Bun is installed and upgraded to latest stable
- installs dependencies
- rebuilds native modules when runtime/dependencies changed
- builds server + web dashboard
- restarts existing runtime for PM2 **or** nohup mode
- normalizes PM2 runtime to Bun binary launcher mode (avoids Bun interpreter crash loops on some PM2 builds)
- preserves local `config.json` and `.env` with backup/restore

Useful update flags:

```bash
./update.sh --no-restart
./update.sh --skip-install --skip-build
./update.sh --remote origin --branch main
```

## Data, Config, and Security

Local files:

- `config.json`: mappings, credentials, users, app settings (sensitive; do not share)
- `data/database.sqlite`: processed tweet history and metadata
- `data/.jwt-secret`: auto-generated local JWT signing key when `JWT_SECRET` is not set (sensitive; keep private)
- `.env`: runtime environment variables (`PORT`, `JWT_SECRET`, `JWT_EXPIRES_IN`, optional overrides)

Security notes:

- first registered dashboard user is admin
- after bootstrap, only admins can create additional dashboard users
- users can sign in with username or email
- non-admin users only see mappings they created by default
- admins can grant fine-grained permissions (view all mappings, manage groups, queue backfills, run-now, etc.)
- only admins can view or edit Twitter/AI provider credentials
- admin user management never exposes other users' password hashes in the UI
- if `JWT_SECRET` is missing, server generates and persists a strong secret in `data/.jwt-secret` so sessions survive restarts
- set `JWT_SECRET` in `.env` if you prefer explicit secret management across hosts
- auth tokens default to `30d` expiry (`JWT_EXPIRES_IN`), configurable via `.env`
- auth endpoints (`/api/login`, `/api/register`) are rate-limited per IP to reduce brute-force risk
- prefer Bluesky app passwords (not your full account password)

### Multi-User Access Control

- bootstrap account:
  - the first account created through the web UI becomes admin
  - open registration is automatically disabled after this
- admin capabilities:
  - create, edit, reset password, and delete dashboard users
  - assign role (`admin` or `user`) and per-user permissions
  - filter the Accounts page by creator to review each user's mappings
- deleting a user:
  - disables that user's mappings so crossposting stops
  - leaves already-published Bluesky posts untouched
- self-service security:
  - every user can change their own password
  - users can change their own email after password verification

## Development

### Start backend/scheduler from source

```bash
bun run dev
```

### Start Vite web dev server

```bash
bun run dev:web
```

### Build and quality checks

```bash
bun run build
bun run typecheck
bun run lint
```

## Troubleshooting

See: `TROUBLESHOOTING.md`

Common recovery when native modules fail to load:

```bash
bun run rebuild:native
bun run build
bun run start
```

## License

MIT
