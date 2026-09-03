import { buildSearchRegex } from '@workspace/lib/doc-search';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import {
    searchScene,
    type VectorElement,
    type VectorFrame,
    type VectorMeta,
    type VectorScene,
} from '@workspace/lib/vector';
import { useMemo, useState } from 'react';

type CanvasDocSearchArgs = {
    elements: VectorElement[];
    frames: VectorFrame[];
    meta: VectorMeta;
    // What "reveal" means is the host's: the vector app selects the element, a paged host would activate
    // its frame first. Keep it stable (useCallback) or the controller identity churns on every render.
    onReveal: (el: VectorElement) => void;
    // Where a match is, in the host's vocabulary ("Slide 3"); omitted on the infinite canvas.
    contextOf?: (el: VectorElement) => string | undefined;
};

// The canvas' DocSearchController: ⌘F over every kind's own text. Search-only — replace stays unset,
// so the bar hides its replace row (the slides/stickies shape).
export function useCanvasDocSearch({ elements, frames, meta, onReveal, contextOf }: CanvasDocSearchArgs): {
    controller: DocSearchController;
    matchedIds: ReadonlySet<string>;
    activeId: string | null;
} {
    const [matchedIds, setMatchedIds] = useState<ReadonlySet<string>>(new Set());
    const [activeId, setActiveId] = useState<string | null>(null);

    // The scene is assembled HERE from its three stable pieces: a `scene` prop would be a fresh object
    // literal every render, so the controller identity would churn and the open session would re-run
    // its search on every keystroke anywhere in the app (slides memoises on its stable `deck` likewise).
    const scene = useMemo<VectorScene>(() => ({ elements, frames, meta }), [elements, frames, meta]);

    const controller = useMemo<DocSearchController>(
        () => ({
            search: (query, opts) => {
                const regex = buildSearchRegex(query, opts);
                return regex ? searchScene(scene, regex, { contextOf }) : [];
            },
            highlightAll: (matches) => {
                const ids = new Set(matches.map((m) => m.id));
                setMatchedIds(ids);
                // Drop the active ring when its element stops matching (incl. the [] clear on close).
                setActiveId((prev) => (prev && ids.has(prev) ? prev : null));
            },
            reveal: (matchId) => {
                // The collector searches the WHOLE scene, other frames included — a ⌘F that can't find
                // text on slide 7 is not a find bar. So reveal hands the host the element and the host
                // decides what revealing it means. A stale id no-ops, per the controller contract.
                const el = scene.elements.find((e) => e.id === matchId);
                if (!el) return;
                setActiveId(matchId);
                onReveal(el);
            },
        }),
        [scene, onReveal, contextOf],
    );

    return { controller, matchedIds, activeId };
}
