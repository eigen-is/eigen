// A rich-text box's text as SVG <text>: the browser lays the box out, and each run of characters it placed side by
// side on one baseline becomes one positioned <tspan>. These boxes are what the DOM adapter (packages/ui's canvas
// image writer) reads back with Range.getClientRects.
import { describe, expect, test } from 'bun:test';
import type { MeasuredChar, MeasuredText, MeasuredTextStyle } from '../../vector/rich-text-svg';
import { richTextSvg } from '../../vector/rich-text-svg';

const STYLE: MeasuredTextStyle = {
    fontFamily: 'Excalifont, cursive',
    fontSize: 20,
    fontWeight: '400',
    fontStyle: 'normal',
    fontVariantNumeric: 'normal',
    color: 'rgb(30, 30, 30)',
    opacity: 1,
    decoration: '',
    letterSpacing: 0,
};

// A line of characters 10 px wide each, from `x`, its boxes 25 px tall from `y`.
function line(text: string, x: number, y: number, width = 10): MeasuredChar[] {
    return [...text].map((ch, i) => ({ text: ch, x: x + i * width, y, width, height: 25 }));
}

function text(chars: MeasuredChar[], style: Partial<MeasuredTextStyle> = {}): MeasuredText {
    return { style: { ...STYLE, ...style }, ascent: 18, chars };
}

function tspans(svg: string): { x: string; y: string; text: string; attrs: string }[] {
    return [...svg.matchAll(/<tspan x="([^"]+)" y="([^"]+)"([^>]*)>([^<]*)<\/tspan>/g)].map((m) => ({
        x: m[1],
        y: m[2],
        attrs: m[3],
        text: m[4],
    }));
}

