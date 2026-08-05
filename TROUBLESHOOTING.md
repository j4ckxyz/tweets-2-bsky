# tweets-2-bsky

A powerful tool to crosspost Tweets to Bluesky, supporting threads, videos, and high-quality images.

## Troubleshooting

### Start here: the log viewer

Nearly every question below can be answered from **Activity → System log** in the
dashboard. Every step of the pipeline writes a structured entry there with the
reason behind its outcome, and each entry can be expanded to show the underlying
error (HTTP status, provider error code, stack) and the context it happened in.

- Filter by level (`Errors only`), stage (`post`, `media`, `bluesky`, `queue`, …),
  or search for a handle, tweet id or error text.
- **Copy** puts the currently filtered entries on your clipboard.
- **Download** saves them as `.log`, JSON, NDJSON or CSV.
- Admins also get **Full diagnostics bundle** — one JSON file with recent logs,
  the queue state, grouped failure reasons and a redacted config summary. That is
  the single most useful thing to attach to a bug report.

Credentials are redacted before anything is written, so exports are safe to share.

### The dashboard says tweets "failed" but I can see them on Bluesky

This was possible in versions before 2.1: a tweet could be published, but if the
process died, the database was locked, or the batch watchdog fired before the
"we posted this" record was written, the queue concluded the post had never
happened. It retried, and after eight attempts parked it as failed.

The queue now stamps each row with its Bluesky URI the instant the post is
accepted, before any other bookkeeping. Anything holding a stamp is repaired
from that stamp instead of being re-posted, at startup and every six hours.

If you are upgrading with a backlog of these:

1. Restart the app. The startup reconciliation pass repairs anything that is
   already live and clears it out of the failed count.
2. For whatever remains, open **Activity → Failed queue**. Failures are grouped
   by reason, so you can see at a glance whether you are looking at one broken
   account or 300 unrelated problems.
3. Use **Retry all** for transient causes (rate limits, network), or **Clear all**
   to discard them.

### A queue number never seems to move

`pending` used to cover both "about to post" and "serving a retry backoff", and a
backoff can be up to six hours. The dashboard now shows them separately —
`N ready` versus `N waiting to retry (next 42m ago)` — so a stalled-looking
number is either genuinely stuck or just waiting, and you can tell which.

### Everything for one account fails

Look for `login.failed` in the log. The message names the actual cause:

- **HTTP 401** — the app password is wrong or was revoked. Generate a new one in
  Bluesky settings and update the mapping.
- **AuthFactorTokenRequired** — the account has 2FA on; use an app password, not
  the account password.
- **HTTP 429** — Bluesky is rate limiting sign-ins; it recovers by itself.

Tweets are never parked as failed for this reason: a batch that stops before a
tweet is attempted returns it to the queue without spending an attempt, backing
off progressively (30s up to 15m) while the problem persists.

### Log storage and tuning

Logs live in the same SQLite database as everything else, capped by both age and
row count, and pruned automatically.

| Variable | Default | Meaning |
|---|---|---|
| `EVENT_LOG_RETENTION_DAYS` | `30` | Maximum age of a stored log entry. |
| `EVENT_LOG_MAX_ROWS` | `250000` | Hard row cap; oldest entries are dropped first. |
| `EVENT_LOG_LEVEL` | `debug` | Minimum level recorded. Set to `info` to cut volume. |
| `EVENT_LOG_FLUSH_MS` | `400` | Write-buffer interval. `0` writes synchronously. |
| `QUEUE_FAILED_RETENTION_DAYS` | `14` | How long parked failures stay visible. |

### Update Failures / Git Conflicts
If `./update.sh` fails with "Pulling is not possible because you have unmerged files" or similar git errors:

1. Reset your local repository to match the remote (Warning: this discards local changes to tracked files):
   ```bash
   git reset --hard origin/master
   ```
2. Run the update script again:
   ```bash
   ./update.sh
   ```

