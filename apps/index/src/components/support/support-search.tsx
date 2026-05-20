import { Dialog, DialogContent, DialogTitle } from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import { Search } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

type PagefindHit = { url: string; meta: { title?: string }; excerpt: string };

const SearchContext = createContext<{ open: () => void }>({ open: () => {} });
export function useSupportSearch() {
    return useContext(SearchContext);
}

// Lazily load the Pagefind runtime. It only exists in a production build; in dev
// this import 404s and search reports itself unavailable.
let pagefindPromise: Promise<{
    search: (q: string) => Promise<{ results: { data: () => Promise<PagefindHit> }[] }>;
}> | null = null;
async function getPagefind() {
    if (!pagefindPromise) {
        pagefindPromise = import(/* @vite-ignore */ `${import.meta.env.BASE_URL}pagefind/pagefind.js`);
    }
    return pagefindPromise;
}

export function SupportSearchProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [hits, setHits] = useState<PagefindHit[]>([]);
    const [unavailable, setUnavailable] = useState(false);
    const [pending, setPending] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setIsOpen(true);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => {
        if (!query.trim()) {
            setHits([]);
            setUnavailable(false);
            setPending(false);
            return;
        }
        setPending(true);
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const pagefind = await getPagefind();
                const result = await pagefind.search(query);
                const data = await Promise.all(result.results.slice(0, 8).map((r) => r.data()));
                if (!cancelled) setHits(data);
            } catch {
                if (!cancelled) setUnavailable(true);
            } finally {
                if (!cancelled) setPending(false);
            }
        }, 150);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query]);

    return (
        <SearchContext.Provider value={{ open: () => setIsOpen(true) }}>
            {children}
            <Dialog open={isOpen} onOpenChange={setIsOpen}>
                <DialogContent showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-xl">
                    <DialogTitle className="sr-only">Search help articles</DialogTitle>
                    <div className="flex items-center gap-2 border-b px-3">
                        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search help articles…"
                            className="h-12 flex-1 bg-transparent outline-none"
                        />
                    </div>
                    <div className="max-h-[50vh] overflow-y-auto p-2">
                        {unavailable && (
                            <p className="p-3 text-sm text-muted-foreground">Search is available in the built site.</p>
                        )}
                        {!unavailable && !pending && query.trim() && hits.length === 0 && (
                            <p className="p-3 text-sm text-muted-foreground">No results.</p>
                        )}
                        {hits.map((hit) => (
                            <a key={hit.url} href={hit.url} className="block rounded px-3 py-2 hover:bg-muted">
                                <div className="font-medium">{hit.meta.title ?? hit.url}</div>
                                {/* Pagefind builds the excerpt from our own indexed content — safe to render as HTML */}
                                <div
                                    className="text-sm text-muted-foreground line-clamp-2"
                                    dangerouslySetInnerHTML={{ __html: hit.excerpt }}
                                />
                            </a>
                        ))}
                    </div>
                </DialogContent>
            </Dialog>
        </SearchContext.Provider>
    );
}

// A search-box-styled button that opens the dialog.
export function SearchTrigger({ className }: { className?: string }) {
    const { open } = useSupportSearch();
    return (
        <button
            type="button"
            onClick={open}
            className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}
        >
            <Search className="h-4 w-4" />
            Search help articles…
        </button>
    );
}
