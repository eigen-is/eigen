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

// WeasyPrint takes 10 to 20 ms to draw an equation's SVG and MathJax 1 to 2 ms to make one, after 0.4 s loading itself
// (measured over the 108 corpus equations), so 1,000 add about 20 s to a PDF, inside WeasyPrint's 60 s. A PDF draws the
// rest as text. A tree at the math bounds takes MathJax 0.6 s; the transform deadline ends a document of those.
export const MAX_SVG_EQUATIONS = 1000;

// The <math>'s own display="block" makes it a display equation. The promise API waits for the font ranges it loads.
export async function mathmlToSvg(mathml: string): Promise<string> {
    converter ??= loadConverter();
    const { adaptor, document } = await converter;
    return adaptor.innerHTML(await document.convertPromise(mathml));
}
