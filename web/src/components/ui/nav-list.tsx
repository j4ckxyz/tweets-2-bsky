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
}

export function NavList<T extends string>({ items, activeId, onSelect, className }: NavListProps<T>) {
  return (
    <nav className={cn('flex flex-col gap-0.5', className)}>
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
              isActive ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.badge}
          </button>
        );
      })}
    </nav>
  );
}
