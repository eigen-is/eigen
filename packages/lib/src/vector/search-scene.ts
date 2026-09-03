// The canvas' searchable text: every kind's own searchText, in reading order — frame by frame, then
// z-order inside a frame. One collector, so ⌘F and the server-side search index agree about what a
// drawing "says".

import type { DocSearchMatch } from '../types/doc-search';
import { orderByFractionalIndex } from './fractional-index';
import { ELEMENT_KINDS } from './kinds';
import type { VectorElement, VectorScene } from './types';

// The bar lists one row per match: a single line, short enough not to push the count off the row.
const LABEL_MAX = 80;

export type SearchSceneOptions = {
    // Where the match is, in the host's vocabulary ("Slide 3"). Omitted on the infinite canvas.
    contextOf?: (el: VectorElement) => string | undefined;
};

export function searchScene(scene: VectorScene, regex: RegExp, opts: SearchSceneOptions = {}): DocSearchMatch[] {
    // Both orders come from the fractional indices, not from array position, so a caller holding a
    // scene it assembled itself gets the same reading order the reader would have produced.
    const framePosition = new Map(orderByFractionalIndex(scene.frames).map((frame, i) => [frame.id, i]));
    // sort is stable, so ordering by frame keeps the z-order within each frame. An unframed element
    // sorts first (-1) — the infinite canvas's only case.
    const ordered = orderByFractionalIndex(scene.elements).sort(
        (a, b) => (framePosition.get(a.frameId) ?? -1) - (framePosition.get(b.frameId) ?? -1),
    );

    const matches: DocSearchMatch[] = [];
    for (const el of ordered) {
        const text = ELEMENT_KINDS[el.type].searchText(el).trim();
        if (text === '') continue;
        // A /g regex remembers lastIndex between calls; reset it or every second element is skipped.
        regex.lastIndex = 0;
        if (!regex.test(text)) continue;
        matches.push({
            id: el.id,
            label: text.replace(/\s+/g, ' ').slice(0, LABEL_MAX),
            context: opts.contextOf?.(el),
        });
    }
    return matches;
}
