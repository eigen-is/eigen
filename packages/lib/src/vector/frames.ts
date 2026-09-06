// Frames: the bounded pages a canvas can hold. A deck is a canvas whose elements all carry a frameId;
// a drawing is the same canvas with no frames at all. Every frame in this program is 16:9 at
// 1920x1080 — elements may overhang and the frame clips them.

import { serializeBackgroundFill } from './fill';
import type { Point } from './geometry';

export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;
export const FRAME_ASPECT_RATIO = FRAME_WIDTH / FRAME_HEIGHT;

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

// The stored keys a frame writer may set. `width`/`height` are constants, never stored, so a writer
// that tried to persist them would be inventing a second source for the frame size.
export const FRAME_FIELDS: readonly string[] = ['id', 'index', 'name', 'background'];

// What a NEW page is painted with, for every writer that makes one (the editor's +, the deck seeder).
// White, not '': a background-less frame is invisible against the present-mode backdrop and exports as
// a hole. '' stays reachable — it is what the panel's None writes — but nothing defaults to it.
export const DEFAULT_FRAME_BACKGROUND: string = serializeBackgroundFill({ type: 'solid', color: '#ffffff' });

// Whether a scene point is ON the page. A frame clips its overhang, so a creation gesture that starts
// off the page would write an element (and mount an in-place editor) nobody can see.
export function pointInFrame(p: Point, frame: VectorFrame): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= frame.width && p.y <= frame.height;
}

// The elements homed to one frame. '' selects the infinite canvas's own elements.
export function elementsInFrame<T extends { frameId: string }>(elements: T[], frameId: string): T[] {
    return elements.filter((el) => el.frameId === frameId);
}

// The frame the shell should activate. `lastIndex` is the position the active frame held; when it is
// gone (a peer's delete, an undo of the add) the frame that now occupies that position takes over,
// clamped to the ends — deleting the last slide steps BACK rather than off the end. '' means the deck
// has no frames at all, which is a state only an empty document is in.
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
