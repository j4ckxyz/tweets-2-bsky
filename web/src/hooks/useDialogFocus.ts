import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  );
}

/**
 * Focus for a modal surface: moves focus into it when it opens (the first
 * field, else the first control), keeps Tab inside it, and hands focus back to
 * whatever had it before once it closes. Escape is left to the caller.
 */
export function useDialogFocus(containerRef: RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    const container = containerRef.current;
    if (!open || !container) {
      return;
    }
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first =
      container.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ??
      focusableIn(container)[0];
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = focusableIn(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstElement || !container.contains(active))) {
        event.preventDefault();
        lastElement?.focus();
      } else if (!event.shiftKey && (active === lastElement || !container.contains(active))) {
        event.preventDefault();
        firstElement?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, open]);
}
