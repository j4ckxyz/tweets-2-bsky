import { Folder } from 'lucide-react';
import { isDefaultFolderEmoji } from '../lib/folders';
import { cn } from '../lib/utils';

export function FolderGlyph({ emoji, className }: { emoji?: string; className?: string }) {
  if (isDefaultFolderEmoji(emoji)) {
    return <Folder className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className)} aria-hidden="true" />;
  }
  return <span className={className}>{emoji}</span>;
}
