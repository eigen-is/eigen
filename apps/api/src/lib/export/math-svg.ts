// WeasyPrint draws no MathML, so a PDF draws each equation as the SVG MathJax makes of it. Outside export/doc/, as the
// canvas exporters will draw theirs through it too.
let converter: ReturnType<typeof loadConverter> | undefined;

// Loaded on the first equation, once per Worker. Every glyph is a path of its own (fontCache 'none'): a cache would
// repeat each glyph's id in every equation's <defs>, all in one HTML document. One SVG per equation, never MathJax's
// inline line breaks, which split it into several around an element the sanitizer drops.
async function loadConverter() {
    const [{ mathjax }, { MathML }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }] = await Promise.all([
        import('@mathjax/src/js/mathjax.js'),
        import('@mathjax/src/js/input/mathml.js'),
        import('@mathjax/src/js/output/svg.js'),
        import('@mathjax/src/js/adaptors/liteAdaptor.js'),
        import('@mathjax/src/js/handlers/html.js'),
        // MathJax loads a font range the first time a character needs it, through this loader.
        import('@mathjax/src/js/util/asyncLoad/esm.js'),
    ]);
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const document = mathjax.document('', {
        InputJax: new MathML(),
        OutputJax: new SVG({ fontCache: 'none', linebreaks: { inline: false } }),
    });
    return { adaptor, document };
}

// The PDF's SVG costs per element, every copy: the sanitizer's jsdom, in the Worker, which shares the API's address
// space, and WeasyPrint, at 0.2 to 0.4 ms an element. 3 copies of 4,900 empty fences, 44,000 elements in 1.2 MB, take
// the Worker 0.56 GB above the doc and WeasyPrint 9 s and 0.7 GB; under a byte budget alone, 18 copies took 1.9 GB and
// 51 s. The 108 corpus equations draw 21 elements each on average (the largest 195), so a 1,000-equation paper draws
// about 21,700, in 8 s of WeasyPrint.
export const MAX_SVG_ELEMENTS = 50_000;

// Glyph paths run about 390 bytes an element, so there bytes bind first. The corpus equations draw 4.2 KB each on
// average (median 2.1 KB, the largest 42 KB): 4.2 MB for a 1,000-equation paper. One equation at the math bounds
// draws up to 10.24 MB, a row of 4,991 ⨌, past the whole budget, so it prints as text.
export const MAX_SVG_BYTES = 10_000_000;

export const SVG_LIMIT = { elements: MAX_SVG_ELEMENTS, bytes: MAX_SVG_BYTES };

// MathJax takes 1 to 2 ms an equation over the corpus, after 0.4 s loading itself, and up to 0.6 s for a tree at the
// math bounds.
export const MAX_SVG_EQUATIONS = 1000;

// The <math>'s own display="block" makes it a display equation. The promise API waits for the font ranges it loads.
export async function mathmlToSvg(mathml: string): Promise<string> {
    converter ??= loadConverter();
    const { adaptor, document } = await converter;
    return adaptor.innerHTML(await document.convertPromise(mathml));
}
