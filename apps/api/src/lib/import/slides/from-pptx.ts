import { randomBytes } from 'node:crypto';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { NewVectorElement } from '@workspace/lib/vector';
import { ApiError, isOutOfMemory } from '../../core/errors';
import { P_NS } from '../../core/ooxml';
import { XmlError, xmlAttr, xmlChild } from '../../core/xml';
import { ZipError } from '../../core/zip';
import type { CountedWarningCode, TransformWarning } from '../../document/transform/protocol';
import { PRESENTATION_TOO_LARGE } from '../messages';
import { backgroundOf, createInheritance } from './inherit';
import { NOT_A_PPTX, readPackage } from './package';
import { type DeckWalk, MAX_MEDIA_PARTS, readSlideShapes } from './shapes';

// pptx bytes → the slides of a deck: frames, the elements on them and the pictures they show. Runs in the transform
// process; transform.ts writes the result as a Yjs update.

export type PptxSlide = { name: string; background: BackgroundFill | null; elements: NewVectorElement[] };
export type PptxMedia = { name: string; contentType: string; data: Buffer };

export type PptxDeck = {
    slides: PptxSlide[];
    media: PptxMedia[];
    warnings: TransformWarning[];
    // The file's p:sldSz in EMU, which Convert picks the deck's size from.
    slideSize: { cx: number; cy: number };
};

export type PptxOptions = { width: number; height: number; maxMediaBytes: number };

// An element is a Y.Map of about twenty fields, and a string costs per character besides: the weight caps both before
// the update is built, and so the update the main thread reads back. The corpus's heaviest weighs 3,307 (a 2.4 MB
// update); at the cap a text-heavy update is about 25 MB and commits in 135 ms.
export const MAX_PPTX_WEIGHT = 50_000;
const CHARS_PER_UNIT = 512;

// ST_SlideSizeCoordinate's range, 1 to 56 inches; PowerPoint's 4:3 where the file states none.
const MIN_SLIDE_EMU = 914_400;
const MAX_SLIDE_EMU = 51_206_400;
const DEFAULT_SLIDE_SIZE = { cx: 9_144_000, cy: 6_858_000 };

export function readPptx(bytes: Uint8Array, options: PptxOptions): PptxDeck {
    try {
        const pkg = readPackage(bytes);
        const sldSz = xmlChild(pkg.presentation.root, P_NS, 'sldSz');
        const side = (name: string, fallback: number) => {
            const value = Number(sldSz && xmlAttr(sldSz, '', name));
            return Number.isFinite(value) && value > 0
                ? Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, value))
                : fallback;
        };
        const slideSize = { cx: side('cx', DEFAULT_SLIDE_SIZE.cx), cy: side('cy', DEFAULT_SLIDE_SIZE.cy) };
        // Letterboxed: the whole slide fits the frame, centred.
        const scale = Math.min(options.width / slideSize.cx, options.height / slideSize.cy);

        // A random prefix per import, so an Import into a deck that holds an earlier one's pictures overwrites none.
        const prefix = `pptx-${randomBytes(4).toString('hex')}`;
        const media: { name: string; path: string; contentType: string }[] = [];
        const names = new Map<string, string>();
        let mediaBytes = 0;
        const dropped = new Map<CountedWarningCode, number>();
        const deck: DeckWalk = {
            pkg,
            scale,
            offset: { x: (options.width - slideSize.cx * scale) / 2, y: (options.height - slideSize.cy * scale) / 2 },
            slide: { width: slideSize.cx * scale, height: slideSize.cy * scale },
            shapes: 0,
            elements: 0,
            lost: (code) => dropped.set(code, (dropped.get(code) ?? 0) + 1),
            mediaName: (part) => {
                const known = names.get(part.path);
                if (known) return known;
                mediaBytes += part.size;
                if (media.length >= MAX_MEDIA_PARTS || mediaBytes > options.maxMediaBytes)
                    throw new ApiError(413, PRESENTATION_TOO_LARGE);
                const name = `${prefix}-image-${media.length + 1}.${part.extension}`;
                media.push({ name, path: part.path, contentType: part.contentType });
                names.set(part.path, name);
                return name;
            },
        };

        const inheritance = createInheritance(pkg);
        const slides = pkg.slides.flatMap((path): PptxSlide[] => {
            const part = pkg.slide(path);
            if (!part) return [];
            const slide = inheritance(part);
            const { elements, title } = readSlideShapes(deck, slide, pkg.presentation);
            return [{ name: title, background: backgroundOf(slide, deck), elements }];
        });
        if (weightOf(slides) > MAX_PPTX_WEIGHT) throw new ApiError(413, PRESENTATION_TOO_LARGE);

        const read = media.flatMap(({ name, path, contentType }): PptxMedia[] => {
            const data = pkg.readMedia(path);
            // A view of the bytes read, not a copy of them.
            return data
                ? [{ name, contentType, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) }]
                : [];
        });
        const warnings: TransformWarning[] = [...dropped].map(([code, count]) => ({ code, count }));
        return { slides, media: read, warnings, slideSize };
    } catch (error) {
        throw importError(error);
    }
}

// Every element and frame, and every string by its length.
function weightOf(slides: PptxSlide[]): number {
    let weight = 0;
    for (const slide of slides) {
        weight += 1 + Math.floor(slide.name.length / CHARS_PER_UNIT);
        for (const element of slide.elements) {
            weight += 1;
            for (const value of Object.values(element))
                if (typeof value === 'string') weight += Math.floor(value.length / CHARS_PER_UNIT);
        }
    }
    return weight;
}

// The zip's and the XML's messages speak of archives and markup; the user uploaded a presentation.
export function importError(error: unknown): Error {
    if (isOutOfMemory(error)) return error;
    if (error instanceof ZipError)
        return new ApiError(error.status, error.status === 413 ? PRESENTATION_TOO_LARGE : NOT_A_PPTX, { cause: error });
    if (error instanceof XmlError) return new ApiError(400, NOT_A_PPTX, { cause: error });
    if (error instanceof ApiError) return error;
    if (error instanceof RangeError && /call stack/i.test(error.message))
        return new ApiError(413, PRESENTATION_TOO_LARGE, { cause: error });
    // A file the reader slips on is refused as one it can't read; the slip is a bug, and its cause stays in the log.
    console.warn('[import] pptx import failed:', error instanceof Error ? (error.stack ?? error.message) : error);
    return new ApiError(400, NOT_A_PPTX, { cause: error });
}
