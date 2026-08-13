import { useQuery } from '@tanstack/react-query';
import { getIndexAppUrl } from '@workspace/lib/api';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type { PaletteResult, PaletteScope } from '@workspace/lib/types/command-palette';
import { CircleHelp } from 'lucide-react';
import { useMemo } from 'react';
import { helpSearchKeys, loadPagefind } from '../../search';
import { useDebouncedValue } from '../../use-debounced-value';
import { parseQuery } from '../parse-query';

// Same debounce as the other async sources — short enough to feel live, long enough to
// coalesce a typing burst before the lazy, WASM-backed Pagefind index does its work.
const HELP_SEARCH_DEBOUNCE_MS = 150;
const HELP_RESULT_LIMIT = 6;

// Help is a client-side source: it queries the index app's static Pagefind index
// (core/search/pagefind.ts), not the /search route. The content is public — no ownerId,
// no backend. Returns the same { results, isPending } shape as mail/file so the merge
// holds it stable while in flight. Unlike mail/file it only fires under the help scope
// or no scope, so the WASM index isn't loaded while the user is narrowed to another kind.
export function useHelpSearchResults(
    input: string,
    scope: PaletteScope | undefined,
): {
    results: PaletteResult[];
    isPending: boolean;
} {
    const debouncedInput = useDebouncedValue(input, HELP_SEARCH_DEBOUNCE_MS);
    const parsed = parseQuery(debouncedInput);

    const scopeBlocks = !!scope && scope !== 'help';
    const enabled = !scopeBlocks && parsed.q.length > 0;

    const { data, isFetching } = useQuery({
        queryKey: helpSearchKeys.query(parsed.q),
        queryFn: async () => {
            const pf = await loadPagefind();
            if (!pf) return [];
            const search = await pf.search(parsed.q);
            return Promise.all(search.results.slice(0, HELP_RESULT_LIMIT).map((r) => r.data()));
        },
        enabled,
        // The Pagefind index is immutable for a given deployment — cache generously.
        staleTime: STALE_TIME.FIVE_MINUTES,
    });

    const results = useMemo<PaletteResult[]>(() => {
        if (!data) return [];
        return data.map((doc, i) => ({
            kind: 'help' as const,
            id: `help.${doc.url}`,
            title: doc.meta.title ?? doc.url,
            icon: CircleHelp,
            group: 'help',
            rank: -i,
            payload: doc,
            // Support pages live on the index app — a same-origin /support path in prod
            // (getIndexAppUrl's relative fallback), the index dev URL otherwise. navigate
            // is a hard window.location assignment, so the cross-app jump just works.
            run: (rctx) => rctx.navigate(getIndexAppUrl(doc.url)),
        }));
    }, [data]);

    const willSearch = enabled;
    const isDebouncing = !scopeBlocks && input.trim().length > 0 && input !== debouncedInput;
    return { results, isPending: (willSearch && isFetching) || isDebouncing };
}
