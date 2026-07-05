import { buildSearchRegex } from '@workspace/lib/doc-search';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import { useCallback, useMemo, useState } from 'react';
import { searchDeck } from '../search-deck';
import type { DeckData } from '../types';

type SlidesDocSearchArgs = {
    deck: DeckData;
    setActiveSlideId: (id: string | null) => void;
};

export function useSlidesDocSearch({ deck, setActiveSlideId }: SlidesDocSearchArgs): {
    controller: DocSearchController;
    highlightedSlideIds: ReadonlySet<string>;
    matchedObjectIds: ReadonlySet<string>;
    searchActiveObjectId: string | null;
    clearHighlights: () => void;
} {
    const [highlightedSlideIds, setHighlightedSlideIds] = useState<ReadonlySet<string>>(new Set());
    const [matchedObjectIds, setMatchedObjectIds] = useState<ReadonlySet<string>>(new Set());
    const [searchActiveObjectId, setSearchActiveObjectId] = useState<string | null>(null);

    // useMemo keys on `deck`, so every local/remote doc change republishes a new controller identity —
    // the provider re-runs the open session's search on that change (contract rule 4), keeping n/m live.
    const controller = useMemo<DocSearchController>(() => {
        return {
            search: (query, opts) => {
                const regex = buildSearchRegex(query, opts);
                return regex ? searchDeck(deck, regex) : [];
            },
            highlightAll: (matches) => {
                const slideIds = new Set<string>();
                const objectIds = new Set<string>();
                for (const m of matches) {
                    const obj = deck.objects[m.id];
                    if (!obj) continue;
                    slideIds.add(obj.slideId);
                    objectIds.add(obj.id);
                }
                setHighlightedSlideIds(slideIds);
                setMatchedObjectIds(objectIds);
                // Drop the active ring when its object stops matching (incl. the [] clear on close).
                setSearchActiveObjectId((prev) => (prev && objectIds.has(prev) ? prev : null));
            },
            reveal: (matchId) => {
                const obj = deck.objects[matchId];
                if (!obj) return; // contract rule 2: stale id → no-op
                setActiveSlideId(obj.slideId);
                setSearchActiveObjectId(obj.id);
            },
        };
    }, [deck, setActiveSlideId]);

    // Present mode unmounts the DocSearchProvider without routing through close(), so the editor calls
    // this to drop stranded rings on enter (the provider only clears them on Esc/✕).
    const clearHighlights = useCallback(() => {
        setHighlightedSlideIds(new Set());
        setMatchedObjectIds(new Set());
        setSearchActiveObjectId(null);
    }, []);

    return { controller, highlightedSlideIds, matchedObjectIds, searchActiveObjectId, clearHighlights };
}
