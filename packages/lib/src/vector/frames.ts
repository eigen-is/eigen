// Frames: the bounded pages a canvas can hold. A deck is a canvas whose elements all carry a frameId;
// a drawing is the same canvas with no frames at all. Every frame in this program is 16:9 at
// 1920x1080 — elements may overhang and the frame clips them.

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

// The elements homed to one frame. '' selects the infinite canvas's own elements.
export function elementsInFrame<T extends { frameId: string }>(elements: T[], frameId: string): T[] {
    return elements.filter((el) => el.frameId === frameId);
}
