// Glue between the discovery records (discovery.ts) and the app: which account
// curates, which mappings belong to a group, and where the resulting list and
// starter pack URIs are remembered. Used by the dashboard's "sync starter
// pack" action and by the daily refresh in the scheduler.
import { getAgent } from './bsky.js';
import { type AccountGroup, getConfig, updateConfig } from './config-manager.js';
import { type DiscoveryAgent, STARTER_PACK_RECOMMENDED_MIN, starterPackUrl, syncGroupDiscovery } from './discovery.js';
import { logEvent } from './event-log.js';

const DISCOVERY_REFRESH_MS = 24 * 60 * 60 * 1000;

const groupKey = (name: string | undefined) => (name ?? '').trim().toLowerCase();

export interface GroupDiscoveryOutcome {
  group: string;
  listUri: string;
  starterPackUri: string;
  starterPackUrl: string;
  members: number;
  added: number;
  removed: number;
  /** Members whose DID could not be determined (never logged in, unresolvable handle). */
  unresolved: string[];
  belowRecommendedSize: boolean;
}

export async function syncDiscoveryForGroup(groupName: string): Promise<GroupDiscoveryOutcome> {
  const config = getConfig();
  const curator = config.mappings.find((mapping) => mapping.id === config.discovery?.curatorMappingId);
  if (!curator) {
    throw new Error('Choose a curator account (Settings → Discovery) to own the lists and starter packs first.');
  }
  const group: AccountGroup | undefined = config.groups.find((entry) => groupKey(entry.name) === groupKey(groupName));
  if (!group) throw new Error(`Group "${groupName}" does not exist.`);

  const agent = await getAgent(curator);
  if (!agent) throw new Error(`Could not sign in to the curator account ${curator.bskyIdentifier}.`);

  const members = config.mappings.filter(
    (mapping) => mapping.enabled && groupKey(mapping.groupName) === groupKey(group.name),
  );
  const dids: string[] = [];
  const unresolved: string[] = [];
  for (const member of members) {
    let did = member.bskyDid ?? (member.bskyIdentifier.startsWith('did:') ? member.bskyIdentifier : undefined);
    if (!did) {
      try {
        did = (await agent.com.atproto.identity.resolveHandle({ handle: member.bskyIdentifier })).data.did;
      } catch {
        did = undefined;
      }
    }
    if (did) dids.push(did);
    else unresolved.push(member.bskyIdentifier);
  }

  const result = await syncGroupDiscovery(agent as unknown as DiscoveryAgent, group, dids);
  updateConfig((fresh) => {
    const entry = fresh.groups.find((candidate) => groupKey(candidate.name) === groupKey(group.name));
    if (!entry) return false;
    entry.listUri = result.listUri;
    entry.starterPackUri = result.starterPackUri;
    entry.lastDiscoverySyncAt = new Date().toISOString();
    return true;
  });

  const url = starterPackUrl(
    result.starterPackUri,
    agent.session?.handle || agent.session?.did || curator.bskyIdentifier,
  );
  logEvent({
    level: 'info',
    stage: 'system',
    event: 'discovery.synced',
    message: `Starter pack for "${group.name}" is up to date: ${result.members} account(s), ${result.added} added, ${result.removed} removed.`,
    detail: { ...result, url, unresolved },
  });
  return {
    group: group.name,
    listUri: result.listUri,
    starterPackUri: result.starterPackUri,
    starterPackUrl: url,
    members: result.members,
    added: result.added,
    removed: result.removed,
    unresolved,
    belowRecommendedSize: result.members < STARTER_PACK_RECOMMENDED_MIN,
  };
}

/** Keep existing starter packs in step with their groups, once a day each. */
export async function refreshDiscoveryDaily(): Promise<void> {
  const config = getConfig();
  if (!config.discovery?.curatorMappingId) return;
  for (const group of config.groups) {
    if (!group.starterPackUri) continue;
    const last = group.lastDiscoverySyncAt ? Date.parse(group.lastDiscoverySyncAt) : 0;
    if (Number.isFinite(last) && Date.now() - last < DISCOVERY_REFRESH_MS) continue;
    try {
      await syncDiscoveryForGroup(group.name);
    } catch (error) {
      logEvent({
        level: 'warn',
        stage: 'system',
        event: 'discovery.sync-failed',
        message: `Could not refresh the starter pack for "${group.name}": ${(error as Error).message}`,
      });
    }
  }
}
