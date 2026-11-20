import { useDashboard } from '../lib/dashboard-context';
import { formatRelativeTime } from '../lib/format';
import { Button } from './ui/button';
import { Card } from './ui/card';

// Unavailable Bluesky accounts, shown on Overview.
export function AccountAlertsBanner() {
  const { accountAlerts, activeTab, recheckAccount } = useDashboard();
  return activeTab === 'overview' && accountAlerts.length > 0 ? (
    <Card className="mb-6 overflow-hidden border-late/40">
      <div className="border-b border-late/25 bg-late/[0.07] px-4 py-2.5">
        <p className="text-sm font-semibold text-late">
          {accountAlerts.length === 1
            ? '1 Bluesky account is unavailable'
            : `${accountAlerts.length} Bluesky accounts are unavailable`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Posting to these is paused. Nothing is lost — their tweets stay queued until the account works again.
        </p>
      </div>
      <ul className="divide-y divide-border">
        {accountAlerts.map((alert) => (
          <li key={alert.mappingId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{alert.reason}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {alert.twitterUsernames.length > 0 ? `@${alert.twitterUsernames.join(', @')} · ` : ''}
                {alert.queuedTweets} tweet{alert.queuedTweets === 1 ? '' : 's'} waiting · detected{' '}
                {formatRelativeTime(alert.detectedAt)} · next automatic check {formatRelativeTime(alert.nextRecheckAt)}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => recheckAccount(alert.mappingId, alert.bskyIdentifier)}>
              Check again
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  ) : null;
}
