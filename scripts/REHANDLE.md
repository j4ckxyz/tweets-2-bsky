# Bulk handle migration (`rehandle.ts`)

Moves tweets-2-bsky accounts from whatever handle they have now onto
`<twitter-handle>.xmirror.bot`, by writing the `_atproto` TXT record to Cloudflare
and then calling `com.atproto.identity.updateHandle` on each account.

**Dry run is the default.** Nothing changes unless you pass `--apply`.

## The easy way: the wizard

```
bun run wizard
```

Walks through everything with prompts - domain, Cloudflare token, which accounts,
a full preview - and changes nothing until you confirm at the very end. It also
offers to stop and restart the pm2 service around the migration, so it cannot
write `config.json` underneath you.

Everything below is the same job driven by flags instead. Use it when you want
to script the run or repeat an exact command.

## Setup on the Pi

1. Create a Cloudflare API token at
   <https://dash.cloudflare.com/profile/api-tokens> -> **Create Token** ->
   **Edit zone DNS** template.

   | Setting | Value |
   |---|---|
   | Permissions | `Zone` / `DNS` / **Edit** |
   | Permissions | `Zone` / `Zone` / **Read** *(only needed for the zone lookup - see below)* |
   | Zone Resources | **Include** / **Specific zone** / `xmirror.bot` |
   | TTL | set an expiry date - a week is plenty for a migration |
   | Client IP Filtering | optional: the Pi's public IP |

   Pick **Specific zone**, not *All zones*. The token can then only touch DNS in
   `xmirror.bot` and nothing else in your Cloudflare account.

2. **Optional, to drop `Zone:Read`:** the script only needs `Zone -> Zone -> Read`
   to look the zone up by name. Copy the **Zone ID** from the right-hand column
   of the `xmirror.bot` Overview page in the dashboard, put it in `.env`, and the
   lookup is skipped entirely - `Zone -> DNS -> Edit` alone is then enough.

3. Add the token to `.env` in the tweets-2-bsky directory:

   ```
   CLOUDFLARE_API_TOKEN=your_token_here
   CLOUDFLARE_ZONE_ID=your_zone_id_here   # optional, lets you drop Zone:Read
   ```

4. Confirm the token works. This verifies the token, resolves the zone, then
   **creates and deletes** a temporary `_rehandle-check-<id>.xmirror.bot` TXT record
   and waits for it to resolve publicly, because neither read access nor a
   successful API write proves Bluesky will be able to see records:

   ```
   bun run rehandle:check
   ```

## Post history follows the handle

The mirror's post history, queue and account health are keyed by the Bluesky
handle. Each migrated account's history is copied to the new handle in the same
step as the config change (old rows are kept as an audit trail), so the next
sweep still knows which tweets are already mirrored and re-posts nothing. If the
database cannot be updated, the run says so: do not start the service until
`bun run rehandle -- --repair-history` has re-filed the history.

## Putting a new domain on Cloudflare

Handles only verify once public DNS for the domain is answered by Cloudflare.
The preflight refuses to start until that is true, so a run can never burn
through every account on records nobody can see.

1. **Cloudflare:** *Add a domain* -> `xmirror.bot` -> *Manually enter DNS
   records* -> **Free** plan. Cloudflare shows two nameservers ending in
   `ns.cloudflare.com`. Leave the page open.
2. **Registrar (Porkbun):** *Domain Management* -> `xmirror.bot` -> *Details* ->
   **Authoritative Nameservers** -> *Edit*. Delete all four `*.ns.porkbun.com`
   entries, paste the two Cloudflare ones, save.
3. **DNSSEC must stay off** until Cloudflare is active. Changing nameservers with
   DNSSEC enabled at the registrar makes the whole domain fail to resolve.
4. Back in Cloudflare, *Check nameservers now*. The zone turns **Active** when the
   `.bot` registry publishes the change - usually minutes, occasionally hours.
5. **Token:** edit the existing API token and add `xmirror.bot` under *Zone
   Resources* (or create a new one scoped to it). Check its expiry date too.
6. Confirm: `bun run rehandle:check`. It checks the zone is active, that public
   DNS delegates to Cloudflare, and that a test record actually resolves.

## Re-running and interrupted runs

Re-running is safe. Each account is checked against what **Bluesky** reports,
not just `config.json`:

| Status | Meaning |
|---|---|
| `READY` | needs the DNS record and a handle change |
| `CONFIG CATCH-UP` | Bluesky already has the new handle but `config.json` does not - a previous run was interrupted after the change landed. Only `config.json` is updated, after logging in to prove the account is yours. |
| `ALREADY CORRECT` | skipped |
| `BLOCKED` | cannot proceed; the reason is printed |

`config.json` is saved the moment Bluesky accepts each change, and login falls
back to the account's DID if the handle in `config.json` is no longer known.

Accounts already moved to an earlier domain (e.g. `j4ck.xyz`) are found through
that domain's `_atproto` records, so **do not delete the old records until the
migration is finished.** Afterwards they are stale and safe to remove.

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
| `jack` | `jack.xmirror.bot` | unchanged |
| `Jack` | `jack.xmirror.bot` | lowercased |
| `jack_gilbert` | `jack-gilbert.xmirror.bot` | `_` is illegal in a DNS label |
| `_jack` | `jack.xmirror.bot` | a segment may not *start* with `-` |
| `jack_` | `jack.xmirror.bot` | a segment may not *end* with `-` |
| `jack__x` | `jack-x.xmirror.bot` | repeated hyphens collapsed |
| `12345` | `12345.xmirror.bot` | fine — only the TLD may not start with a digit |
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

Three offline suites, no real network or credentials:

- `test-rehandle.ts` - conversion rules, spec validation, collision and
  duplicate-source detection, argument parsing, `.env` editing, and selection
  over a dummy 60-account config.
- `test-rehandle-network.ts` - plan statuses and the Cloudflare preflight against
  a scripted fake of Bluesky, Cloudflare and DNS-over-HTTPS; the interrupted-run
  catch-up is exercised end to end in a child process with a throwaway
  `config.json`.
- `test-wizard-prompts.ts` - drives the wizard's real prompts through injected
  streams.

## Notes and caveats

- **App passwords work.** `updateHandle` accepts `ACCESS_STANDARD` scopes, which
  include app passwords. If it ever fails with an auth error, the script says so
  and you can retry that account with its main password.
- **Rate limits:** `updateHandle` allows 10 calls per 5 minutes and 50 per day
  *per account*, so 60 accounts in one pass is fine. The script pauses 2s
  between accounts anyway.
- **The old handle is released** once changed, and someone else could claim it.
- **Prompt types:** the wizard uses `select`, not the legacy `list`. Under the
  pinned inquirer 13, a `list` prompt silently resolves to an empty string
  instead of the chosen value. (`src/cli.ts` still uses `list` in six places -
  worth checking separately.)
- **DNS propagation** normally takes seconds with TTL 60, but a previously
  queried name can be negative-cached. If an account times out, its DNS record
  is already in place — just re-run it with `--only`.
