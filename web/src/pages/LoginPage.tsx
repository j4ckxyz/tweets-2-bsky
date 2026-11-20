import { Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { useDashboard } from '../lib/dashboard-context';

// Sign-in / first-user registration screen.
export function LoginPage() {
  const { authError, authView, bootstrapOpen, handleLogin, handleRegister, isBusy, setAuthError, setAuthView } =
    useDashboard();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm animate-fade-in shadow-[0_12px_32px_-12px_oklch(var(--foreground)/0.18)]">
        <CardHeader className="gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="airmail-mark h-6 w-6 shrink-0 rounded-md ring-1 ring-inset ring-foreground/10"
              aria-hidden="true"
            />
            <CardTitle className="text-lg">tweets-2-bsky</CardTitle>
          </div>
          <CardDescription>
            {authView === 'login'
              ? 'Sign in to manage mappings, status, and account settings.'
              : 'Create your first dashboard account.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {authError ? (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500 dark:text-red-300">
              {authError}
            </div>
          ) : null}

          <form className="space-y-4" onSubmit={authView === 'login' ? handleLogin : handleRegister}>
            {authView === 'login' ? (
              <div className="space-y-2">
                <Label htmlFor="identifier">Email or Username</Label>
                <Input id="identifier" name="identifier" autoComplete="username" required />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input id="username" name="username" autoComplete="username" placeholder="optional" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" autoComplete="email" placeholder="optional" />
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>

            <Button className="w-full" type="submit" disabled={isBusy}>
              {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {authView === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          {bootstrapOpen || authView === 'register' ? (
            <Button
              className="mt-4 w-full"
              variant="ghost"
              onClick={() => {
                setAuthError('');
                setAuthView(authView === 'login' ? 'register' : 'login');
              }}
              type="button"
            >
              {authView === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
            </Button>
          ) : (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              Account creation is disabled. Ask an admin to create your user.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
