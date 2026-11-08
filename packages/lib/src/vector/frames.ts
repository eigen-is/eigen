// Frames: the bounded pages a canvas can hold. A deck is a canvas whose elements all carry a frameId;
// a drawing is the same canvas with no frames at all. Every frame of a deck has the deck's slide size —
// elements may overhang and the frame clips them.

import { MAX_FONT_SIZE, MIN_FONT_SIZE, snapFontSize } from '../constants/fonts';
import { ptToPx, pxToPt } from '../docs/eigendoc/page';
import { serializeBackgroundFill } from './fill';
import type { Point } from './geometry';
import type { Extent } from './viewport';

// Every slide size shares this width, as Google's 10 in does, so a size change moves nothing sideways
// and the export and preview scales, which divide by it, hold for every deck.
export const FRAME_WIDTH = 1920;

// A deck's slide size, stored once in `meta.slideSize` (DEFAULT_SCENE_META holds the default); the
// reader stamps it on every frame.
export const SLIDE_SIZE_KEYS = ['16:9', '4:3'] as const;
export type SlideSize = (typeof SLIDE_SIZE_KEYS)[number];
export const SLIDE_SIZES: Readonly<Record<SlideSize, Readonly<Extent>>> = {
    '16:9': { width: FRAME_WIDTH, height: 1080 },
    '4:3': { width: FRAME_WIDTH, height: 1440 },
};

// The frame stays 1920 px wide whatever the width, so this sets the deck's pt per px, and every px↔pt a deck converts
// goes through the two helpers below. Bounded by PowerPoint's 1 to 56 in.
export const MIN_SLIDE_WIDTH = (72 * FRAME_WIDTH) / SLIDE_SIZES['16:9'].height;
export const MAX_SLIDE_WIDTH = 4032;

// 10 in, the deck whose font sizes reach the highest px.
export const TEN_INCH_SLIDE_WIDTH = 720;

export function slidePxToPt(px: number, slideWidth: number): number {
    return (px * slideWidth) / FRAME_WIDTH;
}

export function slidePtToPx(pt: number, slideWidth: number): number {
    return (pt * FRAME_WIDTH) / slideWidth;
}

// A canvas font size as the pt the shared clipboard's text carries (EigenClipboardTypography), and back: a deck's at
// its own width, a drawing's, which has none, at CSS's 96 dpi, the scale its PDF and SVG print at.
export function canvasPxToPt(px: number, slideWidth: number | undefined): number {
    return slideWidth === undefined ? pxToPt(px) : slidePxToPt(px, slideWidth);
}

export function canvasPtToPx(pt: number, slideWidth: number | undefined): number {
    return slideWidth === undefined ? ptToPx(pt) : slidePtToPx(pt, slideWidth);
}

// A stored px size as a deck shows it: pt on fonts.ts' half-point grid. Showing it writes nothing: the stored px
// changes only when the user sets a size, so a box pasted between a deck and a drawing keeps its size to the bit.
export function slideFontSize(px: number, slideWidth: number): number {
    return snapFontSize(slidePxToPt(px, slideWidth));
}

// A size an importer writes, on the half-point grid at the deck's scale, so a 44 pt title shows 44.
export function snapSlideFontSize(px: number, slideWidth: number): number {
    return slidePtToPx(slideFontSize(px, slideWidth), slideWidth);
}

// The px range a stored size may hold, for a deck and a drawing alike, so a paste between them keeps its px: fonts.ts'
// pt range on the widest deck and on a 10 in one.
export const MIN_FONT_SIZE_PX = slidePtToPx(MIN_FONT_SIZE, MAX_SLIDE_WIDTH);
export const MAX_FONT_SIZE_PX = slidePtToPx(MAX_FONT_SIZE, TEN_INCH_SLIDE_WIDTH);

// The slide size closest in shape to a page of any size, for an importer: widescreen and 16:10 read as
// 16:9, 4:3 and A4 as 4:3.
export function nearestSlideSize(width: number, height: number): SlideSize {
    const off = (key: SlideSize) => Math.abs(width / height - SLIDE_SIZES[key].width / SLIDE_SIZES[key].height);
    return SLIDE_SIZE_KEYS.reduce((best, key) => (off(key) < off(best) ? key : best));
}

// `background` is a serialized BackgroundFill ('' = none), the same codec element fills use, so the
// reader has one validator and the panel one writer. `index` is a fractional index like an element's.
export type VectorFrame = {
    id: string;
    index: string;
    name: string;
    width: number;
    height: number;
    background: string;
};

// The stored keys a frame writer may set. `width`/`height` come from the deck's slide size, never a
// frame's own keys, so a writer that tried to persist them would be inventing a second source for it.
export const FRAME_FIELDS: readonly string[] = ['id', 'index', 'name', 'background'];

// White, not '': a background-less frame is invisible against the present-mode backdrop and exports as a hole.
export const DEFAULT_FRAME_BACKGROUND: string = serializeBackgroundFill({ type: 'solid', color: '#ffffff' });

// Whether a scene point is ON the page. A frame clips its overhang, so a creation gesture that starts
// off the page would write an element (and mount an in-place editor) nobody can see.
export function pointInFrame(p: Point, frame: VectorFrame): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= frame.width && p.y <= frame.height;
}

// The elements homed to one frame. '' selects the infinite canvas's own elements.
export function elementsInFrame<T extends { frameId: string }>(elements: readonly T[], frameId: string): T[] {
    return elements.filter((el) => el.frameId === frameId);
}

// When the active frame is gone (a peer's delete, an undo of the add), the frame now at its position takes over,
// clamped to the ends, so deleting the last slide steps back. '' means the deck has no frames at all.
export function nearestFrameId(frames: VectorFrame[], activeId: string, lastIndex: number): string {
    if (frames.length === 0) return '';
    if (frames.some((frame) => frame.id === activeId)) return activeId;
    const at = Math.min(Math.max(lastIndex, 0), frames.length - 1);
    return frames[at].id;
}

// The frame and every frame after it, in stored order — the "this and following" scope. An unknown
// id selects nothing rather than the whole deck, so a stale id can't apply a change everywhere.
export function framesFrom(frames: VectorFrame[], frameId: string): VectorFrame[] {
    const at = frames.findIndex((frame) => frame.id === frameId);
    return at === -1 ? [] : frames.slice(at);
}
