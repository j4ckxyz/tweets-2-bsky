import { Save } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

export function AccountSecuritySection() {
  const {
    emailForm,
    handleChangeOwnEmail,
    handleChangeOwnPassword,
    hasCurrentEmail,
    isBusy,
    passwordForm,
    setEmailForm,
    setPasswordForm,
    settingsActiveSection,
  } = useDashboard();
  return settingsActiveSection === 'account' ? (
    <Card className="rounded-none border-0 border-t bg-transparent">
      <CardHeader className="px-0 pb-3 pt-6 sm:px-0">
        <CardTitle>Account security</CardTitle>
        <CardDescription>Update your own email/password with verification.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 pt-1 lg:grid-cols-2 px-0 sm:px-0">
        <form className="space-y-3" onSubmit={handleChangeOwnEmail}>
          <p className="pt-2 text-sm font-semibold">Change email</p>
          <div className="space-y-2">
            <Label htmlFor="account-current-email">Current email</Label>
            <Input
              id="account-current-email"
              type="email"
              value={emailForm.currentEmail}
              onChange={(event) => {
                setEmailForm((previous) => ({ ...previous, currentEmail: event.target.value }));
              }}
              placeholder={hasCurrentEmail ? undefined : 'No current email on this account'}
              required={hasCurrentEmail}
              disabled={!hasCurrentEmail}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-new-email">New email</Label>
            <Input
              id="account-new-email"
              type="email"
              value={emailForm.newEmail}
              onChange={(event) => {
                setEmailForm((previous) => ({ ...previous, newEmail: event.target.value }));
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-email-password">Current password</Label>
            <Input
              id="account-email-password"
              type="password"
              value={emailForm.password}
              onChange={(event) => {
                setEmailForm((previous) => ({ ...previous, password: event.target.value }));
              }}
              required
            />
          </div>
          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
            <Save className="mr-2 h-4 w-4" />
            Save email
          </Button>
        </form>

        <form className="space-y-3" onSubmit={handleChangeOwnPassword}>
          <p className="pt-2 text-sm font-semibold">Change password</p>
          <div className="space-y-2">
            <Label htmlFor="account-current-password">Current password</Label>
            <Input
              id="account-current-password"
              type="password"
              value={passwordForm.currentPassword}
              onChange={(event) => {
                setPasswordForm((previous) => ({ ...previous, currentPassword: event.target.value }));
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-new-password">New password</Label>
            <Input
              id="account-new-password"
              type="password"
              value={passwordForm.newPassword}
              onChange={(event) => {
                setPasswordForm((previous) => ({ ...previous, newPassword: event.target.value }));
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-confirm-password">Confirm new password</Label>
            <Input
              id="account-confirm-password"
              type="password"
              value={passwordForm.confirmPassword}
              onChange={(event) => {
                setPasswordForm((previous) => ({ ...previous, confirmPassword: event.target.value }));
              }}
              required
            />
          </div>
          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
            <Save className="mr-2 h-4 w-4" />
            Save password
          </Button>
        </form>
      </CardContent>
    </Card>
  ) : null;
}
