// The 2d context a test measures vector text on. The measurer keeps the first context it is given, so a later stub of
// getContext would never reach it. Every test file hands it this one context and sets only the width a line measures
// in it, which holds whichever file ran first in a shared process. Call it after installHappyDom, which gives the
// test its canvas.

let measure = (_line: string, _font: string) => 0;
const context = {
    font: '',
    measureText: (line: string) => ({ width: measure(line, context.font) }),
};

export function stubCanvasMeasure(width: (line: string, font: string) => number): void {
    measure = width;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value: () => context,
    });
}
