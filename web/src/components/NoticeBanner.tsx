import { useDashboard } from '../lib/dashboard-context';
import { cn } from '../lib/utils';

export function NoticeBanner() {
  const { notice } = useDashboard();
  return notice ? (
    <div
      className={cn(
        'mb-5 rounded-md border px-3 py-2 text-sm',
        notice.tone === 'success' &&
          'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300',
        notice.tone === 'error' &&
          'border-red-500/40 bg-red-500/10 text-red-700 dark:border-red-500/30 dark:text-red-300',
        notice.tone === 'info' && 'border-border bg-muted text-muted-foreground',
      )}
    >
      {notice.message}
    </div>
  ) : null;
}
