// happy-dom's canvas has no 2D context, so a commit in a test measures nothing. This gives every canvas of a window a
// context with fixed glyph boxes, so the row height a test reads comes out of the real layout. The context must return
// real bounding boxes, because the text measure reads them for a line's height.

import type { Window } from 'happy-dom';

export function stubMeasuringCanvas(window: Window, ascent = 8, descent = 3) {
    const context = {
        font: '11px Arial',
        textAlign: 'start',
        textBaseline: 'alphabetic',
        measureText: (text: string) => ({
            width: text.length * 7,
            actualBoundingBoxAscent: ascent,
            actualBoundingBoxDescent: descent,
        }),
    };
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', { value: () => context });
}
