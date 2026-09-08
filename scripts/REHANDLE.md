# Bulk handle migration (`rehandle.ts`)

Moves tweets-2-bsky accounts from whatever handle they have now onto
`<twitter-handle>.j4ck.xyz`, by writing the `_atproto` TXT record to Cloudflare
and then calling `com.atproto.identity.updateHandle` on each account.

**Dry run is the default.** Nothing changes unless you pass `--apply`.

## Setup on the Pi

1. Create a Cloudflare API token at
   <https://dash.cloudflare.com/profile/api-tokens> -> **Create Token** ->
   **Edit zone DNS** template.

   | Setting | Value |
   |---|---|
   | Permissions | `Zone` / `DNS` / **Edit** |
   | Permissions | `Zone` / `Zone` / **Read** *(only needed for the zone lookup - see below)* |
   | Zone Resources | **Include** / **Specific zone** / `j4ck.xyz` |
   | TTL | set an expiry date - a week is plenty for a migration |
   | Client IP Filtering | optional: the Pi's public IP |

   Pick **Specific zone**, not *All zones*. The token can then only touch DNS in
   `j4ck.xyz` and nothing else in your Cloudflare account.

2. **Optional, to drop `Zone:Read`:** the script only needs `Zone -> Zone -> Read`
   to look the zone up by name. Copy the **Zone ID** from the right-hand column
   of the `j4ck.xyz` Overview page in the dashboard, put it in `.env`, and the
   lookup is skipped entirely - `Zone -> DNS -> Edit` alone is then enough.

3. Add the token to `.env` in the tweets-2-bsky directory:

   ```
   CLOUDFLARE_API_TOKEN=your_token_here
   CLOUDFLARE_ZONE_ID=your_zone_id_here   # optional, lets you drop Zone:Read
   ```

4. Confirm the token works. This verifies the token, resolves the zone, then
   **creates and deletes** a temporary `_rehandle-check.j4ck.xyz` TXT record,
   because read access alone does not prove the token can write DNS:

   ```
   bun run rehandle:check
   ```

## Dry run

```
bun run rehandle:dry                 # 3 random accounts
bun run rehandle:dry -- --all        # every account
bun run rehandle:dry -- --seed abc   # reproducible random sample
```

For each account it prints the Twitter username, the current handle, the new
handle, the resolved DID, the exact TXT record it would write, whether that
record already exists, and every transformation it applied. Nothing is written.

## Apply

Stop the service first so it cannot write `config.json` underneath the script:

```
pm2 stop tweets-2-bsky
bun run rehandle -- --limit 3
pm2 start tweets-2-bsky
```

Start with 3. Use `--only <handle>` to target specific accounts, `--all` once
you trust it.

Per account the script:

1. Upserts `TXT _atproto.<new-handle>` = `did=<did>` in Cloudflare (TTL 60).
2. Polls Cloudflare's and Google's public resolvers until both return the
   record, so the PDS cannot fail verification on a record that has not
   propagated.
3. Logs in with the stored app password and calls `updateHandle`.
4. Re-reads the handle from the PDS to confirm it took.
5. Updates `bskyIdentifier` in `config.json` — without this, the next sync would
   try to log in with the old handle and fail.

Before applying, it backs up `config.json` to
`data/config.rehandle-backup-<timestamp>.json` and afterwards writes
`data/rehandle-journal-<timestamp>.json` recording every old handle, new handle,
DID and DNS record id.

## Twitter vs Bluesky handle rules

| | Twitter/X | Bluesky (atproto) |
|---|---|---|
| Allowed characters | `A-Z a-z 0-9 _` | `a-z 0-9 -` per segment, `.` between segments |
| Underscore | allowed | **not allowed** |
| Hyphen | not allowed | allowed, but not first or last in a segment |
| Length | 1–15 | segment 1–63, whole handle ≤ 253 |
| Case | case-insensitive | normalized to lowercase |
| Structure | single token | ≥ 2 dot-separated segments (it is a domain name) |

So the conversion is:

| Twitter | New handle | Why |
|---|---|---|
| `jack` | `jack.j4ck.xyz` | unchanged |
| `Jack` | `jack.j4ck.xyz` | lowercased |
| `jack_gilbert` | `jack-gilbert.j4ck.xyz` | `_` is illegal in a DNS label |
| `_jack` | `jack.j4ck.xyz` | a segment may not *start* with `-` |
| `jack_` | `jack.j4ck.xyz` | a segment may not *end* with `-` |
| `jack__x` | `jack-x.j4ck.xyz` | repeated hyphens collapsed |
| `12345` | `12345.j4ck.xyz` | fine — only the TLD may not start with a digit |
| `___` | *rejected* | nothing legal remains |

Also enforced: the disallowed TLDs from the spec (`.local`, `.internal`,
`.arpa`, `.alt`, `.example`, `.invalid`, `.localhost`, `.onion`), and a
cross-check of every generated handle against the spec's own reference regex.

### Collisions

`a_b` and `a__b` are different Twitter accounts but both convert to `a-b`. The
script detects this — within the batch and against handles already used by other
mappings — and **refuses to run** rather than silently suffixing. Resolve it by
hand and re-run.

## Tests

```
bun run test:rehandle
```

86 offline assertions covering the conversion rules, spec validation, collision
detection, argument parsing, and account selection over a dummy 60-account
config. No network, no credentials, no writes.

## Notes and caveats

- **App passwords work.** `updateHandle` accepts `ACCESS_STANDARD` scopes, which
  include app passwords. If it ever fails with an auth error, the script says so
  and you can retry that account with its main password.
- **Rate limits:** `updateHandle` allows 10 calls per 5 minutes and 50 per day
  *per account*, so 60 accounts in one pass is fine. The script pauses 2s
  between accounts anyway.
- **The old handle is released** once changed, and someone else could claim it.
- **DNS propagation** normally takes seconds with TTL 60, but a previously
  queried name can be negative-cached. If an account times out, its DNS record
  is already in place — just re-run it with `--only`.
