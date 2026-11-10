// The table of contents in the left gutter of a reading page, such as "On this page" beside an article or "Versions"
// beside the changelog. It sticks at the top of the page's padding, so it does not move while the page scrolls, and
// marks the entry whose heading last passed the top third of the screen. It draws nothing for fewer than two entries.

import { cn } from '@workspace/ui/lib/utils';
import { useEffect, useMemo, useState } from 'react';

// An h2 of an article, or a release of the changelog with its short date as the detail.
export type TocItem = { id: string; text: string; level?: 2 | 3; detail?: string };

type ArticleTocProps = {
    toc: TocItem[];
    label?: string;
};

export function ArticleToc({ toc, label = 'On this page' }: ArticleTocProps) {
    const [activeId, setActiveId] = useState('');
    const entries = useMemo(() => toc.filter((entry) => entry.level !== 3), [toc]);

    // The observer reports a heading crossing the line a third down the screen, in whichever element scrolls, and once
    // as it starts, so a page opened at a `#section` marks its row. The entry is then the last heading above the line.
    useEffect(() => {
        const headings = entries
            .map((entry) => document.getElementById(entry.id))
            .filter((el): el is HTMLElement => el !== null);
        const observer = new IntersectionObserver(
            () => {
                const above = headings.filter(
                    (heading) => heading.getBoundingClientRect().top <= window.innerHeight / 3,
                );
                setActiveId(above.at(-1)?.id ?? '');
            },
            { rootMargin: '0px 0px -67% 0px' },
        );
        for (const heading of headings) observer.observe(heading);
        return () => observer.disconnect();
    }, [entries]);

    if (entries.length < 2) return null;

    return (
        <nav className="site-panel sticky top-12 max-h-[calc(100dvh-8rem)] overflow-y-auto text-sm leading-snug [scrollbar-width:none]">
            <p className="eigen-section-label mb-3 h-5 leading-5">{label}</p>
            <ul>
                {entries.map((entry) => (
                    <li key={entry.id}>
                        <a
                            href={`#${entry.id}`}
                            className={cn(
                                'flex justify-between gap-2 py-1 transition-colors hover:text-foreground',
                                entry.id === activeId ? 'font-medium text-foreground' : 'text-muted-foreground',
                            )}
                        >
                            {entry.text}
                            {entry.detail && (
                                <span className="font-normal text-muted-foreground tabular-nums">{entry.detail}</span>
                            )}
                        </a>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
