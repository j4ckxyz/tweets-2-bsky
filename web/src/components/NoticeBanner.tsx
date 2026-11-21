import { X } from 'lucide-react';
import { useDashboard } from '../lib/dashboard-context';
import { cn } from '../lib/utils';

// Floats above the page, the add-account sheet and the edit dialog (all z-50),
// so a result is seen wherever the action was taken. Both live regions stay
// mounted so screen readers announce a notice as it appears.
export function NoticeBanner() {
  const { notice, setNotice } = useDashboard();
  const content = notice ? (
    <div className="pointer-events-auto rounded-md bg-card shadow-[0_8px_24px_-6px_oklch(var(--foreground)/0.18),0_2px_4px_oklch(var(--foreground)/0.06)] animate-fade-in">
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
          notice.tone === 'success' &&
            'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300',
          notice.tone === 'error' &&
            'border-red-500/40 bg-red-500/10 text-red-700 dark:border-red-500/30 dark:text-red-300',
          notice.tone === 'info' && 'border-border bg-muted text-muted-foreground',
        )}
      >
        <p className="min-w-0 flex-1 break-words">{notice.message}</p>
        <button
          type="button"
          className="-mr-1 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
          onClick={() => setNotice(null)}
          aria-label="Dismiss notice"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  ) : null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] mx-auto w-full max-w-xl px-4">
      {/* biome-ignore lint/a11y/useSemanticElements: a page-level live region, not a form result */}
      <div role="status">{notice?.tone !== 'error' ? content : null}</div>
      <div role="alert">{notice?.tone === 'error' ? content : null}</div>
    </div>
  );
}
