import { cn } from '../lib/utils';

// The tweets-2-bsky mark: a post (the solid square) handed on to its mirror
// (the ring). Ink follows the text colour; the ring is the brand blue.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="1 7 21.6 10" className={cn('shrink-0', className)} aria-hidden="true" focusable="false">
      <rect x="2" y="8" width="8" height="8" rx="2.2" fill="currentColor" />
      <path d="M10.5 12h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="17.6" cy="12" r="3.7" fill="none" stroke="oklch(var(--primary))" strokeWidth="2.2" />
    </svg>
  );
}
