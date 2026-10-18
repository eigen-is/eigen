// WeasyPrint draws no MathML, so a PDF draws each equation as the SVG MathJax makes of it.
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

// The sanitizer's jsdom, in the Worker beside the API, and WeasyPrint pay per SVG element; glyph paths make bytes bind
// first.
export const SVG_LIMIT = { elements: 50_000, bytes: 10_000_000 };

// MathJax takes 1 to 2 ms an equation, after about 0.1 s loading itself.
export const MAX_SVG_EQUATIONS = 1000;

// The <math>'s own display="block" makes it a display equation. The promise API waits for the font ranges it loads.
export async function mathmlToSvg(mathml: string): Promise<string> {
    converter ??= loadConverter();
    const { adaptor, document } = await converter;
    return adaptor.innerHTML(await document.convertPromise(mathml));
}
