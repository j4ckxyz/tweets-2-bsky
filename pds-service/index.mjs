// Entry point for the built-in PDS child process. Runs under Node (>=22), not
// bun: @atproto/pds depends on undici v8 which cannot load under bun. Spawned
// by src/pds-manager.ts with all PDS_* configuration in the environment.
import { PDS, envToCfg, envToSecrets, readEnv } from '@atproto/pds';

const main = async () => {
  const env = readEnv();
  env.version ||= 'tweets-2-bsky-builtin';
  const cfg = envToCfg(env);
  const secrets = envToSecrets(env);
  const pds = await PDS.create(cfg, secrets);
  await pds.start();

  // Caddy on-demand TLS asks this endpoint before issuing a certificate for a
  // subdomain handle; mirrors the route in bluesky-social/pds's service entry.
  pds.app.get('/tls-check', async (req, res) => {
    try {
      const { domain } = req.query;
      if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ error: 'InvalidRequest', message: 'bad or missing domain query param' });
      }
      if (domain === pds.ctx.cfg.service.hostname) {
        return res.json({ success: true });
      }
      const isHostedHandle = pds.ctx.cfg.identity.serviceHandleDomains.find((avail) => domain.endsWith(avail));
      if (!isHostedHandle) {
        return res.status(400).json({ error: 'InvalidRequest', message: 'handles are not provided on this domain' });
      }
      const account = await pds.ctx.accountManager.getAccount(domain);
      if (!account) {
        return res.status(404).json({ error: 'NotFound', message: 'handle not found for this domain' });
      }
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'InternalServerError', message: 'Internal Server Error' });
    }
  });

  console.log(`pds listening on port ${cfg.service.port} (hostname ${cfg.service.hostname})`);

  const shutdown = async () => {
    try {
      await pds.destroy();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((err) => {
  console.error('pds failed to start:', err);
  process.exit(1);
});
