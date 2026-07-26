// Smoke test for the built-in PDS: start it against a throwaway data dir,
// provision an account for a fake twitter handle, verify the email backdate
// hack, log in with the generated credentials, and confirm re-provisioning is
// idempotent. Run with: T2B_PDS_TEST_ALLOW_PLC=1 bun run test:pds
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Creating an account makes the PDS send a genuine did:plc operation to
// https://plc.directory. That registry is public and append-only, so every run
// leaves behind a permanent DID whose serviceEndpoint (https://t2b.test) will
// never resolve. Require an explicit opt-in rather than doing that by default.
if (process.env.T2B_PDS_TEST_ALLOW_PLC !== '1') {
  console.error('REFUSING TO RUN.');
  console.error('');
  console.error('This smoke test provisions a real account, which makes the PDS register a');
  console.error('permanent did:plc on the public https://plc.directory registry. That registry is');
  console.error('append-only: the DID cannot be deleted, and its serviceEndpoint (https://t2b.test)');
  console.error('will never resolve.');
  console.error('');
  console.error('To run anyway:');
  console.error('  T2B_PDS_TEST_ALLOW_PLC=1 bun run test:pds');
  process.exit(1);
}

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2b-pds-test-'));
process.env.TWEETS2BSKY_DATA_DIR = testDataDir;
process.env.PDS_JWT_SECRET = 'a'.repeat(32);
process.env.PDS_ADMIN_PASSWORD = 'test-admin-password';

import { Secp256k1Keypair } from '@atproto/crypto';

const main = async () => {
  const kp = await Secp256k1Keypair.create({ exportable: true });
  process.env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX = Buffer.from(await kp.export()).toString('hex');

  // Imported dynamically so the env overrides above are seen by storage-paths.
  const pdsManager = await import('../src/pds-manager.js');

  // ".test" is the one TLD atproto allows for dev setups; triggers PDS_DEV_MODE.
  const settings = { enabled: true, hostname: 't2b.test', port: 3110 };
  console.log('[1] starting PDS...');
  const handle = await pdsManager.startPds(settings);
  console.log('[1] ✓ PDS healthy at', handle.localUrl);

  try {
    await runChecks(pdsManager, settings, handle.localUrl);
  } finally {
    await handle.stop();
  }
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
};

const runChecks = async (
  pdsManager: typeof import('../src/pds-manager.js'),
  settings: { enabled: boolean; hostname: string; port: number },
  localUrl: string,
) => {
  const { provisionPdsAccount, openSqliteDb, PDS_DATA_DIR } = pdsManager;

  console.log('[2] provisioning account for twitter user "Some_User99"...');
  const result = await provisionPdsAccount(settings, 'Some_User99', (s) => console.log('    ↳', s));
  console.log('[2] ✓', JSON.stringify({ handle: result.handle, did: result.did, existing: result.existing }));

  console.log('[3] checking emailConfirmedAt in account.sqlite...');
  const db = await openSqliteDb(path.join(PDS_DATA_DIR, 'account.sqlite'));
  const row = db.prepare('SELECT email, emailConfirmedAt FROM account WHERE did = ?').get(result.did) as {
    email: string;
    emailConfirmedAt: string | null;
  };
  db.close();
  console.log('[3] ✓ email:', row.email, '| emailConfirmedAt:', row.emailConfirmedAt);
  if (!row.emailConfirmedAt || new Date(row.emailConfirmedAt) > new Date()) throw new Error('backdate failed');

  console.log('[4] logging in with generated credentials (createSession)...');
  const res = await fetch(`${localUrl}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: result.handle, password: result.password }),
  });
  const session = (await res.json()) as { handle?: string; did?: string };
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(session)}`);
  console.log('[4] ✓ logged in as', session.handle, session.did);

  console.log('[5] re-provisioning same twitter user (idempotency)...');
  const again = await provisionPdsAccount(settings, 'Some_User99', (s) => console.log('    ↳', s));
  if (!again.existing || again.did !== result.did) throw new Error('idempotency failed');
  const res2 = await fetch(`${localUrl}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: again.handle, password: again.password }),
  });
  if (!res2.ok) throw new Error('login with rotated password failed');
  console.log('[5] ✓ existing account reused, rotated password works');
};

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
