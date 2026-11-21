import { AccessScopeSection } from '../components/settings/AccessScopeSection';
import { AccountSecuritySection } from '../components/settings/AccountSecuritySection';
import { AiSection } from '../components/settings/AiSection';
import { DataSection } from '../components/settings/DataSection';
import { SessionSection } from '../components/settings/SessionSection';
import { SystemSection } from '../components/settings/SystemSection';
import { TwitterSection } from '../components/settings/TwitterSection';
import { UsersSection } from '../components/settings/UsersSection';
import { NavList } from '../components/ui/nav-list';
import { useDashboard } from '../lib/dashboard-context';

export function SettingsPage() {
  const { setSettingsActiveSection, settingsActiveSection, settingsNavItems } = useDashboard();
  return (
    <section className="grid gap-6 lg:grid-cols-[180px_1fr] animate-fade-in">
      <div className="h-fit min-w-0 lg:sticky lg:top-6">
        <NavList
          items={settingsNavItems}
          activeId={settingsActiveSection}
          onSelect={setSettingsActiveSection}
          ariaLabel="Settings sections"
          className="flex-row overflow-x-auto lg:flex-col"
        />
      </div>

      <div className="min-w-0 space-y-6">
        <AccountSecuritySection />

        <AccessScopeSection />

        <SessionSection />

        <SystemSection />

        <UsersSection />

        <TwitterSection />

        <AiSection />

        <DataSection />
      </div>
    </section>
  );
}
