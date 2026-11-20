import { Link2 } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { Badge } from '../ui/badge';

// Collapsible list of fediverse-bridged accounts.
export function BridgeSummary() {
  const { bridgeEligibleUnbridgedMappings, bridgedMappingsForView, getProfileForActor } = useDashboard();
  return bridgedMappingsForView.length > 0 || bridgeEligibleUnbridgedMappings.length > 0 ? (
    <details className="rounded-lg border border-border/70 bg-muted/20 text-sm">
      <summary className="cursor-pointer list-none px-3 py-2.5 text-xs text-muted-foreground">
        <span className="font-medium">Fediverse Bridge</span> — {bridgedMappingsForView.length} bridged,{' '}
        {bridgeEligibleUnbridgedMappings.length} eligible now
      </summary>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 p-3 pt-2.5">
        {bridgedMappingsForView.slice(0, 24).map((mapping) => {
          const profile = getProfileForActor(mapping.bskyIdentifier);
          const handle = profile?.handle || mapping.bskyIdentifier;
          return (
            <Badge key={`bridged-list-${mapping.id}`} variant="success">
              <Link2 className="h-3 w-3" />@{handle}
            </Badge>
          );
        })}
        {bridgedMappingsForView.length > 24 ? (
          <Badge variant="outline">+{bridgedMappingsForView.length - 24} more</Badge>
        ) : null}
      </div>
    </details>
  ) : null;
}
