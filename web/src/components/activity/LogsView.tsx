import { ChevronDown, ChevronRight, Download, History, Loader2, RefreshCw, Save } from 'lucide-react';
import { Fragment } from 'react';
import { LOG_LEVEL_BADGE, LOG_LEVEL_ROW, LOG_STAGES, selectClassName } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import type { LogLevel } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { DebouncedInput } from '../ui/debounced-input';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '../ui/dropdown-menu';
import { Label } from '../ui/label';

// System log viewer.
export function LogsView() {
  const {
    activityView,
    clearLogs,
    copyLogsToClipboard,
    downloadDiagnostics,
    downloadLogs,
    expandedLogId,
    fetchLogs,
    isAdmin,
    logAutoRefresh,
    logEntries,
    logHasMore,
    logLevelFilter,
    logLimit,
    logSearch,
    logStageFilter,
    logsLoading,
    setExpandedLogId,
    setLogAutoRefresh,
    setLogLevelFilter,
    setLogLimit,
    setLogSearch,
    setLogStageFilter,
  } = useDashboard();
  return activityView === 'logs' ? (
    <Card className="">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              System log
            </CardTitle>
            <CardDescription>
              Everything the pipeline did, with the reason behind each outcome. Copy or download exactly what you have
              filtered.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void fetchLogs()} disabled={logsLoading}>
              {logsLoading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={() => void copyLogsToClipboard()}>
              <Save className="mr-1 h-3.5 w-3.5" />
              Copy
            </Button>
            <DropdownMenu
              trigger={
                <Button size="sm" variant="outline">
                  <Download className="mr-1 h-3.5 w-3.5" />
                  Download
                  <ChevronDown className="ml-1 h-3.5 w-3.5" />
                </Button>
              }
            >
              <DropdownMenuLabel>Export current filter</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => void downloadLogs('txt')}>Plain text (.log)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void downloadLogs('json')}>JSON</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void downloadLogs('ndjson')}>
                NDJSON (one entry per line)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void downloadLogs('csv')}>CSV (spreadsheet)</DropdownMenuItem>
              {isAdmin ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Support</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => void downloadDiagnostics()}>
                    Full diagnostics bundle
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onClick={() => void clearLogs()}>
                    Clear stored logs
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="log-level-filter">Minimum level</Label>
            <select
              id="log-level-filter"
              className={selectClassName}
              value={logLevelFilter}
              onChange={(event) => setLogLevelFilter(event.target.value as 'all' | LogLevel)}
            >
              <option value="all">Everything</option>
              <option value="debug">Debug and above</option>
              <option value="info">Info and above</option>
              <option value="warn">Warnings and errors</option>
              <option value="error">Errors only</option>
            </select>
          </div>
          <div>
            <Label htmlFor="log-stage-filter">Pipeline stage</Label>
            <select
              id="log-stage-filter"
              className={selectClassName}
              value={logStageFilter}
              onChange={(event) => setLogStageFilter(event.target.value)}
            >
              <option value="all">All stages</option>
              {LOG_STAGES.map((stage) => (
                <option key={`log-stage-${stage}`} value={stage}>
                  {stage}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="log-search">Search</Label>
            <DebouncedInput
              id="log-search"
              placeholder="handle, tweet id, error text…"
              value={logSearch}
              onChange={setLogSearch}
            />
          </div>
          <div>
            <Label htmlFor="log-limit">Entries</Label>
            <select
              id="log-limit"
              className={selectClassName}
              value={String(logLimit)}
              onChange={(event) => setLogLimit(Number(event.target.value))}
            >
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={logAutoRefresh}
              onChange={(event) => setLogAutoRefresh(event.target.checked)}
            />
            Live tail (refresh every 5s)
          </label>
          <span>
            Showing {logEntries.length} entr{logEntries.length === 1 ? 'y' : 'ies'}
            {logHasMore ? ' (more available — raise the entry count)' : ''}
          </span>
        </div>

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-muted/40 font-medium text-muted-foreground">
              <tr>
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Level</th>
                <th className="px-2 py-2">Stage</th>
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">What happened</th>
              </tr>
            </thead>
            <tbody>
              {logEntries.map((entry) => {
                const expanded = expandedLogId === entry.id;
                const hasDetail = Boolean(entry.error || (entry.detail && Object.keys(entry.detail).length > 0));
                return (
                  <Fragment key={`log-${entry.id}`}>
                    <tr className={cn('border-b border-border/60 align-top last:border-0', LOG_LEVEL_ROW[entry.level])}>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">
                        {new Date(entry.ts).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </td>
                      <td className={cn('whitespace-nowrap px-2 py-2 font-semibold', LOG_LEVEL_BADGE[entry.level])}>
                        {entry.level.toUpperCase()}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{entry.stage}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono">
                        {entry.twitterUsername ? `@${entry.twitterUsername}` : '--'}
                      </td>
                      <td className="px-2 py-2">
                        {/* The expander is a real button rather than a clickable row so
                                          it stays reachable by keyboard and screen readers. */}
                        <button
                          type="button"
                          className="flex w-full items-start gap-1 text-left"
                          disabled={!hasDetail}
                          aria-expanded={hasDetail ? expanded : undefined}
                          onClick={() => setExpandedLogId(expanded ? null : entry.id)}
                        >
                          {hasDetail ? (
                            <ChevronRight
                              className={cn(
                                'mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                                expanded && 'rotate-90',
                              )}
                            />
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                          <span className="min-w-0">
                            <span className="block break-words">{entry.message}</span>
                            <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                              {entry.event}
                              {entry.twitterId ? ` · tweet ${entry.twitterId}` : ''}
                              {typeof entry.attempt === 'number' ? ` · attempt ${entry.attempt}` : ''}
                              {typeof entry.durationMs === 'number' ? ` · ${entry.durationMs}ms` : ''}
                            </span>
                          </span>
                        </button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-b border-border/60">
                        <td colSpan={5} className="bg-muted/30 px-4 py-3">
                          {entry.error ? (
                            <div className="mb-2">
                              <p className="text-[11px] font-medium text-muted-foreground">Error</p>
                              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                                {[
                                  entry.error.name,
                                  entry.error.status ? `HTTP ${entry.error.status}` : null,
                                  entry.error.code,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                                {'\n'}
                                {entry.error.message}
                                {entry.error.stack ? `\n\n${entry.error.stack}` : ''}
                              </pre>
                            </div>
                          ) : null}
                          {entry.detail && Object.keys(entry.detail).length > 0 ? (
                            <div>
                              <p className="text-[11px] font-medium text-muted-foreground">Detail</p>
                              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                                {JSON.stringify(entry.detail, null, 2)}
                              </pre>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {logEntries.length === 0 ? (
                <tr>
                  <td className="px-2 py-6 text-center text-sm text-muted-foreground" colSpan={5}>
                    {logsLoading ? 'Loading logs…' : 'No log entries match these filters.'}
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
