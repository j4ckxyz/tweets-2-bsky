#!/usr/bin/env bun
/**
 * Offline test suite for the handle migration.
 *
 *   bun scripts/test-rehandle.ts
 *
 * Everything here runs against dummy data. No network, no Cloudflare, no
 * Bluesky, no config.json writes.
 */

import type { AccountMapping } from '../src/config-manager.js';
import { unquoteTxt } from './lib/cloudflare.js';
import {
  ATPROTO_HANDLE_REGEX,
  convertHandle,
  findCollisions,
  normalizeTwitterUsername,
  validateHandle,
} from './lib/handle-map.js';
import {
  describeChoice,
  maskToken,
  parseIdentifierList,
  sampleRandom,
  upsertEnvVar,
  validateDomainInput,
} from './rehandle-wizard.js';
import type { Plan } from './rehandle.js';
import {
  findDuplicateTwitterSources,
  findExternalClashes,
  parseArgs,
  seededRandom,
  selectMappings,
  sourceUsernameFor,
} from './rehandle.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
    passed++;
  } else {
    console.log(`  FAIL ${message}`);
    failed++;
  }
}

/** Groups related assertions under a heading. */
function section(title: string, body: () => void): void {
  console.log(title);
  body();
  console.log();
}

const equal = (actual: unknown, expected: unknown, message: string) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}${JSON.stringify(actual) === JSON.stringify(expected) ? '' : `  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`}`,
  );

const DOMAIN = 'j4ck.xyz';
const handleOf = (username: string) => convertHandle(username, DOMAIN).handle;
const notesOf = (username: string) => convertHandle(username, DOMAIN).notes.map((n) => n.code);

console.log('\ntweets-2-bsky handle migration - offline tests\n');

// ---------------------------------------------------------------------------
section('1. Twitter username normalization', () => {
  equal(normalizeTwitterUsername('@Jack'), 'jack', 'strips a leading @ and lowercases');
  equal(normalizeTwitterUsername('  jack  '), 'jack', 'trims surrounding whitespace');
  equal(normalizeTwitterUsername('@@jack'), 'jack', 'strips repeated @');
  equal(normalizeTwitterUsername('JACK_GILBERT'), 'jack_gilbert', 'lowercases but keeps underscores at this stage');
});

// ---------------------------------------------------------------------------
section('2. Twitter -> DNS label conversion (the real rule differences)', () => {
  equal(handleOf('jack'), 'jack.j4ck.xyz', 'a plain handle passes through');
  equal(handleOf('Jack'), 'jack.j4ck.xyz', 'Twitter handles are case-insensitive; Bluesky handles are lowercase');

  // The headline difference: `_` is legal on Twitter, illegal in a DNS label.
  equal(handleOf('jack_gilbert'), 'jack-gilbert.j4ck.xyz', 'underscore becomes a hyphen');
  assert(notesOf('jack_gilbert').includes('underscore-to-hyphen'), 'underscore translation is reported as a note');

  // A DNS label may not start or end with a hyphen, so `_jack_` cannot be `-jack-`.
  equal(handleOf('_jack'), 'jack.j4ck.xyz', 'leading underscore is dropped, not turned into a leading hyphen');
  equal(handleOf('jack_'), 'jack.j4ck.xyz', 'trailing underscore is dropped');
  equal(handleOf('_jack_'), 'jack.j4ck.xyz', 'both are dropped');
  assert(notesOf('_jack_').includes('trimmed-hyphens'), 'hyphen trimming is reported as a note');

  equal(handleOf('jack__gilbert'), 'jack-gilbert.j4ck.xyz', 'repeated underscores collapse to one hyphen');
  assert(notesOf('jack__gilbert').includes('collapsed-hyphens'), 'hyphen collapsing is reported as a note');

  equal(handleOf('12345'), '12345.j4ck.xyz', 'an all-numeric label is fine (only the TLD may not start with a digit)');
  equal(handleOf('a'), 'a.j4ck.xyz', 'a single character is a valid label');
  equal(
    handleOf('abcdefghijklmno'),
    'abcdefghijklmno.j4ck.xyz',
    "Twitter's 15-char max is well inside the 63-char label limit",
  );

  // Failures.
  assert(handleOf('___') === null, 'an all-underscore handle cannot produce a label');
  assert(convertHandle('___', DOMAIN).errors.length > 0, 'and it reports an error explaining why');
  assert(handleOf('') === null, 'an empty username is rejected');
  assert(handleOf('   ') === null, 'a whitespace-only username is rejected');

  // Defensive: not valid Twitter handles, but must not produce a broken handle.
  equal(
    handleOf('jack.gilbert'),
    'jack-gilbert.j4ck.xyz',
    'a dot is replaced rather than creating an extra subdomain level',
  );
  assert(notesOf('jack.gilbert').includes('illegal-characters'), 'unexpected characters are flagged as a warning');
  equal(handleOf('jack-gilbert'), 'jack-gilbert.j4ck.xyz', 'an existing hyphen is preserved');
  assert(handleOf('日本語') === null, 'a fully non-ASCII username produces no label');
  assert(
    convertHandle('jack🎉', DOMAIN).notes.some((n) => n.code === 'illegal-characters'),
    'an emoji is stripped with a warning',
  );

  const long = 'a'.repeat(70);
  assert(convertHandle(long, DOMAIN).handle === null, 'a label over 63 chars is rejected');

  assert(
    convertHandle('jack$gilbert', DOMAIN).notes.some((n) => n.code === 'nonstandard-twitter-username'),
    'a username outside the canonical Twitter shape is flagged',
  );
});

// ---------------------------------------------------------------------------
section('3. atproto handle validation', () => {
  equal(validateHandle('jack.j4ck.xyz'), [], 'a well-formed handle validates clean');
  assert(validateHandle('Jack.j4ck.xyz').length > 0, 'an uppercase handle is rejected');
  assert(validateHandle('jack').length > 0, 'a single segment is rejected');
  assert(validateHandle('-jack.j4ck.xyz').length > 0, 'a leading hyphen in a segment is rejected');
  assert(validateHandle('jack-.j4ck.xyz').length > 0, 'a trailing hyphen in a segment is rejected');
  assert(validateHandle('jack_x.j4ck.xyz').length > 0, 'an underscore anywhere in the handle is rejected');
  assert(validateHandle('jack.j4ck.local').length > 0, 'a disallowed TLD (.local) is rejected');
  assert(validateHandle('jack.j4ck.internal').length > 0, 'a disallowed TLD (.internal) is rejected');
  assert(validateHandle('jack.j4ck.123').length > 0, 'a TLD starting with a digit is rejected');
  assert(validateHandle(`${'a'.repeat(64)}.j4ck.xyz`).length > 0, 'a 64-char segment is rejected');

  // Cross-check every generated handle against the spec's own regex.
  for (const username of ['jack', 'jack_gilbert', '_jack_', '12345', 'a', 'jack__x']) {
    const handle = handleOf(username);
    assert(
      handle !== null && ATPROTO_HANDLE_REGEX.test(handle),
      `"${username}" -> "${handle}" matches the atproto spec regex`,
    );
  }
});

// ---------------------------------------------------------------------------
section('4. Collision detection', () => {
  // `a_b` and `a__b` are distinct on Twitter but both become `a-b`.
  const conversions = [convertHandle('a_b', DOMAIN), convertHandle('a__b', DOMAIN), convertHandle('unique', DOMAIN)];
  const collisions = findCollisions(conversions);
  equal(collisions.length, 1, 'detects one collision');
  equal(collisions[0]?.handle, 'a-b.j4ck.xyz', 'names the colliding handle');
  equal(collisions[0]?.sources.sort(), ['a__b', 'a_b'], 'names both Twitter sources');

  equal(findCollisions([convertHandle('alice', DOMAIN), convertHandle('bob', DOMAIN)]), [], 'no false positives');
  equal(
    findCollisions([convertHandle('jack', DOMAIN), convertHandle('@Jack', DOMAIN)]),
    [],
    'the same username twice is not a collision',
  );
});

// ---------------------------------------------------------------------------
section('5. Cloudflare TXT value handling', () => {
  equal(unquoteTxt('"did=did:plc:abc"'), 'did=did:plc:abc', 'strips the quotes Cloudflare may add');
  equal(unquoteTxt('did=did:plc:abc'), 'did=did:plc:abc', 'leaves an unquoted value alone');
  equal(unquoteTxt('  did=x  '), 'did=x', 'trims whitespace');
});

// ---------------------------------------------------------------------------
section('6. Argument parsing', () => {
  const defaults = parseArgs([]);
  equal(defaults.apply, false, 'dry run is the default (--apply is opt-in)');
  equal(defaults.limit, 3, 'the default sample size is 3');
  equal(defaults.domain, 'j4ck.xyz', 'the default domain is j4ck.xyz');

  equal(parseArgs(['--apply']).apply, true, '--apply is recognised');
  equal(parseArgs(['--limit', '10']).limit, 10, '--limit takes a value');
  equal(parseArgs(['--only', 'a', '--only', 'b']).only, ['a', 'b'], '--only is repeatable');
  equal(parseArgs(['--domain', 'example.com']).domain, 'example.com', '--domain overrides');

  let threw = false;
  try {
    parseArgs(['--nope']);
  } catch {
    threw = true;
  }
  assert(threw, 'an unknown flag is rejected rather than ignored');

  threw = false;
  try {
    parseArgs(['--limit', '0']);
  } catch {
    threw = true;
  }
  assert(threw, '--limit 0 is rejected');

  threw = false;
  try {
    parseArgs(['--limit']);
  } catch {
    threw = true;
  }
  assert(threw, 'a flag missing its value is rejected');
});

// ---------------------------------------------------------------------------
section('7. Account selection over a dummy 60-account config', () => {
  const usernames = [
    'alice',
    'bob_smith',
    '_charlie',
    'dave_',
    'eve__adams',
    'frank',
    'grace_h',
    'heidi',
    'ivan_p',
    'judy',
    'karl__k',
    'leo',
    'mallory_x',
    'niaj',
    'olivia_',
    'peggy',
    'quentin_r',
    'rupert',
    'sybil_s',
    'trent',
    'uma_u',
    'victor',
    'walter_w',
    'xena',
    'yves_y',
    'zara',
    'aaron_a',
    'bella',
    'cain_c',
    'dora',
  ];
  const mappings: AccountMapping[] = Array.from({ length: 60 }, (_, i) => {
    const username = `${usernames[i % usernames.length]}${i >= usernames.length ? `_${i}` : ''}`;
    return {
      id: `id-${i}`,
      twitterUsernames: [username],
      bskyIdentifier: `acct${i}.bsky.social`,
      bskyPassword: 'app-pass-xxxx',
      bskyServiceUrl: 'https://bsky.social',
      enabled: i % 10 !== 9, // 6 of the 60 are disabled
      profileSyncSourceUsername: username,
    } as AccountMapping;
  });

  const base = parseArgs([]);
  equal(mappings.length, 60, 'the dummy config has 60 mappings');
  equal(mappings.filter((m) => m.enabled).length, 54, '54 are enabled, 6 disabled');

  const sample = selectMappings(mappings, base);
  equal(sample.length, 3, 'the default selection is 3 accounts');
  assert(
    sample.every((m) => m.enabled),
    'disabled mappings are excluded by default',
  );
  equal(new Set(sample.map((m) => m.id)).size, 3, 'the sample contains no duplicates');

  equal(selectMappings(mappings, parseArgs(['--all'])).length, 54, '--all selects every enabled mapping');
  equal(
    selectMappings(mappings, parseArgs(['--all', '--include-disabled'])).length,
    60,
    '--include-disabled adds the rest',
  );

  const onlyOne = selectMappings(mappings, parseArgs(['--only', 'alice']));
  equal(onlyOne.length, 1, '--only matches by Twitter username');
  equal(onlyOne[0]?.id, 'id-0', 'and picks the right mapping');
  equal(
    selectMappings(mappings, parseArgs(['--only', 'acct5.bsky.social'])).length,
    1,
    '--only also matches by Bluesky handle',
  );
  equal(selectMappings(mappings, parseArgs(['--only', '@alice'])).length, 1, '--only tolerates a leading @');
  equal(selectMappings(mappings, parseArgs(['--only', 'nobody'])).length, 0, '--only with no match selects nothing');

  const seeded = selectMappings(mappings, parseArgs(['--seed', 'test-run']));
  const seededAgain = selectMappings(mappings, parseArgs(['--seed', 'test-run']));
  equal(
    seeded.map((m) => m.id),
    seededAgain.map((m) => m.id),
    '--seed makes the random sample reproducible',
  );
  assert(seededRandom('a')() !== seededRandom('b')(), 'different seeds give different sequences');

  equal(sourceUsernameFor(mappings[0] as AccountMapping), 'alice', 'the profile-sync source drives the new handle');
  equal(
    sourceUsernameFor({
      ...(mappings[0] as AccountMapping),
      profileSyncSourceUsername: undefined,
      twitterUsernames: ['first', 'second'],
    }),
    'first',
    'falls back to the first Twitter username',
  );
  equal(
    sourceUsernameFor({
      ...(mappings[0] as AccountMapping),
      profileSyncSourceUsername: undefined,
      twitterUsernames: [],
    }),
    null,
    'returns null when there is no Twitter username at all',
  );
});

// ---------------------------------------------------------------------------
section('8. Bulk dry-run simulation over all 60 dummy accounts', () => {
  const usernames = Array.from({ length: 60 }, (_, i) => {
    if (i % 7 === 0) return `user_${i}`;
    if (i % 7 === 1) return `_user${i}`;
    if (i % 7 === 2) return `user${i}_`;
    if (i % 7 === 3) return `user__${i}`;
    if (i % 7 === 4) return `User${i}`;
    if (i % 7 === 5) return `${1000 + i}`;
    return `user${i}`;
  });

  const conversions = usernames.map((u) => convertHandle(u, DOMAIN));
  equal(conversions.filter((c) => c.ok).length, 60, 'all 60 dummy accounts convert successfully');
  assert(
    conversions.every((c) => c.handle !== null && ATPROTO_HANDLE_REGEX.test(c.handle)),
    'every generated handle is spec-valid',
  );
  assert(
    conversions.every((c) => c.handle?.endsWith('.j4ck.xyz')),
    'every handle sits under the target domain',
  );
  equal(findCollisions(conversions), [], 'no collisions across the 60 accounts');

  const touched = conversions.filter((c) => c.notes.length > 0).length;
  assert(touched > 0, `${touched}/60 accounts needed at least one transformation`);
  assert(
    conversions.every((c) => c.notes.every((n) => n.level !== 'warn')),
    'no warnings for realistic Twitter usernames',
  );

  // The TXT record name the migration would create.
  const txtName = `_atproto.${conversions[0]?.handle}`;
  equal(txtName, '_atproto.user-0.j4ck.xyz', 'the DNS record name is _atproto.<new handle>');
});

// ---------------------------------------------------------------------------
section('9. Wizard input helpers', () => {
  equal(validateDomainInput('j4ck.xyz'), true, 'accepts a normal domain');
  equal(validateDomainInput('xmirror.bot'), true, 'accepts the .bot TLD');
  equal(validateDomainInput('  J4CK.XYZ  '), true, 'tolerates whitespace and caps');
  assert(validateDomainInput('') !== true, 'rejects an empty domain');
  assert(validateDomainInput('localhost') !== true, 'rejects a single-segment domain');
  assert(validateDomainInput('j4ck.local') !== true, 'rejects a disallowed TLD');
  assert(validateDomainInput('j4ck.123') !== true, 'rejects a numeric TLD');
  assert(validateDomainInput('-bad.xyz') !== true, 'rejects a segment starting with a hyphen');

  equal(maskToken('abcdefghijklmnop'), '************mnop', 'masks all but the last four characters');
  equal(maskToken('short'), '*****', 'masks a short token entirely');
  assert(!maskToken('abcdefghijklmnop').includes('abcdefg'), 'never leaks the start of the token');

  equal(parseIdentifierList('a, b c'), ['a', 'b', 'c'], 'splits on commas and spaces');
  equal(parseIdentifierList('@Alice, @alice'), ['alice'], 'strips @, lowercases and de-duplicates');
  equal(parseIdentifierList('   '), [], 'returns nothing for blank input');

  equal(sampleRandom([1, 2, 3, 4, 5], 3).length, 3, 'samples the requested count');
  equal(new Set(sampleRandom([1, 2, 3, 4, 5], 5)).size, 5, 'samples without replacement');
  equal(sampleRandom([1, 2], 10).length, 2, 'never returns more than it was given');
});

section('10. .env editing', () => {
  equal(upsertEnvVar('', 'CLOUDFLARE_API_TOKEN', 'abc'), 'CLOUDFLARE_API_TOKEN=abc\n', 'writes into an empty file');
  equal(
    upsertEnvVar('FOO=1\n', 'CLOUDFLARE_API_TOKEN', 'abc'),
    'FOO=1\nCLOUDFLARE_API_TOKEN=abc\n',
    'appends when the key is absent',
  );
  equal(
    upsertEnvVar('FOO=1', 'CLOUDFLARE_API_TOKEN', 'abc'),
    'FOO=1\nCLOUDFLARE_API_TOKEN=abc\n',
    'adds the missing trailing newline before appending',
  );
  equal(
    upsertEnvVar('CLOUDFLARE_API_TOKEN=\nFOO=1\n', 'CLOUDFLARE_API_TOKEN', 'abc'),
    'CLOUDFLARE_API_TOKEN=abc\nFOO=1\n',
    'replaces an existing empty value in place rather than duplicating',
  );
  equal(
    upsertEnvVar('CLOUDFLARE_API_TOKEN=old\n', 'CLOUDFLARE_API_TOKEN', 'new'),
    'CLOUDFLARE_API_TOKEN=new\n',
    'overwrites an existing value',
  );
  equal(
    upsertEnvVar('# CLOUDFLARE_API_TOKEN=old\n', 'CLOUDFLARE_API_TOKEN', 'new'),
    'CLOUDFLARE_API_TOKEN=new\n',
    'uncomments and sets a commented-out key',
  );
  const twice = upsertEnvVar(upsertEnvVar('', 'CLOUDFLARE_API_TOKEN', 'a'), 'CLOUDFLARE_API_TOKEN', 'b');
  equal(twice.split('CLOUDFLARE_API_TOKEN').length - 1, 1, 'running twice leaves exactly one entry');
});

section('11. Duplicate Twitter sources and handle clashes', () => {
  const make = (id: string, usernames: string[], bsky: string): AccountMapping =>
    ({
      id,
      twitterUsernames: usernames,
      bskyIdentifier: bsky,
      bskyPassword: 'x',
      bskyServiceUrl: 'https://bsky.social',
      enabled: true,
      profileSyncSourceUsername: usernames[0],
    }) as AccountMapping;

  // The real shape of the nintendovs case: a secondary on one mapping, primary on another.
  const mappings = [
    make('a', ['nintendoamerica', 'nintendovs'], 'nintendobotx.bsky.social'),
    make('b', ['nintendovs'], 'nintendovs.bsky.social'),
    make('c', ['solo'], 'solo.bsky.social'),
  ];
  const duplicates = findDuplicateTwitterSources(mappings);
  equal(duplicates.length, 1, 'finds exactly one duplicated Twitter source');
  equal(duplicates[0]?.twitterUsername, 'nintendovs', 'names the duplicated account');
  equal(duplicates[0]?.bskyIdentifiers.length, 2, 'lists both Bluesky accounts mirroring it');
  equal(findDuplicateTwitterSources([make('a', ['x'], 'x.bsky.social')]), [], 'no false positives');

  // A generated handle already held by a different mapping must block.
  const plans = [{ mapping: mappings[0], newHandle: 'solo.bsky.social' } as unknown as Plan];
  equal(findExternalClashes(plans, mappings), ['solo.bsky.social'], 'detects a handle held by another mapping');
  equal(
    findExternalClashes([{ mapping: mappings[0], newHandle: 'brand-new.j4ck.xyz' } as unknown as Plan], mappings),
    [],
    'an unused handle does not clash',
  );
  const first = mappings[0] as AccountMapping;
  equal(
    findExternalClashes([{ mapping: first, newHandle: first.bskyIdentifier } as unknown as Plan], mappings),
    [],
    'a mapping keeping its own handle is not a clash',
  );

  equal(
    describeChoice(mappings[0] as AccountMapping, 'j4ck.xyz'),
    '@nintendoamerica  nintendobotx.bsky.social -> nintendoamerica.j4ck.xyz',
    'the picker line shows the username, current handle and target',
  );
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
