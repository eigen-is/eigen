// A deck always has at least one slide. Creating a deck writes no Yjs content, so the first writer to open an empty
// deck seeds its title slide, in one transaction under its own origin, so it arrives as one update and ⌘Z cannot
// empty the deck. The records go through the shared writer, so a seeded deck cannot drift from an authored one. Their
// ids are fixed rather than fresh: two peers that open the same empty deck at once both seed it, and the same keys
// make those writes converge on one title slide instead of two.

import { EIGEN_ACCENT_COLORS_SHUFFLED } from '@workspace/lib/constants/colors';
import type { VectorElementPatch } from '@workspace/lib/vector';
import {
    DEFAULT_SCENE_META,
    generateKeyBetween,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import { updateMetaInDoc } from '@workspace/ui/components/vector';
import type * as Y from 'yjs';

const SEED_ORIGIN = Symbol('deck-seed');

const SEED_FRAME_ID = 'fr-deck-seed';
const SEED_ELEMENT_ID = 'el-deck-seed';

// The color a brand-new deck opens on, Eigen's accent — the title slide only. Every later page, including one added
// with +, is painted with the shared DEFAULT_FRAME_BACKGROUND by writeFrame.
const SEED_BACKGROUND_COLOR = EIGEN_ACCENT_COLORS_SHUFFLED[0].value;

// The centered title band a new deck opens with, in 16:9 frame coordinates (0,0 → 1920,1080):
// a new deck is 16:9.
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
        const background = serializeBackgroundFill({ type: 'solid', color: SEED_BACKGROUND_COLOR });
        writeFrameInDoc(doc, { id: SEED_FRAME_ID, index, background });
        // A deck that stores no width reads as UNSTORED_SLIDE_WIDTH, so a new deck states its own; a pptx with no
        // slides imported its width.
        if (!doc.getMap('meta').has('slideWidth')) updateMetaInDoc(doc, { slideWidth: DEFAULT_SCENE_META.slideWidth });
        writeElementInDoc(
            doc,
            { type: 'rectangle', autoFit: true, frameId: SEED_FRAME_ID, ...WELCOME },
            index,
            SLIDES_STYLE_DEFAULTS,
            SEED_ELEMENT_ID,
        );
    }, SEED_ORIGIN);
}
