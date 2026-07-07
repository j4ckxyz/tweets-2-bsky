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
}

export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  triggerClassName,
  contentClassName,
  disabled,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const contentWidth = content?.offsetWidth ?? 208;
    const left = align === 'end' ? rect.right - contentWidth : rect.left;
    setPosition({ top: rect.bottom + 6, left: Math.max(8, left) });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

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
        setOpen(false);
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
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        className={cn(
          'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/useKeyWithClickEvents: event-delegation container over focusable menu-item buttons
            <div
              ref={contentRef}
              id={menuId}
              role="menu"
              style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
              className={cn(
                'fixed z-50 min-w-[13rem] overflow-hidden rounded-lg border border-border bg-card py-1 text-sm shadow-lg shadow-black/10',
                contentClassName,
              )}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest('[data-keep-open="true"]')) {
                  return;
                }
                setOpen(false);
              }}
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
  return (
    <p className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>
  );
}

export function DropdownMenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
