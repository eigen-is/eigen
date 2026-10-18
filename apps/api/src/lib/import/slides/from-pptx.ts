import type { BackgroundFill } from '@workspace/lib/types/background';
import { type NewVectorElement, nearestSlideSize, SLIDE_SIZES, type SlideSize } from '@workspace/lib/vector';
import { ApiError } from '../../core/errors';
import { P_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr } from '../../core/xml';
import type { CountedWarningCode, TransformWarning } from '../../document/transform/protocol';
import { IMPORT_MESSAGES, importError } from '../messages';
import { backgroundOf, createInheritance } from './inherit';
import { childOf, withWorkBudget } from './lookup';
import { type DeckWalk, type Frame, readPackage } from './package';
import { readSlideShapes } from './shapes';

// pptx bytes → the slides of a deck: frames, the elements on them and the pictures they show. Runs in the transform
// process; transform.ts writes the result as a Yjs update.

export type PptxSlide = { name: string; background: BackgroundFill | null; elements: NewVectorElement[] };
export type PptxMedia = { name: string; contentType: string; data: Buffer };

export type PptxDeck = {
    slides: PptxSlide[];
    media: PptxMedia[];
    warnings: TransformWarning[];
    // The deck size nearest the file's p:sldSz, which a Convert's new deck takes.
    slideSize: SlideSize;
};

// The frame is the deck's on an Import slides…, and none on a Convert, whose deck takes the file's nearest size.
export type PptxOptions = { frame?: Frame; maxMediaBytes: number };

export const MAX_MEDIA_PARTS = 1000;

// The read's work, charged through lookup.ts: children scanned where a lookup or a colour isn't known yet, colour
// transforms applied, paragraph and run nodes and characters read, shapes walked, a chart part's elements and points
// for each colour map it is painted with. Whatever a file repeats, or makes each cache key anew, the read does no more than
// this. Over ten times the corpus's most, 260,005 in a 369-slide deck.
export const MAX_PPTX_WORK = 3_000_000;

// ST_SlideSizeCoordinate's range, 1 to 56 inches; PowerPoint's 4:3 where the file states none.
const MIN_SLIDE_EMU = 914_400;
const MAX_SLIDE_EMU = 51_206_400;
const DEFAULT_SLIDE_SIZE = { cx: 9_144_000, cy: 6_858_000 };

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
    const cx = side('cx', DEFAULT_SLIDE_SIZE.cx);
    const cy = side('cy', DEFAULT_SLIDE_SIZE.cy);
    const slideSize = nearestSlideSize(cx, cy);
    const frame = options.frame ?? SLIDE_SIZES[slideSize];
    // Letterboxed: the whole slide fits the frame, centred.
    const scale = Math.min(frame.width / cx, frame.height / cy);

    // A random prefix per import, so an Import into a deck that holds an earlier one's pictures overwrites none.
    const prefix = `pptx-${crypto.randomUUID()}`;
    const media: PptxMedia[] = [];
    const names = new Map<string, string | undefined>();
    let mediaBytes = 0;
    const losses = new Map<CountedWarningCode, Set<XmlElement>>();
    const deck: DeckWalk = {
        pkg,
        scale,
        offset: { x: (frame.width - cx * scale) / 2, y: (frame.height - cy * scale) / 2 },
        slide: { width: cx * scale, height: cy * scale },
        shapes: 0,
        elements: 0,
        weight: 0,
        decorations: new Map(),
        lost: (code, source) => losses.set(code, (losses.get(code) ?? new Set()).add(source)),
        mediaName: (part) => {
            if (names.has(part.path)) return names.get(part.path);
            mediaBytes += part.size;
            if (names.size >= MAX_MEDIA_PARTS || mediaBytes > options.maxMediaBytes)
                throw new ApiError(413, IMPORT_MESSAGES.pptx.tooLarge);
            // Read as it is named, so a picture whose bytes don't read is dropped where it is shown.
            const data = pkg.readMedia(part.path);
            const name = data && `${prefix}-image-${media.length + 1}.${part.extension}`;
            // A view of the bytes read, not a copy of them.
            if (data && name)
                media.push({
                    name,
                    contentType: part.contentType,
                    data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
                });
            names.set(part.path, name);
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
    return { slides, media, warnings, slideSize };
}
