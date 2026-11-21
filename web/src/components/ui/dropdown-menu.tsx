import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

interface DropdownMenuProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'end';
  triggerClassName?: string;
  contentClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  triggerClassName,
  contentClassName,
  disabled,
  ariaLabel,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const contentWidth = content?.offsetWidth ?? 208;
    // scrollHeight is the full height even once maxHeight has clipped the menu.
    const contentHeight = content?.scrollHeight ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    // Open upward only when the menu does not fit below and there is more room above.
    const openUp = contentHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(0, openUp ? spaceAbove : spaceBelow);
    const top = openUp ? rect.top - gap - Math.min(contentHeight, maxHeight) : rect.bottom + gap;
    const preferredLeft = align === 'end' ? rect.right - contentWidth : rect.left;
    const left = Math.max(margin, Math.min(preferredLeft, window.innerWidth - contentWidth - margin));
    setPosition({ top, left, maxHeight });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  // Closing from inside the menu (an item, Escape, Tab) hands focus back to the
  // trigger; a click elsewhere on the page leaves focus where it landed.
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const menuItems = () => [
    ...(contentRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    // Arrow keys inside the embedded sync-source select keep their own meaning.
    const target = event.target as HTMLElement;
    if (target.closest('select, input, textarea')) return;
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu(true);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [closeMenu, open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-input bg-card px-3 text-[13px] font-medium text-foreground transition-colors hover:border-foreground/25 hover:bg-muted disabled:pointer-events-none disabled:opacity-50',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            <div
              ref={contentRef}
              id={menuId}
              role="menu"
              style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, maxHeight: position?.maxHeight }}
              className={cn(
                'fixed z-50 min-w-[13rem] overflow-y-auto overscroll-contain rounded-lg border border-border bg-card py-1 text-sm shadow-[0_8px_24px_-6px_oklch(var(--foreground)/0.18),0_2px_4px_oklch(var(--foreground)/0.06)] animate-fade-in',
                contentClassName,
              )}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest('[data-keep-open="true"]')) {
                  return;
                }
                closeMenu(true);
              }}
              onKeyDown={handleMenuKeyDown}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

interface DropdownMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  destructive?: boolean;
  icon?: React.ReactNode;
}

export function DropdownMenuItem({ destructive, icon, className, children, ...props }: DropdownMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40',
        destructive ? 'text-red-600 hover:bg-red-500/10 dark:text-red-300' : 'text-foreground',
        className,
      )}
      {...props}
    >
      {icon ? <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>;
}

export function DropdownMenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
