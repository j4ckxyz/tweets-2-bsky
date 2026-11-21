import { LogOut } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { ThemeSwitcher } from '../ThemeSwitcher';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

// Theme and sign-out live in the desktop rail; below 1024px the rail is not
// shown, so they are offered here instead.
export function SessionSection() {
  const { handleLogout, settingsActiveSection } = useDashboard();
  return settingsActiveSection === 'account' ? (
    <Card className="rounded-none border-0 border-t bg-transparent lg:hidden">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <CardTitle>This device</CardTitle>
        <CardDescription>Theme and sign-out.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 px-0 pt-0 sm:px-0">
        <div className="w-full max-w-xs">
          <ThemeSwitcher />
        </div>
        <Button size="sm" variant="outline" onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </CardContent>
    </Card>
  ) : null;
}
