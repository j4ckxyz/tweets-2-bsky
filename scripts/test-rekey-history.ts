#!/usr/bin/env bun
/**
 * Regression tests for the duplicate-posting incident.
 *
 *   bun scripts/test-rekey-history.ts
 *
 * Uses the service's real database code (src/db.ts) on a throwaway data
 * directory, so the "is this tweet new?" answer comes from the same lookup the
 * sweep uses, not a copy of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rekey-history-'));
process.env.TWEETS2BSKY_DATA_DIR = dataDir; // must be set before storage-paths is imported

const { Database } = await import('bun:sqlite');
const { dbService } = await import('../src/db.js');
const { DB_PATH } = await import('../src/storage-paths.js');
const { finalHandles, rekeyHistory, unmovedRecords } = await import('./lib/rekey-history.js');
const { repairHistory } = await import('./rehandle.js');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string): void {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${message}`);
  condition ? passed++ : failed++;
}
const equal = (actual: unknown, expected: unknown, message: string) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  assert(same, same ? message : `${message}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
};

const save = (id: string, handle: string, uri: string | null = `at://did:plc:x/app.bsky.feed.post/${id}`) =>
  dbService.saveTweet({
    twitter_id: id,
    twitter_username: 'google',
    bsky_identifier: handle,
    tweet_text: `tweet ${id}`,
    bsky_uri: uri ?? undefined,
    bsky_cid: uri ? 'cid' : undefined,
    status: 'migrated',
  } as never);
const isNew = (id: string, handle: string) => dbService.getTweet(id, handle) === null;
const rows = (handle: string) =>
  (
    new Database(DB_PATH).query('SELECT COUNT(*) AS n FROM processed_tweets WHERE bsky_identifier = ?').get(handle) as {
      n: number;
    }
  ).n;

console.log('\nmirrored-tweet history re-keying\n');

console.log('1. The incident, reproduced');
for (const id of ['101', '102', '103']) save(id, 'google-bot.bsky.social');
save('201', 'other.bsky.social');
assert(
  !isNew('101', 'google-bot.bsky.social'),
  'before the migration, an old tweet is recognised under the old handle',
);
assert(
  isNew('101', 'google.xmirror.bot'),
  'after the handle change alone, the service thinks it is NEW (this caused the duplicates)',
);
console.log();

console.log('2. Re-keying closes it');
{
  const db = new Database(DB_PATH);
  const result = rekeyHistory(db, 'Google-Bot.bsky.social', 'google.xmirror.bot');
  equal(result.processedCopied, 3, 'copies every record, matching the old handle case-insensitively');
  assert(
    ['101', '102', '103'].every((id) => !isNew(id, 'google.xmirror.bot')),
    'every old tweet is now recognised under the new handle',
  );
  equal(
    unmovedRecords(db, 'google-bot.bsky.social', 'google.xmirror.bot'),
    0,
    'nothing is left only under the old handle',
  );
  equal(rows('google-bot.bsky.social'), 3, 'old records are kept as an audit trail');
  equal(rows('other.bsky.social'), 1, 'other accounts are untouched');
  equal(
    rekeyHistory(db, 'google-bot.bsky.social', 'google.xmirror.bot').processedCopied,
    0,
    'running it again copies nothing',
  );
  equal(rows('google.xmirror.bot'), 3, 'and creates no extra rows');
  console.log();
}

console.log('3. A tweet already re-posted under the new handle keeps its new record');
save('301', 'nintendobotx.bsky.social', 'at://did:plc:x/app.bsky.feed.post/original');
save('301', 'nintendoamerica.xmirror.bot', 'at://did:plc:x/app.bsky.feed.post/duplicate');
rekeyHistory(new Database(DB_PATH), 'nintendobotx.bsky.social', 'nintendoamerica.xmirror.bot');
equal(
  dbService.getTweet('301', 'nintendoamerica.xmirror.bot')?.bsky_uri,
  'at://did:plc:x/app.bsky.feed.post/duplicate',
  'the existing row is not overwritten',
);
console.log();

console.log('4. Chained moves from the journals');
{
  const final = finalHandles([
    { oldHandle: 'jersey-metci.bsky.social', newHandle: 'jersey-metci.j4ck.xyz' },
    { oldHandle: 'jersey-metci.j4ck.xyz', newHandle: 'jersey-metci.xmirror.bot' },
    { oldHandle: 'loop-a.example', newHandle: 'loop-b.example' },
    { oldHandle: 'loop-b.example', newHandle: 'loop-a.example' },
  ]);
  equal(
    final.get('jersey-metci.bsky.social'),
    'jersey-metci.xmirror.bot',
    'the first handle resolves through every hop',
  );
  equal(final.get('jersey-metci.j4ck.xyz'), 'jersey-metci.xmirror.bot', 'the intermediate handle does too');
  assert(final.size >= 2, 'a cycle does not hang');
  console.log();
}

console.log('5. --repair-history from real journal files');
{
  save('401', 'jersey-metci.bsky.social');
  save('402', 'jersey-metci.j4ck.xyz');
  fs.writeFileSync(
    path.join(dataDir, 'rehandle-journal-2026-09-08.json'),
    JSON.stringify([
      { kind: 'handle-change', oldHandle: 'jersey-metci.bsky.social', newHandle: 'jersey-metci.j4ck.xyz' },
    ]),
  );
  fs.writeFileSync(
    path.join(dataDir, 'rehandle-journal-2026-09-14.json'),
    JSON.stringify([
      { kind: 'handle-change', oldHandle: 'jersey-metci.j4ck.xyz', newHandle: 'jersey-metci.xmirror.bot' },
      { kind: 'config-catch-up', oldHandle: 'ignored.bsky.social', newHandle: 'ignored.xmirror.bot' },
    ]),
  );
  const log = console.log;
  console.log = () => {};
  const code = repairHistory(dataDir, DB_PATH);
  console.log = log;
  equal(code, 0, 'exits cleanly');
  assert(
    !isNew('401', 'jersey-metci.xmirror.bot') && !isNew('402', 'jersey-metci.xmirror.bot'),
    'history from both earlier handles reaches the final handle',
  );
  equal(rows('ignored.xmirror.bot'), 0, 'catch-up journal entries are not treated as moves');
  console.log();
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
