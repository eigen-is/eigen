// A deck always has at least one slide. Nothing server-side writes a new container's Yjs content
// (Drive.create provisions data.db, comments.db, media/ and chat/ and nothing else), so the first
// writer to open an empty deck seeds it. One transact, so a fresh deck arrives as one atom; under a
// non-null origin, so ⌘Z cannot empty it (docs/CANVAS.md § Sealing discipline). Field sets come from
// the engine's own whitelists, so this cannot drift from what the editor writes.

import { DEFAULT_FILL_COLOR } from '@workspace/lib/background';
import {
    baseDefaultsFor,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    FRAME_FIELDS,
    generateKeyBetween,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
} from '@workspace/lib/vector';
import { nanoid } from 'nanoid';
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
        const frameId = `fr-${nanoid(10)}`;
        const frame = new Y.Map<unknown>();
        const frameRecord: Record<string, unknown> = {
            id: frameId,
            index,
            name: '',
            background: serializeBackgroundFill({ type: 'solid', color: DEFAULT_FILL_COLOR }),
        };
        for (const field of FRAME_FIELDS) frame.set(field, frameRecord[field]);
        framesMap.set(frameId, frame);

        const elementId = `el-${nanoid(10)}`;
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
