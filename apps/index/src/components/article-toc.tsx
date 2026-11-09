// The table of contents in the left gutter of a reading page, such as "On this page" beside an article or "Versions"
// beside the changelog. It sticks at the top of the page's padding, so it does not move while the page scrolls,
// and marks the entry whose heading last passed the top third of the screen. It draws nothing for fewer than two entries.

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

    useEffect(() => {
        const headings = entries
            .map((entry) => document.getElementById(entry.id))
            .filter((el): el is HTMLElement => el !== null);
        if (headings.length === 0) return;

        // Scroll events do not bubble, so the capture phase on the document hears whichever div scrolls. The active
        // entry is the last heading above the top third of the screen, or the last entry at the end of the scroller,
        // which a short page never lets a heading reach the top third.
        const onScroll = (event: Event) => {
            const scroller =
                event.target instanceof Element
                    ? event.target
                    : (document.scrollingElement ?? document.documentElement);
            if (!scroller.contains(headings[0])) return;
            const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
            const line = window.innerHeight / 3;
            const above = headings.filter((heading) => heading.getBoundingClientRect().top <= line);
            const active = atBottom ? headings[headings.length - 1] : above[above.length - 1];
            if (active) setActiveId(active.id);
        };
        document.addEventListener('scroll', onScroll, true);
        return () => document.removeEventListener('scroll', onScroll, true);
    }, [entries]);

    if (entries.length < 2) return null;

    return (
        <nav className="sticky top-12 max-h-[calc(100dvh-8rem)] overflow-y-auto text-[0.8125rem] leading-snug [scrollbar-width:none]">
            <p className="mb-3 h-5 text-xs leading-5 font-medium tracking-wider text-muted-foreground uppercase">
                {label}
            </p>
            <ul className="border-l">
                {entries.map((entry) => (
                    <li key={entry.id}>
                        <a
                            href={`#${entry.id}`}
                            className={cn(
                                '-ml-px flex justify-between gap-2 border-l-2 py-[0.3125rem] pl-3 transition-colors hover:text-foreground',
                                entry.id === activeId
                                    ? 'border-(--app-current-color) font-medium text-foreground'
                                    : 'border-transparent text-muted-foreground',
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
