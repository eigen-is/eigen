// A deck always has at least one slide. Nothing server-side writes a new container's Yjs content
// (Drive.create provisions data.db, comments.db, media/ and chat/ and nothing else), so the first
// writer to open an empty deck seeds it. One transact, so a fresh deck arrives as one atom; under a
// non-null origin, so ⌘Z cannot empty it (docs/CANVAS.md § Sealing discipline). Ids and the frame
// record go through the editor's own writers, so a seeded deck cannot drift from an authored one.

import { DEFAULT_FILL_COLOR } from '@workspace/lib/background';
import {
    baseDefaultsFor,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    generateKeyBetween,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
} from '@workspace/lib/vector';
import { newElementId, newFrameId, writeFrameInDoc } from '@workspace/ui/components/vector';
import * as Y from 'yjs';

const SEED_ORIGIN = Symbol('deck-seed');

// The centred title band a deck has always opened with, in frame coordinates (0,0 → 1920,1080).
const WELCOME = {
    x: 192,
    y: 378,
    width: 1536,
    height: 324,
    html: '<p>Welcome to Slides</p>',
    fontSize: 64,
    color: '#ffffff',
    textAlign: 'center',
    verticalAlign: 'center',
};

export function seedDeck(doc: Y.Doc): void {
    const framesMap = doc.getMap('frames');
    // The live doc, not React state: state is a render behind a sync, so a second effect pass would
    // seed a deck that already has a slide.
    if (framesMap.size > 0) return;
    doc.transact(() => {
        // Re-check inside the transaction: a peer's seed may have landed between the test and here.
        if (framesMap.size > 0) return;
        const index = generateKeyBetween(null, null);
        const frameId = newFrameId();
        writeFrameInDoc(doc, {
            id: frameId,
            index,
            background: serializeBackgroundFill({ type: 'solid', color: DEFAULT_FILL_COLOR }),
        });

        const elementId = newElementId();
        const record: Record<string, unknown> = {
            ...baseDefaultsFor('richtext'),
            ...ELEMENT_KINDS.richtext.defaults(SLIDES_STYLE_DEFAULTS),
            id: elementId,
            type: 'richtext',
            index,
            frameId,
            angle: 0,
            ...WELCOME,
        };
        const element = new Y.Map<unknown>();
        for (const field of ELEMENT_FIELDS) {
            const value = record[field];
            if (value !== undefined) element.set(field, value);
        }
        doc.getMap('elements').set(elementId, element);
    }, SEED_ORIGIN);
}
