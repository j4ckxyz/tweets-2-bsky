#!/usr/bin/env bun
// Offline checks for mirror-lag accounting: the delay between a tweet being
// posted on Twitter and its mirror landing on Bluesky. Uses a throwaway data
// dir, so no network and no real database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-mirror-lag-'));
process.env.TWEETS2BSKY_DATA_DIR = scratchDir;

const { dbService } = await import('../src/db.js');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const now = Date.now();
const account = 'lagtest.bsky.social';

function save(id: string, lagMs: number | null, postedAt = now - HOUR, identifier = account) {
  dbService.saveTweet({
    twitter_id: id,
    twitter_username: 'lagtest',
    bsky_identifier: identifier,
    status: 'migrated',
    bsky_uri: `at://example/${id}`,
    bsky_cid: 'cid',
    tweet_created_at: lagMs === null ? undefined : postedAt - lagMs,
    posted_at: lagMs === null ? undefined : postedAt,
  });
}

console.log('Lag statistics\n');
{
  // 1, 3, 5, 7 and 9 minutes of delay: mean 5, median 5, worst 9.
  save('1', 1 * MINUTE);
  save('2', 3 * MINUTE);
  save('3', 5 * MINUTE);
  save('4', 7 * MINUTE);
  save('5', 9 * MINUTE);

  const stats = dbService.getMirrorLagStats().find((row) => row.bsky_identifier === account);
  assert(stats !== undefined, 'Account with timestamped posts reports lag stats');
  assert(stats?.samples === 5, `Counts every timestamped post (got ${stats?.samples})`);
  assert(stats?.averageLagMs === 5 * MINUTE, `Average lag is 5 minutes (got ${stats?.averageLagMs})`);
  assert(stats?.medianLagMs === 5 * MINUTE, `Median lag is 5 minutes (got ${stats?.medianLagMs})`);
  assert(stats?.worstLagMs === 9 * MINUTE, `Worst lag is 9 minutes (got ${stats?.worstLagMs})`);
}

console.log('\nRows without timestamps\n');
{
  const untimed = 'untimed.bsky.social';
  save('6', null, now, untimed);
  const stats = dbService.getMirrorLagStats().find((row) => row.bsky_identifier === untimed);
  assert(stats === undefined, 'Posts predating lag tracking are excluded rather than counted as zero');
}

console.log('\nBackfills and stale rows\n');
{
  const backfilled = 'backfill.bsky.social';
  // A two-year-old tweet imported today is not a mirror delay.
  save('7', 730 * 24 * HOUR, now - HOUR, backfilled);
  const backfillStats = dbService.getMirrorLagStats().find((row) => row.bsky_identifier === backfilled);
  assert(backfillStats === undefined, 'Backfilled history is excluded from lag averages');

  const old = 'old.bsky.social';
  // Posted 30 days ago: outside the default 7-day reporting window.
  save('8', 5 * MINUTE, now - 30 * 24 * HOUR, old);
  const oldStats = dbService.getMirrorLagStats().find((row) => row.bsky_identifier === old);
  assert(oldStats === undefined, 'Posts outside the reporting window are excluded');

  const windowed = dbService.getMirrorLagStats(60 * 24 * HOUR).find((row) => row.bsky_identifier === old);
  assert(windowed?.samples === 1, 'A wider window includes the older post');
}

console.log('\nClock skew\n');
{
  const skewed = 'skewed.bsky.social';
  // Twitter timestamp ahead of our clock would produce a negative delay.
  save('9', -5 * MINUTE, now - HOUR, skewed);
  const stats = dbService.getMirrorLagStats().find((row) => row.bsky_identifier === skewed);
  assert(stats === undefined, 'Negative lag from clock skew is discarded, not averaged in');
}

fs.rmSync(scratchDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
