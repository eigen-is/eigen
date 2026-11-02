// The 2d context a test measures vector text on. The measurer keeps the first context it is given for the rest of the
// bun process, which runs every test file of the package. So every file hands it this one context, and each file sets
// the width a line measures in it. Call it after installHappyDom, which gives the test its canvas.

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
