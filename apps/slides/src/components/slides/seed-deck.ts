// A deck always has at least one slide. Nothing server-side writes a new container's Yjs content
// (Drive.create provisions data.db, comments.db, media/ and chat/ and nothing else), so the first
// writer to open an empty deck seeds it. One transact, so a fresh deck arrives as one atom; under a
// non-null origin, so ⌘Z cannot empty it (docs/CANVAS.md § Sealing discipline). Ids and the frame
// record go through the editor's own writers, so a seeded deck cannot drift from an authored one.

import { generateKeyBetween, SLIDES_STYLE_DEFAULTS, serializeBackgroundFill } from '@workspace/lib/vector';
import {
    newFrameId,
    type VectorElementPatch,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/ui/components/vector';
import type * as Y from 'yjs';

const SEED_ORIGIN = Symbol('deck-seed');

// The colour a brand-new deck opens on — the title slide only. Every later page, including one added
// with +, is painted with the shared DEFAULT_FRAME_BACKGROUND by writeFrame.
const SEED_BACKGROUND_COLOR = '#f6339a';

// The centred title band a deck has always opened with, in frame coordinates (0,0 → 1920,1080).
const WELCOME: VectorElementPatch = {
    x: 192,
    y: 378,
    width: 1536,
    height: 324,
    html: '<p>Welcome to Slides</p>',
    fontSize: 64,
    textAlign: 'center',
    verticalAlign: 'center',
    // White reads on SEED_BACKGROUND_COLOR; the kind's default (near-black) would not.
    color: '#ffffff',
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
        const background = serializeBackgroundFill({ type: 'solid', color: SEED_BACKGROUND_COLOR });
        writeFrameInDoc(doc, { id: frameId, index, background });
        writeElementInDoc(doc, { type: 'richtext', frameId, ...WELCOME }, index, SLIDES_STYLE_DEFAULTS);
    }, SEED_ORIGIN);
}
