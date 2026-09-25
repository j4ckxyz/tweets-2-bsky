// Discovery: every account group gets a Bluesky list and a starter pack, so
// people can follow a whole set of mirrors ("all the NBA teams") in one tap.
//
// Both records live in a curator account (one of the mirrored accounts, picked
// in settings). Syncing is idempotent: it creates what is missing, adds new
// members, removes members that left the group, and touches nothing else.
// Everything here is Bluesky-side; it makes no Twitter requests.

export interface DiscoveryAgent {
  session?: { did: string; handle?: string } | null;
  com: {
    atproto: {
      repo: {
        // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
        createRecord: (input: any) => Promise<{ data: { uri: string; cid: string } }>;
        // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
        deleteRecord: (input: any) => Promise<unknown>;
        // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
        getRecord: (input: any) => Promise<{ data: { uri: string; value: any } }>;
        // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
        putRecord: (input: any) => Promise<unknown>;
        // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
        listRecords: (input: any) => Promise<{ data: { records: { uri: string; value: any }[]; cursor?: string } }>;
      };
    };
  };
}

export interface DiscoveryGroupInput {
  name: string;
  emoji?: string;
  listUri?: string;
  starterPackUri?: string;
}

export interface DiscoverySyncResult {
  listUri: string;
  starterPackUri: string;
  added: number;
  removed: number;
  members: number;
  createdList: boolean;
  createdStarterPack: boolean;
}

const LIST_COLLECTION = 'app.bsky.graph.list';
const LIST_ITEM_COLLECTION = 'app.bsky.graph.listitem';
const STARTER_PACK_COLLECTION = 'app.bsky.graph.starterpack';

/** Bluesky's app asks for at least this many accounts in a starter pack. */
export const STARTER_PACK_RECOMMENDED_MIN = 7;

const rkeyOf = (uri: string) => uri.split('/').pop() as string;

function truncate(text: string, limit: number): string {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
  return graphemes.length <= limit ? text : `${graphemes.slice(0, limit - 1).join('')}…`;
}

async function recordExists(agent: DiscoveryAgent, uri: string | undefined, collection: string): Promise<boolean> {
  if (!uri) return false;
  const repo = agent.session?.did;
  if (!repo || !uri.startsWith(`at://${repo}/${collection}/`)) return false;
  try {
    await agent.com.atproto.repo.getRecord({ repo, collection, rkey: rkeyOf(uri) });
    return true;
  } catch {
    return false;
  }
}

/** bsky.app link for a starter pack record. */
export function starterPackUrl(uri: string, handleOrDid: string): string {
  return `https://bsky.app/starter-pack/${handleOrDid}/${rkeyOf(uri)}`;
}

export async function syncGroupDiscovery(
  agent: DiscoveryAgent,
  group: DiscoveryGroupInput,
  memberDids: string[],
  now: () => Date = () => new Date(),
): Promise<DiscoverySyncResult> {
  const repo = agent.session?.did;
  if (!repo) throw new Error('Curator account has no session.');
  const title = truncate(`${group.emoji ? `${group.emoji} ` : ''}${group.name}`.trim(), 50);
  const description = truncate(
    `Mirrors of the ${group.name} accounts on X, kept up to date automatically by tweets-2-bsky.`,
    300,
  );

  // 1. The list.
  let listUri = group.listUri;
  let createdList = false;
  if (!(await recordExists(agent, listUri, LIST_COLLECTION))) {
    const { data } = await agent.com.atproto.repo.createRecord({
      repo,
      collection: LIST_COLLECTION,
      record: {
        $type: LIST_COLLECTION,
        purpose: 'app.bsky.graph.defs#curatelist',
        name: title,
        description,
        createdAt: now().toISOString(),
      },
    });
    listUri = data.uri;
    createdList = true;
  }

  // 2. Its members: add who is missing, remove who left the group.
  const wanted = new Set(memberDids.filter((did) => did.startsWith('did:')));
  const existing = new Map<string, string[]>(); // subject -> listitem uris
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo,
      collection: LIST_ITEM_COLLECTION,
      limit: 100,
      cursor,
    });
    for (const record of data.records) {
      if (record.value?.list !== listUri || typeof record.value?.subject !== 'string') continue;
      const uris = existing.get(record.value.subject) ?? [];
      uris.push(record.uri);
      existing.set(record.value.subject, uris);
    }
    cursor = data.cursor;
    if (!cursor || data.records.length === 0) break;
  }

  let added = 0;
  for (const did of wanted) {
    if (existing.has(did)) continue;
    await agent.com.atproto.repo.createRecord({
      repo,
      collection: LIST_ITEM_COLLECTION,
      record: { $type: LIST_ITEM_COLLECTION, subject: did, list: listUri, createdAt: now().toISOString() },
    });
    added += 1;
  }
  let removed = 0;
  for (const [subject, uris] of existing) {
    // Duplicates of a wanted member go too; only one entry per account.
    const extra = wanted.has(subject) ? uris.slice(1) : uris;
    for (const uri of extra) {
      await agent.com.atproto.repo.deleteRecord({ repo, collection: LIST_ITEM_COLLECTION, rkey: rkeyOf(uri) });
      removed += 1;
    }
  }

  // 3. The starter pack pointing at the list.
  let starterPackUri = group.starterPackUri;
  let createdStarterPack = false;
  if (!(await recordExists(agent, starterPackUri, STARTER_PACK_COLLECTION))) {
    const { data } = await agent.com.atproto.repo.createRecord({
      repo,
      collection: STARTER_PACK_COLLECTION,
      record: {
        $type: STARTER_PACK_COLLECTION,
        name: title,
        description,
        list: listUri,
        createdAt: now().toISOString(),
      },
    });
    starterPackUri = data.uri;
    createdStarterPack = true;
  }

  return {
    listUri: listUri as string,
    starterPackUri: starterPackUri as string,
    added,
    removed,
    members: wanted.size,
    createdList,
    createdStarterPack,
  };
}
