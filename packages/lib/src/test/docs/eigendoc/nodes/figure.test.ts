import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { createDocument, generateHTML, getSchema } from '@tiptap/core';
import type { FigureLayout } from '../../../../docs/eigendoc';
import {
    figureLayoutStyle,
    getDocExtensions,
    isPositioned,
    MAX_PAPER_MM,
    mmToPx,
    readFigureAttrs,
} from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser.
installHappyDom();

const extensions = getDocExtensions();
const figureDoc = (attrs: Record<string, unknown>): JSONContent => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'figure', attrs }] }],
});

describe('figure HTML', () => {
    // The clipboard carries a cut image as this HTML, so a commented image keeps its card like commented text.
    test("a figure's comment card survives the HTML round-trip", () => {
        const html = generateHTML(figureDoc({ mediaName: 'a.png', commentCardId: 'card-1' }), extensions);
        expect(html).toContain('<span class="figure" data-comment-id="card-1">');
        const ids: unknown[] = [];
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.name === 'figure') ids.push(node.attrs.commentCardId);
        });
        expect(ids).toEqual(['card-1']);
    });

    test('an uncommented figure writes no comment id', () => {
        expect(generateHTML(figureDoc({ mediaName: 'a.png' }), extensions)).not.toContain('data-comment-id');
    });

    // A peer writes any value, and a copy serializes the node.
    test('a caption that is not a string renders none, never throwing', () => {
        expect(generateHTML(figureDoc({ mediaName: 'a.png', caption: 3 }), extensions)).not.toContain('figcaption');
    });
});

describe('figure parse', () => {
    const figuresIn = (html: string) => {
        const figures: Record<string, unknown>[] = [];
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.name === 'figure') figures.push(node.attrs);
        });
        return figures;
    };

    // The export writes a figure as spans, which a paragraph can hold, so its HTML imports back whole.
    test('an exported figure comes back with its caption, layout, alignment and width', () => {
        const figures = figuresIn(
            '<p>before <span class="figure" data-layout="wrap-left" data-alignment="center"><img src="data:image/png;base64,AA==" alt="A chart" style="width: 320px; max-width: 100%"><span class="figcaption">Sales</span></span> after</p>' +
                '<p><span class="figure" data-layout="block" data-alignment="right"><img src="data:image/png;base64,AA=="></span></p>',
        );
        expect(figures).toMatchObject([
            { src: 'data:image/png;base64,AA==', alt: 'A chart', caption: 'Sales', layout: 'wrap-left', width: 320 },
            { layout: 'block', alignment: 'right', caption: null },
        ]);
    });

    // Eigen's own span writes the height a stretched picture stores. Another app's <img width height> often carries a
    // size its CSS overrides, so there the picture keeps its own ratio.
    test('an own figure span parses its height, and a foreign figure or a bare image none', () => {
        expect(
            figuresIn(
                '<p><span class="figure"><img src="a.png" width="320" height="90"></span></p>' +
                    '<figure><img src="b.png" width="320" height="90"></figure>' +
                    '<p><img src="c.png" width="320" height="90"></p>',
            ),
        ).toMatchObject([
            { src: 'a.png', width: 320, height: 90 },
            { src: 'b.png', width: 320, height: null },
            { src: 'c.png', width: 320, height: null },
        ]);
    });

    test('a stretched figure writes its height and survives the HTML round-trip', () => {
        const html = generateHTML(figureDoc({ mediaName: 'a.png', width: 320, height: 90 }), extensions);
        expect(html).toContain('height="90"');
        expect(figuresIn(html)).toMatchObject([{ mediaName: 'a.png', width: 320, height: 90 }]);
    });

    test('a figure without a height writes none and comes back without one', () => {
        const html = generateHTML(figureDoc({ mediaName: 'a.png', width: 320 }), extensions);
        expect(html).not.toContain('height');
        expect(figuresIn(html)).toMatchObject([{ mediaName: 'a.png', width: 320, height: null }]);
    });

    test('a figure element still parses', () => {
        expect(
            figuresIn(
                '<figure data-layout="wrap-right" data-alignment="left"><img src="a.png"><figcaption>Old</figcaption></figure>',
            ),
        ).toMatchObject([{ src: 'a.png', caption: 'Old', layout: 'wrap-right', alignment: 'left' }]);
    });

    // A paste or a peer's HTML carries any string; the node keeps only a value the renderers know.
    test('a layout or an alignment it does not know parses as the default', () => {
        expect(
            figuresIn(
                '<p><span class="figure" data-layout="float" data-alignment="middle"><img src="a.png"></span></p>',
            ),
        ).toMatchObject([{ layout: 'block', alignment: 'center' }]);
    });
});

