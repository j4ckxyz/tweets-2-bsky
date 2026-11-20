import { Save } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

export function TwitterSection() {
  const {
    handleSaveTwitterConfig,
    isAdmin,
    isBusy,
    setTwitterConfig,
    settingsActiveSection,
    twitterConfig,
    twitterConfigured,
  } = useDashboard();
  return settingsActiveSection === 'twitter' && isAdmin ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>X credentials</CardTitle>
            <CardDescription>Primary and backup cookie values.</CardDescription>
          </div>
          <Badge variant={twitterConfigured ? 'success' : 'outline'}>
            {twitterConfigured ? 'Configured' : 'Missing'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-1 px-0 sm:px-0">
        <form className="space-y-3" onSubmit={handleSaveTwitterConfig}>
          <div className="space-y-2">
            <Label htmlFor="authToken">Primary Auth Token</Label>
            <Input
              id="authToken"
              value={twitterConfig.authToken}
              onChange={(event) => {
                setTwitterConfig((prev) => ({ ...prev, authToken: event.target.value }));
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ct0">Primary CT0</Label>
            <Input
              id="ct0"
              value={twitterConfig.ct0}
              onChange={(event) => {
                setTwitterConfig((prev) => ({ ...prev, ct0: event.target.value }));
              }}
              required
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="backupAuthToken">Backup Auth Token</Label>
              <Input
                id="backupAuthToken"
                value={twitterConfig.backupAuthToken || ''}
                onChange={(event) => {
                  setTwitterConfig((prev) => ({ ...prev, backupAuthToken: event.target.value }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="backupCt0">Backup CT0</Label>
              <Input
                id="backupCt0"
                value={twitterConfig.backupCt0 || ''}
                onChange={(event) => {
                  setTwitterConfig((prev) => ({ ...prev, backupCt0: event.target.value }));
                }}
              />
            </div>
          </div>

          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
            <Save className="mr-2 h-4 w-4" />
            Save X credentials
          </Button>
        </form>
      </CardContent>
    </Card>
  ) : null;
}
