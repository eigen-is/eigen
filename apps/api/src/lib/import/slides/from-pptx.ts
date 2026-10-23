import type { BackgroundFill } from '@workspace/lib/types/background';
import {
    MAX_SLIDE_WIDTH,
    MIN_SLIDE_WIDTH,
    type NewVectorElement,
    nearestSlideSize,
    SLIDE_SIZES,
    type SlidePage,
} from '@workspace/lib/vector';
import { ApiError } from '../../core/errors';
import { EMU_PER_POINT, P_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr } from '../../core/xml';
import type { CountedWarningCode, TransformWarning } from '../../document/transform/protocol';
import { type ImportedMedia, importMedia } from '../image-types';
import { IMPORT_MESSAGES, importError } from '../messages';
import { backgroundOf, createInheritance } from './inherit';
import { childOf, withWorkBudget } from './lookup';
import { type DeckWalk, readPackage } from './package';
import { readSlideShapes } from './shapes';

// pptx bytes → the slides of a deck: frames, the elements on them and the pictures they show. Runs in the transform
// process; transform.ts writes the result as a Yjs update.

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

// ST_SlideSizeCoordinate's range, 1 to 56 inches; PowerPoint's 4:3, 10 by 7.5 in, where the file states none.
const MIN_SLIDE_EMU = 914_400;
const MAX_SLIDE_EMU = 51_206_400;
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
    const losses = new Map<CountedWarningCode, Set<XmlElement>>();
    const deck: DeckWalk = {
        pkg,
        scale,
        slideWidth: page.slideWidth,
        offset: { x: (frame.width - cx * scale) / 2, y: (frame.height - cy * scale) / 2 },
        slide: { width: cx * scale, height: cy * scale },
        shapes: 0,
        elements: 0,
        weight: 0,
        decorations: new Map(),
        lost: (code, source) => losses.set(code, (losses.get(code) ?? new Set()).add(source)),
        // Read as it is named, so a picture whose bytes don't read is dropped where it is shown.
        mediaName: (part) => {
            const name = files.name(part);
            if (name === null) throw new ApiError(413, IMPORT_MESSAGES.pptx.tooLarge);
            return name;
        },
    };

    const inheritance = createInheritance(pkg);
    const slides = pkg.slides.flatMap((path): PptxSlide[] => {
        const part = pkg.slide(path);
        if (!part) return [];
        const slide = inheritance(part);
        const { elements, title } = readSlideShapes(deck, slide);
        return [{ name: title, background: backgroundOf(slide, deck), elements }];
    });

    const warnings: TransformWarning[] = [...losses].map(([code, sources]) => ({ code, count: sources.size }));
    return { slides, media: files.media, warnings, page };
}
