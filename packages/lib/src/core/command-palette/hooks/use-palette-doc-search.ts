import type { DocSearchController } from '@workspace/lib/types/doc-search';
import { useEffect, useMemo, useRef } from 'react';
import { useOptionalCommandPalette } from './use-command-palette';

// DocSearchProvider publishes its per-app controller so the palette `doc:` scope can list
// in-document matches and reveal one in place on Enter. Mirrors usePaletteSelectionActions:
// the controller's identity churns per render (apps rebuild it from live editor state), and
// publishing into context re-renders the publisher — so without stabilisation the publication
// effect would refire every render and trip React's max-update guard. We stabilise: every
// method routes through a ref to the latest controller, and the published identity only flips
// when a controller appears/disappears. Optional palette (a surface may mount the bar without
// the full EigenApp stack — index/support have no palette), so no-op when there's no provider.
export function usePaletteDocSearch(controller: DocSearchController | null): void {
    const setDocSearch = useOptionalCommandPalette()?.setDocSearch;

    const controllerRef = useRef<DocSearchController | null>(controller);
    controllerRef.current = controller;

    const present = controller != null;

    const stable = useMemo<DocSearchController | null>(() => {
        if (!present) return null;
        return {
            search: (query, opts) => controllerRef.current?.search(query, opts) ?? [],
            highlightAll: (matches) => controllerRef.current?.highlightAll(matches),
            reveal: (matchId) => controllerRef.current?.reveal(matchId),
        };
        // `present` is the only meaningful trigger; the live controller routes through the ref.
    }, [present]);

    useEffect(() => {
        if (!setDocSearch) return;
        setDocSearch(stable);
        return () => setDocSearch(null);
    }, [stable, setDocSearch]);
}
