import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useState } from 'react';
import type { TocEntry } from '../../content/manifest';

// The on-this-page list. Highlights the heading currently scrolled into view.
export function ArticleToc({ toc }: { toc: TocEntry[] }) {
    const [activeId, setActiveId] = useState('');

    useEffect(() => {
        const headings = toc
            .map((entry) => document.getElementById(entry.id))
            .filter((el): el is HTMLElement => el !== null);
        if (headings.length === 0) return;

        // The band is the top third of the viewport; the topmost heading inside
        // it is active. When nothing is in the band the previous one stays.
        const visible = new Map<string, boolean>();
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
                const active = toc.find((entry) => visible.get(entry.id));
                if (active) setActiveId(active.id);
            },
            { rootMargin: '0px 0px -66% 0px' },
        );
        for (const heading of headings) observer.observe(heading);
        return () => observer.disconnect();
    }, [toc]);

    return (
        <nav className="text-sm">
            {toc.map((entry) => (
                <a
                    key={entry.id}
                    href={`#${entry.id}`}
                    className={cn(
                        'block rounded px-2 py-1 hover:bg-muted hover:text-foreground',
                        entry.level === 3 && 'pl-5',
                        entry.id === activeId ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                >
                    {entry.text}
                </a>
            ))}
        </nav>
    );
}
