import type { HelpSearchDoc } from '@workspace/lib/types/search';

type PagefindSearchResult = { data: () => Promise<HelpSearchDoc> };
type PagefindApi = {
    search: (query: string) => Promise<{ results: PagefindSearchResult[] }>;
};

// Loaded once, lazily, from the statically-served bundle the index app's build writes
// to dist/index/pagefind. Vite must not resolve it at build time (@vite-ignore). A failed
// load degrades to no results. In production every app is same-origin behind Caddy, so
// /pagefind is reachable from the command palette in any app. Dev is skipped outright:
// only the build writes the bundle and each app sits on its own origin, so the import can
// only 404 — and a dynamic import's 404 reaches the console whatever the catch does.
let pagefindPromise: Promise<PagefindApi | null> | null = null;

export function loadPagefind(): Promise<PagefindApi | null> {
    if (!pagefindPromise) {
        const path = '/pagefind/pagefind.js';
        pagefindPromise = import.meta.env.DEV
            ? Promise.resolve(null)
            : import(/* @vite-ignore */ path).then((m) => m as unknown as PagefindApi).catch(() => null);
    }
    return pagefindPromise;
}
