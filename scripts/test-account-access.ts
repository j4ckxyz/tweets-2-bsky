#!/usr/bin/env bun
// Verifies the account detail page's authorization against a live server:
// a non-admin user must not be able to read or act on another user's account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-authz-'));
process.env.TWEETS2BSKY_DATA_DIR = scratch;
const port = process.env.TEST_PORT ?? '8901';
process.env.PORT = port;

const { startServer } = await import('../src/server.js');
startServer();
await new Promise((r) => setTimeout(r, 1200));

const base = `http://127.0.0.1:${port}`;
let failures = 0;
function check(condition: boolean, message: string) {
  console.log(`  ${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failures++;
}

async function register(username: string, password: string) {
  await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password }),
  });
  const body = (await res.json()) as any;
  return body.token as string;
}

// Only the first registration is allowed (it becomes admin); every later user
// is created by an admin. Registering the second one directly would leave it
// without a token, and the authorization checks below would then pass merely
// because the requests were unauthenticated.
const adminToken = await register('adminuser', 'admin-password-123');
const adminAuth = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

const createUser = await fetch(`${base}/api/admin/users`, {
  method: 'POST',
  headers: adminAuth,
  body: JSON.stringify({ username: 'otheruser', password: 'other-password-123', isAdmin: false }),
});
if (!createUser.ok) {
  console.log('Could not create the second user:', createUser.status, (await createUser.text()).slice(0, 200));
  process.exit(1);
}
const userLogin = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'otheruser', password: 'other-password-123' }),
});
const userToken = ((await userLogin.json()) as any).token as string;
const userAuth = { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' };

// The admin owns a mapping the second user has nothing to do with.
const created = await fetch(`${base}/api/mappings`, {
  method: 'POST',
  headers: adminAuth,
  body: JSON.stringify({
    twitterUsernames: ['someaccount'],
    bskyIdentifier: 'someone.bsky.social',
    bskyPassword: 'app-password-here',
    skipValidation: true,
  }),
});
const createdBody = (await created.json()) as any;
const mappingId = createdBody?.mapping?.id ?? createdBody?.id;
console.log('Setup\n');
check(Boolean(userToken), 'The second user has a real session token');
check(created.status === 200 || created.status === 201, `Admin created a mapping (status ${created.status})`);
check(Boolean(mappingId), `Mapping id captured (${mappingId})`);

if (!mappingId) {
  console.log(JSON.stringify(createdBody).slice(0, 400));
  process.exit(1);
}

console.log('\nThe second user is genuinely authenticated\n');
{
  const me = await fetch(`${base}/api/me`, { headers: userAuth });
  check(me.status === 200, `Their token works on an ordinary endpoint (got ${me.status})`);
  const list = await fetch(`${base}/api/mappings`, { headers: userAuth });
  const rows = (await list.json()) as any[];
  check(Array.isArray(rows) && rows.length === 0, `They see none of the admin's mappings (saw ${rows?.length})`);
}

console.log('\nReading another user\'s account\n');
{
  const res = await fetch(`${base}/api/accounts/${mappingId}`, { headers: userAuth });
  check(res.status === 404, `Non-owner gets 404, not the account (got ${res.status})`);

  const adminRes = await fetch(`${base}/api/accounts/${mappingId}`, { headers: adminAuth });
  check(adminRes.status === 200, `Owner can read it (got ${adminRes.status})`);
  const payload = (await adminRes.json()) as any;
  check(payload.permissions?.canManage === true, 'Owner is told they can manage it');
  check(!JSON.stringify(payload).includes('app-password-here'), 'The Bluesky password is never in the payload');
}

console.log('\nActing on another user\'s account\n');
{
  const unjam = await fetch(`${base}/api/accounts/${mappingId}/unjam`, {
    method: 'POST',
    headers: userAuth,
    body: JSON.stringify({ includeFailed: true }),
  });
  check(unjam.status === 404 || unjam.status === 403, `Non-owner cannot unjam it (got ${unjam.status})`);

  const backfill = await fetch(`${base}/api/backfill/${mappingId}`, {
    method: 'POST',
    headers: userAuth,
    body: JSON.stringify({ limit: 10 }),
  });
  check(backfill.status === 403 || backfill.status === 404, `Non-owner cannot backfill it (got ${backfill.status})`);

  const pause = await fetch(`${base}/api/mappings/${mappingId}`, {
    method: 'PUT',
    headers: userAuth,
    body: JSON.stringify({ enabled: false }),
  });
  check(pause.status === 403, `Non-owner cannot pause it (got ${pause.status})`);

  const stillEnabled = await fetch(`${base}/api/accounts/${mappingId}`, { headers: adminAuth });
  const payload = (await stillEnabled.json()) as any;
  check(payload.mapping?.enabled === true, 'The account really is still enabled afterwards');
}

console.log('\nUnauthenticated access\n');
{
  const res = await fetch(`${base}/api/accounts/${mappingId}`);
  check(res.status === 401, `No token is rejected (got ${res.status})`);
  const unjam = await fetch(`${base}/api/accounts/${mappingId}/unjam`, { method: 'POST' });
  check(unjam.status === 401, `No token cannot unjam (got ${unjam.status})`);
}

console.log('\nOwner actions work\n');
{
  const unjam = await fetch(`${base}/api/accounts/${mappingId}/unjam`, {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({}),
  });
  const body = (await unjam.json()) as any;
  check(unjam.status === 200, `Owner can unjam (got ${unjam.status})`);
  check(body.released === 0 && body.retried === 0, 'An empty queue reports nothing was stuck');

  const missing = await fetch(`${base}/api/accounts/does-not-exist`, { headers: adminAuth });
  check(missing.status === 404, `A missing account is a 404 (got ${missing.status})`);
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'All authorization checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
