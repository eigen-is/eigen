import type { HelpSearchDoc } from '@workspace/lib/types/search';

type PagefindSearchResult = { data: () => Promise<HelpSearchDoc> };
type PagefindApi = {
    search: (query: string) => Promise<{ results: PagefindSearchResult[] }>;
};

// Loaded once, lazily, from the statically-served bundle the index app's build writes
// to dist/index/pagefind. Vite must not resolve it at build time (@vite-ignore); it is
// absent in dev (each app on its own port) and on any non-index origin, where a failed
// load simply degrades to no results. In production every app is same-origin behind
// Caddy, so /pagefind is reachable from the command palette in any app.
let pagefindPromise: Promise<PagefindApi | null> | null = null;

export function loadPagefind(): Promise<PagefindApi | null> {
    if (!pagefindPromise) {
        const path = '/pagefind/pagefind.js';
        pagefindPromise = import(/* @vite-ignore */ path).then((m) => m as unknown as PagefindApi).catch(() => null);
    }
    return pagefindPromise;
}
