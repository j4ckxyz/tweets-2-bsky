import { Loader2, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

export function SystemSection() {
  const {
    canCreateMappings,
    handleRunUpdate,
    isAdmin,
    isUpdateBusy,
    openAddAccountSheet,
    runtimeBranchLabel,
    runtimeVersionLabel,
    settingsActiveSection,
    updateStateLabel,
    updateStatus,
  } = useDashboard();
  return settingsActiveSection === 'system' && isAdmin ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          Admin Settings
        </CardTitle>
        <CardDescription>Running version, updates, and quick account creation.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0 px-0 sm:px-0">
        <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Running Version</p>
              <p className="font-mono text-sm text-foreground">{runtimeVersionLabel}</p>
              {runtimeBranchLabel ? <p className="text-xs text-muted-foreground">{runtimeBranchLabel}</p> : null}
              <p className="text-xs text-muted-foreground">{updateStateLabel}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  void handleRunUpdate();
                }}
                disabled={isUpdateBusy || updateStatus?.running}
              >
                {isUpdateBusy || updateStatus?.running ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {updateStatus?.running ? 'Updating...' : 'Update'}
              </Button>
              {canCreateMappings ? (
                <Button className="w-full sm:w-auto" onClick={openAddAccountSheet}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Account
                </Button>
              ) : null}
            </div>
          </div>
          {updateStatus?.logTail && updateStatus.logTail.length > 0 ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Update log</summary>
              <pre className="mt-2 max-h-44 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {updateStatus.logTail.join('\n')}
              </pre>
            </details>
          ) : null}
        </div>
      </CardContent>
    </Card>
  ) : null;
}