### PM2 interpreter mismatch
If PM2 logs show command/runtime errors after an update (for example stale interpreter paths):

Common error signature:

```text
TypeError: require() async module ".../dist/index.js" is unsupported. use "await import()" instead.
```

1. Run the repair script:
   ```bash
   chmod +x repair_pm2.sh
   ./repair_pm2.sh
   ```
2. If needed, manually recreate PM2 with Bun as the process command:
   ```bash
   pm2 delete tweets-2-bsky || true
   pm2 delete twitter-mirror || true
   pm2 start "$HOME/.bun/bin/bun" --name tweets-2-bsky --cwd "$PWD" -- dist/index.js
   pm2 save
   ```
3. Old crash lines remain in PM2 logs until log rotation/flush. Clear them if needed:
   ```bash
   pm2 flush
   ```

### `bun: command not found`
If Bun is missing on a source install host:

1. Run either installer/updater once (they auto-install and auto-upgrade Bun to latest stable):
   ```bash
   ./install.sh --no-start
   # or
   ./update.sh --no-restart
   ```

### Native module load failure (`ERR_DLOPEN_FAILED`)
If startup fails while loading native dependencies:

1. Reinstall/rebuild native dependencies with Bun:
   ```bash
   bun run rebuild:native
   ```
2. Rebuild and start:
   ```bash
   bun run build
   bun run start
   ```

### Dashboard appears unstyled / plain text UI
If the app loads but looks mostly unstyled:

1. Rebuild web assets:
   ```bash
   bun run build
   ```
2. Restart server:
   ```bash
   bun run start
   ```
3. Hard refresh browser cache (`Cmd+Shift+R` on macOS).

### CLI command not recognized
When using Bun scripts, pass CLI args after `--`:

```bash
bun run cli -- status
```

### Scheduler appears stuck on one account
If a single source account hangs for a long time (media fetch/processing), scheduled checks now skip that account after a timeout and continue with the next one.

- Default timeout: `1200000` ms (20 minutes) for scheduled checks, `900000` ms (15 minutes) per account for backfills
- Override with env vars: `SCHEDULED_ACCOUNT_TIMEOUT_MS` / `BACKFILL_ACCOUNT_TIMEOUT_MS`
- Note: the pipeline intentionally paces 5–15s between posts, so don't set these too low — a 15-tweet backfill normally takes a few minutes.

Examples:

```bash
# Docker
docker run -d --name tweets-2-bsky -e SCHEDULED_ACCOUNT_TIMEOUT_MS=300000 -p 3000:3000 -v tweets2bsky_data:/app/data j4ckxyz/tweets-2-bsky:latest

# Source install (.env)
echo 'SCHEDULED_ACCOUNT_TIMEOUT_MS=300000' >> .env
./update.sh
```

To watch logs while debugging on Raspberry Pi:

```bash
docker logs -f tweets-2-bsky
# or for source/PM2
pm2 logs tweets-2-bsky
```

### Docker: permissions writing `/app/data`
If the container fails to write `config.json` or `database.sqlite`, ensure `/app/data` is writable by the container process.

For easiest portability, use a named Docker volume:

```bash
docker volume create tweets2bsky_data
docker run -d --name tweets-2-bsky -p 3000:3000 -v tweets2bsky_data:/app/data ghcr.io/j4ckxyz/tweets-2-bsky:latest
```

The container stores persistent state under `TWEETS2BSKY_DATA_DIR` (default `/app/data`). If you mount a different path, set that env var to match:

```bash
docker run -d --name tweets-2-bsky -p 3000:3000 -v /host/path:/persist -e TWEETS2BSKY_DATA_DIR=/persist ghcr.io/j4ckxyz/tweets-2-bsky:latest
```

### Docker: updating image
In Docker mode, update by pulling a newer image and recreating the container with the same volume.
`/api/update` / `update.sh` are source-install workflows.
