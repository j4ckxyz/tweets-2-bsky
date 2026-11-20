import { useQuery } from '@tanstack/react-query';
// Per-folder Bluesky list + starter pack, so readers can follow a whole set of
// mirrors in one tap. Lives in the folder manager: a folder is exactly the set
// a starter pack should hold.
import axios from 'axios';
import { ExternalLink, Loader2, Users } from 'lucide-react';
import { useCallback, useState } from 'react';
import * as api from '../lib/api';
import { selectClassName } from '../lib/constants';
import { queryKeys } from '../lib/query-keys';
import type { DiscoveryState } from '../lib/types';
import { Button } from './ui/button';
import { Label } from './ui/label';

interface DiscoveryPanelProps {
  authHeaders: Record<string, string>;
  isAdmin: boolean;
  folders: { key: string; name: string; emoji: string; members: number }[];
  accounts: { id: string; bskyIdentifier: string }[];
  notify: (tone: 'success' | 'error' | 'info', message: string) => void;
}

/** bsky.app link for a starter pack from its at:// URI. */
function starterPackLink(uri: string): string | null {
  const match = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.graph\.starterpack\/([^/]+)$/);
  return match ? `https://bsky.app/starter-pack/${match[1]}/${match[2]}` : null;
}

export function DiscoveryPanel({ authHeaders, isAdmin, folders, accounts, notify }: DiscoveryPanelProps) {
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A failed load falls back to "nothing configured" rather than an error.
  const discoveryQuery = useQuery({
    queryKey: queryKeys.discovery,
    queryFn: async (): Promise<DiscoveryState> => {
      try {
        const response = await api.getDiscovery({ headers: authHeaders });
        return response.data;
      } catch {
        return { curatorMappingId: null, groups: [] };
      }
    },
  });
  const state = discoveryQuery.data ?? null;
  const { refetch } = discoveryQuery;
  const load = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const setCurator = async (curatorMappingId: string) => {
    setBusyKey('curator');
    try {
      await api.saveDiscovery({ curatorMappingId: curatorMappingId || undefined }, { headers: authHeaders });
      await load();
      notify('success', curatorMappingId ? 'Curator account saved.' : 'Curator account cleared.');
    } catch (error) {
      notify('error', axios.isAxiosError(error) ? (error.response?.data?.error ?? error.message) : 'Could not save.');
    } finally {
      setBusyKey(null);
    }
  };

  const sync = async (folderKey: string, folderName: string) => {
    setBusyKey(folderKey);
    try {
      const response = await api.syncGroupDiscovery(folderName, {}, { headers: authHeaders });
      notify('success', response.data.message);
      await load();
    } catch (error) {
      notify(
        'error',
        axios.isAxiosError(error) ? (error.response?.data?.error ?? error.message) : 'Could not sync the starter pack.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  if (!state) return null;
  const byName = new Map(state.groups.map((group) => [group.name.trim().toLowerCase(), group]));

  return (
    <div className="space-y-3 border-t border-border/70 pt-3">
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          Starter packs
        </p>
        <p className="text-xs text-muted-foreground">
          Each folder can have a Bluesky list and starter pack, so people follow all of its mirrors in one tap. They
          stay in step with the folder automatically once created.
        </p>
      </div>
      {isAdmin ? (
        <div className="space-y-1">
          <Label htmlFor="discovery-curator">Owned by</Label>
          <select
            id="discovery-curator"
            className={selectClassName}
            value={state.curatorMappingId ?? ''}
            disabled={busyKey !== null}
            onChange={(event) => void setCurator(event.target.value)}
          >
            <option value="">Choose an account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.bskyIdentifier}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {folders.length === 0 ? (
        <p className="text-xs text-muted-foreground">Create a folder to give it a starter pack.</p>
      ) : (
        <div className="space-y-1.5">
          {folders.map((folder) => {
            const existing = byName.get(folder.name.trim().toLowerCase());
            const link = existing?.starterPackUri ? starterPackLink(existing.starterPackUri) : null;
            return (
              <div key={`discovery-${folder.key}`} className="flex items-center gap-2 text-sm">
                <span className="shrink-0">{folder.emoji}</span>
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                {link ? (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={busyKey !== null || !state.curatorMappingId || folder.members === 0}
                  title={
                    !state.curatorMappingId
                      ? 'Choose the account that owns the starter packs first'
                      : folder.members === 0
                        ? 'This folder has no accounts yet'
                        : undefined
                  }
                  onClick={() => void sync(folder.key, folder.name)}
                >
                  {busyKey === folder.key ? <Loader2 className="h-3 w-3 animate-spin" /> : link ? 'Update' : 'Create'}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
