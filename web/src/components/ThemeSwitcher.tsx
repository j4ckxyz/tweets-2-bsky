import { Moon, Sun, SunMoon } from 'lucide-react';
import { useDashboard } from '../lib/dashboard-context';
import { cn } from '../lib/utils';

// Auto / Light / Dark segmented control in the sidebar.
export function ThemeSwitcher() {
  const { setThemeMode, themeLabel, themeMode } = useDashboard();
  return (
    <fieldset className="grid grid-cols-3 rounded-md border border-border bg-background/60 p-0.5" title={themeLabel}>
      <legend className="sr-only">Theme</legend>
      {(
        [
          { mode: 'system', label: 'Auto', Icon: SunMoon },
          { mode: 'light', label: 'Light', Icon: Sun },
          { mode: 'dark', label: 'Dark', Icon: Moon },
        ] as const
      ).map(({ mode, label, Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={themeMode === mode}
          onClick={() => setThemeMode(mode)}
          className={cn(
            'flex h-6 items-center justify-center gap-1 rounded-[4px] text-[11px] transition-colors duration-150',
            themeMode === mode
              ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_oklch(var(--foreground)/0.1)]'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </fieldset>
  );
}
