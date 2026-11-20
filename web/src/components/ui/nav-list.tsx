import { cn } from '../../lib/utils';

export interface NavListItem<T extends string> {
  id: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: React.ReactNode;
}

interface NavListProps<T extends string> {
  items: Array<NavListItem<T>>;
  activeId: T;
  onSelect: (id: T) => void;
  className?: string;
  ariaLabel?: string;
}

export function NavList<T extends string>({ items, activeId, onSelect, className, ariaLabel }: NavListProps<T>) {
  return (
    <nav className={cn('flex flex-col gap-0.5', className)} role="tablist" aria-label={ariaLabel ?? 'Navigation Tabs'}>
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(item.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
              isActive
                ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_oklch(var(--foreground)/0.08)] ring-1 ring-border'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            {Icon ? <Icon className={cn('h-4 w-4 shrink-0', isActive && 'text-primary')} /> : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.badge}
          </button>
        );
      })}
    </nav>
  );
}
