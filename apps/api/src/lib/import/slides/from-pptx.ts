// pptx bytes → the slides of a deck: frames, the elements on them and the pictures they show. Runs in the transform
// process; the import's transform step writes the result as a Yjs update.

import type { BackgroundFill } from '@workspace/lib/types/background';
import type { NewVectorElement, SlidePage } from '@workspace/lib/vector';
import { MAX_SLIDE_WIDTH, MIN_SLIDE_WIDTH, nearestSlideSize, SLIDE_SIZES } from '@workspace/lib/vector';
import { xmlAttr } from '../../core/xml';
import type { TransformWarning } from '../../document/transform/protocol';
import { lossCounter } from '../../document/transform/protocol';
import { budget } from '../../ooxml/budget';
import { EMU_PER_POINT, P_NS } from '../../ooxml/ooxml';
import { MAX_SLIDE_EMU, MIN_SLIDE_EMU } from '../../ooxml/presentationml';
import type { ImportedMedia } from '../image-types';
import { importMedia } from '../image-types';
import { IMPORT_MESSAGES, importError } from '../messages';
import { backgroundOf, createInheritance } from './inherit';
import { childOf, withWorkBudget } from './lookup';
import type { DeckWalk } from './package';
import { readPackage } from './package';
import { MAX_ELEMENTS, MAX_PPTX_WEIGHT, readSlideShapes } from './shapes';

export type PptxSlide = { name: string; background: BackgroundFill | null; elements: NewVectorElement[] };

export type PptxDeck = {
    slides: PptxSlide[];
    media: ImportedMedia[];
    warnings: TransformWarning[];
    // The page a Convert's new deck takes: the slide size nearest the file's p:sldSz, and the width that keeps the
    // file's pt per px, its own width where the shapes match and PowerPoint's range allows. An Import's is the open
    // deck's.
    page: SlidePage;
};

// The page is the open deck's on an inserting Import…, which the file is fitted into, and none on a Convert or a
// replace, whose deck takes the file's own.
export type PptxOptions = { deck?: SlidePage; maxMediaBytes: number };

// The read's work, charged through lookup.ts: children scanned where a lookup or a colour isn't known yet, colour
// transforms applied, paragraph and run nodes and characters read, shapes walked, a chart part's elements and points
// for each colour map it is painted with. Whatever a file repeats, or makes each cache key anew, the read does no more than
// this. Over ten times the corpus's most, 260,005 in a 369-slide deck.
export const MAX_PPTX_WORK = 3_000_000;

// PowerPoint's 4:3, 10 by 7.5 in, where the file states none.
const DEFAULT_SLIDE_EMU = { cx: 9_144_000, cy: 6_858_000 };

export function readPptx(bytes: Uint8Array, options: PptxOptions): PptxDeck {
    try {
        return withWorkBudget(MAX_PPTX_WORK, () => readDeck(bytes, options));
    } catch (error) {
        throw importError(error, 'pptx');
    }
}

function readDeck(bytes: Uint8Array, options: PptxOptions): PptxDeck {
    const pkg = readPackage(bytes);
    const sldSz = childOf(pkg.presentation.root, P_NS, 'sldSz');
    const side = (name: string, fallback: number) => {
        const value = Number(sldSz && xmlAttr(sldSz, '', name));
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, value)) : fallback;
    };
    const cx = side('cx', DEFAULT_SLIDE_EMU.cx);
    const cy = side('cy', DEFAULT_SLIDE_EMU.cy);
    const slideSize = options.deck?.slideSize ?? nearestSlideSize(cx, cy);
    const frame = SLIDE_SIZES[slideSize];
    // A Convert's frame is as wide as the file's slide, or wider where the file's is taller than the frame's shape,
    // held to PowerPoint's range.
    const fitted = Math.max(cx, (cy * frame.width) / frame.height) / EMU_PER_POINT;
    const page = options.deck ?? {
        slideSize,
        slideWidth: Math.min(MAX_SLIDE_WIDTH, Math.max(MIN_SLIDE_WIDTH, fitted)),
    };
    // Centred. An Import letterboxes the whole slide into the open deck's frame; a Convert's shapes take its deck's pt
    // per px, so a pt stays a pt, and a slide the range held overhangs its frame or sits inside it.
    const scale = options.deck
        ? Math.min(frame.width / cx, frame.height / cy)
        : frame.width / (page.slideWidth * EMU_PER_POINT);

    // Named per import, so an Import into a deck that holds an earlier one's pictures overwrites none. The upload cap
    // bounds the pictures' bytes, as an upload of each would be bounded.
    const files = importMedia('pptx', pkg.readMedia, options.maxMediaBytes);
    const losses = lossCounter();
    const deck: DeckWalk = {
        pkg,
        scale,
        slideWidth: page.slideWidth,
        offset: { x: (frame.width - cx * scale) / 2, y: (frame.height - cy * scale) / 2 },
        slide: { width: cx * scale, height: cy * scale },
        shapes: budget(MAX_ELEMENTS, IMPORT_MESSAGES.pptx.tooLarge),
        elements: budget(MAX_ELEMENTS, IMPORT_MESSAGES.pptx.tooLarge),
        weight: budget(MAX_PPTX_WEIGHT, IMPORT_MESSAGES.pptx.tooLarge),
        decorations: new Map(),
        lost: losses.lost,
        // Read as it is named, so a picture past the caps or whose bytes don't read is dropped where it is shown.
        mediaName: files.name,
    };

    const inheritance = createInheritance(pkg);
    const slides = pkg.slides.flatMap((path): PptxSlide[] => {
        const part = pkg.slide(path);
        if (!part) return [];
        const slide = inheritance(part);
        const { elements, title } = readSlideShapes(deck, slide);
        return [{ name: title, background: backgroundOf(slide, deck), elements }];
    });

    return { slides, media: files.media, warnings: losses.warnings(), page };
}