describe('richTextSvg', () => {
    test('a line is one tspan at its first character, on the baseline the ascent puts below its top', () => {
        const svg = richTextSvg({ texts: [text(line('Hello', 4, 2))], rules: [], discs: [], justify: false });

        expect(tspans(svg)).toEqual([{ x: '4', y: '20', text: 'Hello', attrs: expect.any(String) }]);
        expect(svg).toStartWith('<text xml:space="preserve" style="white-space:pre">');
    });

    test('alignment is where the browser put the line: a centred line keeps its measured start', () => {
        const svg = richTextSvg({ texts: [text(line('Hi', 85, 0))], rules: [], discs: [], justify: false });

        expect(tspans(svg).map((t) => t.x)).toEqual(['85']);
    });

    test('a wrapped text node is a tspan per line, without the space the wrap swallowed', () => {
        const chars = [...line('one two ', 0, 0), ...line('three', 0, 30)];
        const svg = richTextSvg({ texts: [text(chars)], rules: [], discs: [], justify: false });

        expect(tspans(svg).map(({ x, y, text }) => ({ x, y, text }))).toEqual([
            { x: '0', y: '18', text: 'one two' },
            { x: '0', y: '48', text: 'three' },
        ]);
    });

    test('runs on one line are a tspan each, the space between them kept where it was drawn', () => {
        const plain = line('plain ', 0, 0);
        const bold = line('bold', 60, 0, 11);
        const svg = richTextSvg({
            texts: [text(plain), text(bold, { fontWeight: '700' })],
            rules: [],
            discs: [],
            justify: false,
        });

        expect(tspans(svg).map(({ x, text }) => ({ x, text }))).toEqual([
            { x: '0', text: 'plain ' },
            { x: '60', text: 'bold' },
        ]);
        expect(tspans(svg)[1].attrs).toContain('font-weight="700"');
        expect(tspans(svg)[0].attrs).not.toContain('font-weight');
    });

    test('a run carries its font, size, style, colour, decoration and letter spacing', () => {
        const svg = richTextSvg({
            texts: [
                text(line('styled', 0, 0), {
                    fontFamily: '"Source Serif 4", serif',
                    fontSize: 32,
                    fontStyle: 'italic',
                    color: 'rgba(255, 0, 16, 0.5)',
                    opacity: 0.7,
                    decoration: 'underline line-through',
                    letterSpacing: 2,
                }),
            ],
            rules: [],
            discs: [],
            justify: false,
        });

        const attrs = tspans(svg)[0].attrs;
        expect(attrs).toContain('font-family="&quot;Source Serif 4&quot;, serif"');
        expect(attrs).toContain('font-size="32px"');
        expect(attrs).toContain('font-style="italic"');
        expect(attrs).toContain('fill="#ff0010"');
        expect(attrs).toContain('fill-opacity="0.35"');
        expect(attrs).toContain('text-decoration="underline line-through"');
        expect(attrs).toContain('letter-spacing="2"');
    });

    test('a plain run writes no attribute it leaves at its default', () => {
        const attrs = tspans(richTextSvg({ texts: [text(line('a', 0, 0))], rules: [], discs: [], justify: false }))[0]
            .attrs;

        expect(attrs).toBe(' font-family="Excalifont, cursive" font-size="20px" fill="#1e1e1e"');
    });

    // A computed color in rgb() becomes a hex and an opacity; any other color is written as the browser gave it.
    test.each([
        ['rgb(30,30,30)', ' fill="#1e1e1e"'],
        ['rgb(30 30 30 / 50%)', ' fill="#1e1e1e" fill-opacity="0.5"'],
        ['rgba(30, 30, 30, 0.25)', ' fill="#1e1e1e" fill-opacity="0.25"'],
        ['rgb(1.4, 2.6, 3)', ' fill="#010303"'],
        ['color(display-p3 1 0 0)', ' fill="color(display-p3 1 0 0)"'],
    ])('the color %p is written as %p', (color, fill) => {
        const attrs = tspans(
            richTextSvg({ texts: [text(line('a', 0, 0), { color })], rules: [], discs: [], justify: false }),
        )[0].attrs;
        expect(attrs).toEndWith(fill);
    });

    test("a number marker is its own tspan left of the item's text, which keeps its own start", () => {
        const marker = text(line('1. ', 6, 0, 4));
        const item = text(line('Item', 18, 0));
        const svg = richTextSvg({ texts: [marker, item], rules: [], discs: [], justify: false });

        expect(tspans(svg).map(({ x, text }) => ({ x, text }))).toEqual([
            { x: '6', text: '1. ' },
            { x: '18', text: 'Item' },
        ]);
    });

    // Chrome paints a disc as a circle, not the bullet glyph (ListMarker's symbol rect), from the ascent rounded to
    // a whole pixel: two thirds of it, halved, is the diameter, and the circle sits that two thirds plus 7 px before
    // the item, half its distance from the ascent down from the text's top. Measured against the canvas in every
    // bundled face at 20 px, whose ascents round to 18, 19, 20 and 21.
    test.each([
        [17.72, { cx: '24', cy: '33', r: '3' }],
        [19.375, { cx: '24', cy: '33', r: '3' }],
        [20.4, { cx: '23.5', cy: '32.5', r: '3.5' }],
        [20.72, { cx: '22.5', cy: '31.5', r: '3.5' }],
    ])('a disc in a face of ascent %p is the circle Chrome paints before the item', (ascent, circle) => {
        const svg = richTextSvg({
            texts: [],
            rules: [],
            discs: [{ x: 40, baseline: 39, ascent, color: 'rgba(30, 30, 30, 0.5)', opacity: 1 }],
            justify: false,
        });

        expect(svg).toBe(
            `<circle cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}" fill="#1e1e1e" fill-opacity="0.5"/>`,
        );
    });

    test('a numbered marker keeps its tabular figures', () => {
        const svg = richTextSvg({
            texts: [text(line('1. ', 0, 0), { fontVariantNumeric: 'tabular-nums' })],
            rules: [],
            discs: [],
            justify: false,
        });

        expect(tspans(svg)[0].attrs).toContain('style="font-variant-numeric:tabular-nums"');
    });

    test('a justified line places every word where the browser stretched it', () => {
        const chars = [...line('a ', 0, 0), ...line('b', 40, 0)];
        chars[1].width = 30;
        const svg = richTextSvg({ texts: [text(chars)], rules: [], discs: [], justify: true });

        expect(tspans(svg).map(({ x, text }) => ({ x, text }))).toEqual([
            { x: '0', text: 'a ' },
            { x: '40', text: 'b' },
        ]);
    });

    test('characters the browser collapsed are left out, and a newline it drew is a space', () => {
        const svg = richTextSvg({ texts: [text(line('a\nb', 0, 0))], rules: [], discs: [], justify: false });

        expect(tspans(svg)[0].text).toBe('a b');
    });

    test('text is escaped', () => {
        expect(
            tspans(richTextSvg({ texts: [text(line('<&>', 0, 0))], rules: [], discs: [], justify: false }))[0].text,
        ).toBe('&lt;&amp;&gt;');
    });

    test("a quote's rule is a rect in its colour, under the text", () => {
        const svg = richTextSvg({
            texts: [text(line('q', 12, 0))],
            rules: [{ x: 0, y: 0, width: 3, height: 25, color: 'rgb(0, 0, 0)', opacity: 0.7 }],
            discs: [],
            justify: false,
        });

        expect(svg).toStartWith('<rect x="0" y="0" width="3" height="25" fill="#000000" fill-opacity="0.7"/><text');
    });

    test('an empty box draws nothing', () => {
        expect(richTextSvg({ texts: [], rules: [], discs: [], justify: false })).toBe('');
        expect(richTextSvg({ texts: [text(line('  ', 0, 0))], rules: [], discs: [], justify: false })).toBe('');
    });
});
