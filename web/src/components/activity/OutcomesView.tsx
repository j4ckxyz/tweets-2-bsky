import { ArrowUpRight, History } from 'lucide-react';
import { selectClassName } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { folderText } from '../../lib/folders';
import { getBskyPostUrl, getMappingGroupMeta, getTwitterPostUrl } from '../../lib/format';
import { FolderGlyph } from '../FolderGlyph';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Label } from '../ui/label';

// Recent migration outcomes.
export function OutcomesView() {
  const {
    activityGroupFilter,
    activityView,
    filteredRecentActivity,
    groupOptions,
    resolveMappingForActivity,
    setActivityGroupFilter,
  } = useDashboard();
  return activityView === 'outcomes' ? (
    <Card className="">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              Recent Activity
            </CardTitle>
            <CardDescription>Latest migration outcomes from the processing database.</CardDescription>
          </div>
          <div className="w-full max-w-xs">
            <Label htmlFor="activity-group-filter">Filter group</Label>
            <select
              id="activity-group-filter"
              className={selectClassName}
              value={activityGroupFilter}
              onChange={(event) => setActivityGroupFilter(event.target.value)}
            >
              <option value="all">All folders</option>
              {groupOptions.map((group) => (
                <option key={`activity-filter-${group.key}`} value={group.key}>
                  {folderText(group.emoji, group.name)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-border text-xs font-medium text-muted-foreground">
              <tr>
                <th className="px-2 py-3">Time</th>
                <th className="px-2 py-3">Twitter User</th>
                <th className="px-2 py-3">Group</th>
                <th className="px-2 py-3">Status</th>
                <th className="px-2 py-3">Details</th>
                <th className="px-2 py-3 text-right">Link</th>
              </tr>
            </thead>
            <tbody>
              {filteredRecentActivity.map((activity, index) => {
                const href = getBskyPostUrl(activity);
                const sourceTweetUrl = getTwitterPostUrl(activity.twitter_username, activity.twitter_id);
                const mapping = resolveMappingForActivity(activity);
                const groupMeta = getMappingGroupMeta(mapping);

                return (
                  <tr
                    key={`${activity.twitter_id}-${activity.created_at || index}`}
                    className="interactive-row border-b border-border/60 last:border-0"
                  >
                    <td className="px-2 py-3 align-top text-xs text-muted-foreground">
                      {activity.created_at
                        ? new Date(activity.created_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '--'}
                    </td>
                    <td className="px-2 py-3 align-top font-medium">@{activity.twitter_username}</td>
                    <td className="px-2 py-3 align-top">
                      <Badge variant="outline">
                        <FolderGlyph emoji={groupMeta.emoji} />
                        {groupMeta.name}
                      </Badge>
                    </td>
                    <td className="px-2 py-3 align-top">
                      {activity.status === 'migrated' ? (
                        <Badge variant="success">Migrated</Badge>
                      ) : activity.status === 'skipped' ? (
                        <Badge variant="outline">Skipped</Badge>
                      ) : (
                        <Badge variant="danger">Failed</Badge>
                      )}
                    </td>
                    <td className="px-2 py-3 align-top text-xs text-muted-foreground">
                      <div className="max-w-[340px] truncate">
                        {activity.tweet_text || `Tweet ID: ${activity.twitter_id}`}
                      </div>
                    </td>
                    <td className="px-2 py-3 align-top text-right">
                      <div className="flex flex-col items-end gap-1">
                        {sourceTweetUrl ? (
                          <a
                            className="inline-flex items-center text-xs text-foreground underline-offset-4 hover:underline"
                            href={sourceTweetUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Source
                            <ArrowUpRight className="ml-1 h-3 w-3" />
                          </a>
                        ) : null}
                        {href ? (
                          <a
                            className="inline-flex items-center text-xs text-foreground underline-offset-4 hover:underline"
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Bluesky
                            <ArrowUpRight className="ml-1 h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">--</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredRecentActivity.length === 0 ? (
                <tr>
                  <td className="px-2 py-6 text-center text-sm text-muted-foreground" colSpan={6}>
                    No activity for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  ) : null;
}
