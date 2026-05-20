import { cn } from '@workspace/ui/lib/utils';
import type { TocEntry } from '../../content/manifest';

// The on-this-page list. Rendered only when there are 2+ headings.
export function ArticleToc({ toc }: { toc: TocEntry[] }) {
    return (
        <nav className="h-full overflow-y-auto p-3 text-sm">
            {toc.map((entry) => (
                <a
                    key={entry.id}
                    href={`#${entry.id}`}
                    className={cn(
                        'block rounded px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-muted',
                        entry.level === 3 && 'pl-5',
                    )}
                >
                    {entry.text}
                </a>
            ))}
        </nav>
    );
}