describe('a figure in front of or behind the text', () => {
    const figuresIn = (html: string) => {
        const figures: Record<string, unknown>[] = [];
        createDocument(html, getSchema(extensions)).descendants((node) => {
            if (node.type.name === 'figure') figures.push(node.attrs);
        });
        return figures;
    };
    const MAX_OFFSET = mmToPx(MAX_PAPER_MM);

    // A docs-to-docs paste keeps the place, and the offsets a block or a wrap keeps for a later switch back.
    test.each(['block', 'wrap-left', 'wrap-right', 'front', 'behind'])(
        'a %s figure survives the HTML round-trip with its offsets',
        (layout) => {
            const attrs = { mediaName: 'a.png', width: 320, layout, offsetX: -24.5, offsetY: 130 };
            expect(figuresIn(generateHTML(figureDoc(attrs), extensions))).toMatchObject([attrs]);
        },
    );

    test('a figure that was never placed writes no offsets', () => {
        const html = generateHTML(figureDoc({ mediaName: 'a.png', layout: 'front' }), extensions);
        expect(html).toContain('data-layout="front"');
        expect(html).not.toContain('data-offset');
        expect(figuresIn(html)).toMatchObject([{ layout: 'front', offsetX: null, offsetY: null }]);
    });

    // A peer or a paste writes anything; a forged offset must not stall the layout.
    test('an offset that is no finite number parses as unset, and a far one at the largest paper', () => {
        const span = (x: string, y: string) =>
            `<p><span class="figure" data-layout="behind" data-offset-x="${x}" data-offset-y="${y}"><img src="a.png"></span></p>`;
        expect(figuresIn(span('NaN', 'ten') + span('1e9', '-1e9') + span('Infinity', ''))).toMatchObject([
            { layout: 'behind', offsetX: null, offsetY: null },
            { offsetX: MAX_OFFSET, offsetY: -MAX_OFFSET },
            { offsetX: null, offsetY: null },
        ]);
    });

    // Only Eigen's own span places a figure: another app's markup has no anchor paragraph to count from.
    test("another app's figure or absolutely placed image parses in line", () => {
        expect(
            figuresIn(
                '<figure data-layout="front" data-offset-x="10"><img src="b.png"></figure>' +
                    '<p><img src="c.png" style="position: absolute; left: 40px; top: 10px"></p>',
            ),
        ).toMatchObject([
            { layout: 'block', offsetX: null },
            { layout: 'block', offsetX: null },
        ]);
    });

    test('isPositioned names the two layouts out of the flow', () => {
        const layouts: (FigureLayout | null)[] = ['block', 'wrap-left', 'wrap-right', 'front', 'behind', null];
        expect(layouts.map((layout) => isPositioned(layout))).toEqual([false, false, false, true, true, false]);
    });
});

describe('figureLayoutStyle', () => {
    test('places a positioned figure at its offsets, its width on the box', () => {
        expect(figureLayoutStyle({ layout: 'front', offsetX: -12, offsetY: 40, width: 320 })).toEqual({
            left: -12,
            top: 40,
            width: 320,
        });
    });

    test("an unplaced figure sits at its paragraph's corner, and one with no width takes its own", () => {
        expect(figureLayoutStyle({ layout: 'behind', offsetX: null, offsetY: null, width: null })).toEqual({
            left: 0,
            top: 0,
        });
    });

    // The box carries the width: the image's max-width of 100% inside a shrink-to-fit box would be cyclic.
    test('a width past the largest paper draws at it', () => {
        expect(figureLayoutStyle({ layout: 'front', width: 1e9 })?.width).toBe(mmToPx(MAX_PAPER_MM));
    });

    test('a figure in the flow takes no style, whatever offsets it keeps', () => {
        for (const layout of ['block', 'wrap-left', 'wrap-right', null] as const) {
            expect(figureLayoutStyle({ layout, offsetX: 10, offsetY: 10, width: 320 })).toBeUndefined();
        }
    });
});

describe('readFigureAttrs', () => {
    test('reads the attributes a figure stores', () => {
        expect(readFigureAttrs({ mediaName: 'a.png', width: 320, alignment: 'right', layout: 'wrap-left' })).toEqual({
            mediaName: 'a.png',
            src: null,
            alt: null,
            caption: null,
            width: 320,
            height: null,
            alignment: 'right',
            layout: 'wrap-left',
            offsetX: null,
            offsetY: null,
            commentCardId: null,
        });
    });

    test('reads a value of the wrong type as unset', () => {
        expect(
            readFigureAttrs({
                caption: 7,
                width: '320',
                alignment: 'middle',
                layout: 'float',
                offsetX: '12',
                offsetY: Number.NaN,
            }),
        ).toMatchObject({ caption: null, width: null, alignment: null, layout: null, offsetX: null, offsetY: null });
    });

    test('reads a width of 0 or less as unset, and one wider than the largest paper as that paper', () => {
        expect(readFigureAttrs({ width: 0 }).width).toBeNull();
        expect(readFigureAttrs({ width: -50 }).width).toBeNull();
        expect(readFigureAttrs({ width: 1e9 }).width).toBe(mmToPx(MAX_PAPER_MM));
    });

    test('reads a positive height, one taller than the largest paper as that paper, and any other as unset', () => {
        expect(readFigureAttrs({ height: 90 }).height).toBe(90);
        expect(readFigureAttrs({ height: 1e9 }).height).toBe(mmToPx(MAX_PAPER_MM));
        expect(readFigureAttrs({ height: '90' }).height).toBeNull();
        expect(readFigureAttrs({ height: -5 }).height).toBeNull();
    });

    test('reads a positioned figure, its far offsets at the largest paper', () => {
        expect(readFigureAttrs({ layout: 'behind', offsetX: -1e9, offsetY: 64 })).toMatchObject({
            layout: 'behind',
            offsetX: -mmToPx(MAX_PAPER_MM),
            offsetY: 64,
        });
    });
});
