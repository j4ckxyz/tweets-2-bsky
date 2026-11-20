import { PERMISSION_OPTIONS } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

export function AccessScopeSection() {
  const { effectivePermissions, isAdmin, settingsActiveSection } = useDashboard();
  return settingsActiveSection === 'account' && !isAdmin ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <CardTitle>Access scope</CardTitle>
        <CardDescription>Your current account permissions.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 pt-0 px-0 sm:px-0">
        {PERMISSION_OPTIONS.filter((permission) => effectivePermissions[permission.key]).map((permission) => (
          <Badge key={`self-perm-${permission.key}`} variant="outline">
            {permission.label}
          </Badge>
        ))}
      </CardContent>
    </Card>
  ) : null;
}
