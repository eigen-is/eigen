import { stripTagsServer } from '@workspace/lib/html';
import type { DocSearchMatch } from '@workspace/lib/types/doc-search';
import type { DeckData } from './types';

// Pure deck text scan: one match per text object, in slide reading order. stripTagsServer keeps
// block/<br> boundaries as newlines (div.textContent glues "launch<br>plan" into "launchplan").
export function searchDeck(deck: DeckData, regex: RegExp): DocSearchMatch[] {
    const matches: DocSearchMatch[] = [];
    for (const [index, slideId] of deck.slideOrder.entries()) {
        const slide = deck.slides[slideId];
        if (!slide) continue;
        for (const objId of slide.objectIds) {
            const obj = deck.objects[objId];
            if (obj?.type !== 'text') continue;
            const text = stripTagsServer(obj.text);
            if ((text.match(regex) ?? []).length === 0) continue;
            matches.push({
                id: obj.id,
                label: text.replace(/\s+/g, ' ').slice(0, 80) || 'Text',
                context: `Slide ${index + 1}`,
            });
        }
    }
    return matches;
}
