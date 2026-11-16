// The search box on the help center's front page. It searches the prebuilt full-text index as you type and lists the
// best matches in a popover under the box. The index is built from the same articles as the pages.

import { loadPagefind } from '@workspace/lib/search';
import type { HelpSearchDoc } from '@workspace/lib/types/search';
import { Popover, PopoverAnchor, PopoverContent } from '@workspace/ui/components/popover';
import { SearchBar } from '@workspace/ui/components/search-bar/search-bar';
import { useEffect, useRef, useState } from 'react';

const MAX_RESULTS = 6;

export function SupportSearch() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<HelpSearchDoc[]>([]);
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setResults([]);
            setOpen(false);
            return;
        }
        let active = true;
        loadPagefind().then(async (pf) => {
            if (!pf || !active) return;
            const search = await pf.search(q);
            const docs = await Promise.all(search.results.slice(0, MAX_RESULTS).map((r) => r.data()));
            if (active) {
                setResults(docs);
                setOpen(true);
            }
        });
        return () => {
            active = false;
        };
    }, [query]);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverAnchor asChild>
                <div ref={anchorRef} onFocus={() => query.trim() && setOpen(true)}>
                    <SearchBar
                        value={query}
                        onChange={setQuery}
                        placeholder="Search help articles…"
                        maxWidth="full"
                        debounceMs={150}
                    />
                </div>
            </PopoverAnchor>
            <PopoverContent
                align="start"
                className="w-(--radix-popover-trigger-width) p-0 text-left"
                // The field keeps the focus, so typing goes on while the results show.
                onOpenAutoFocus={(e) => e.preventDefault()}
                onInteractOutside={(e) => {
                    if (e.target instanceof Node && anchorRef.current?.contains(e.target)) e.preventDefault();
                }}
            >
                {results.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-muted-foreground">No matching articles.</p>
                ) : (
                    <ul className="py-1">
                        {results.map((r) => (
                            <li key={r.url}>
                                <a href={r.url} className="block px-4 py-2.5 hover:bg-muted">
                                    <div className="text-sm font-medium text-foreground">{r.meta.title}</div>
                                    {/* Pagefind's excerpt is trusted build-time HTML; its <mark> highlights take the
                                        section's soft color instead of the browser's yellow. */}
                                    <div
                                        className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [&_mark]:bg-(--app-current-color-soft) [&_mark]:text-foreground"
                                        dangerouslySetInnerHTML={{ __html: r.excerpt }}
                                    />
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    );
}
