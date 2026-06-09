import { loadPagefind } from '@workspace/lib/search';
import type { HelpSearchDoc } from '@workspace/lib/types/search';
import { Input } from '@workspace/ui/components/input';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const MAX_RESULTS = 6;

// Experiment: client-side full-text search over the help center, powered by the
// prebuilt Pagefind index (loadPagefind is shared with the command palette's help
// source). Shown on the /support landing under the hero heading.
export function SupportSearch() {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<HelpSearchDoc[]>([]);
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setResults([]);
            setOpen(false);
            return;
        }
        let active = true;
        const timer = setTimeout(async () => {
            const pf = await loadPagefind();
            if (!pf || !active) return;
            const search = await pf.search(q);
            const docs = await Promise.all(search.results.slice(0, MAX_RESULTS).map((r) => r.data()));
            if (active) {
                setResults(docs);
                setOpen(true);
            }
        }, 150);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [query]);

    // Dismiss the results when clicking outside the search box.
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [open]);

    return (
        <div ref={containerRef} className="relative mx-auto max-w-xl">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => results.length > 0 && setOpen(true)}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        setQuery('');
                        setOpen(false);
                    }
                }}
                placeholder="Search help articles…"
                aria-label="Search help articles"
                className="h-12 rounded-lg pl-11 text-base"
            />
            {open && (
                <div className="absolute inset-x-0 top-full z-10 mt-2 overflow-hidden rounded-lg border bg-popover text-left shadow-lg">
                    {results.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-muted-foreground">No matching articles.</p>
                    ) : (
                        <ul className="max-h-96 overflow-y-auto py-1">
                            {results.map((r) => (
                                <li key={r.url}>
                                    <a href={r.url} className="block px-4 py-2.5 hover:bg-muted">
                                        <div className="text-sm font-medium text-foreground">{r.meta.title}</div>
                                        {/* Pagefind's excerpt is trusted build-time HTML with <mark> match
                                            highlights — recoloured from the browser default yellow to the
                                            index theme's soft accent (--app-current-color-soft, as .eigen-callout). */}
                                        <div
                                            className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [&_mark]:bg-[var(--app-current-color-soft)] [&_mark]:text-foreground"
                                            dangerouslySetInnerHTML={{ __html: r.excerpt }}
                                        />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
