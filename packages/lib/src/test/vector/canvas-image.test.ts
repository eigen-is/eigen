// The pure half of Download image: the elements a payload draws, what they are drawn on, and which faces the file
// embeds. The browser half (layout, fetches) is packages/ui's canvas image writer.
import { describe, expect, test } from 'bun:test';
import { buildElementsClipboardItem } from '../../vector';
import { canvasImageFaces, canvasImageScene } from '../../vector/canvas-image';
import type { MeasuredRichText, MeasuredText } from '../../vector/rich-text-svg';
import { arrow, chart, richtext, shape } from './element-factories';

function measured(fontFamily: string, fontStyle = 'normal'): MeasuredText {
    return {
        style: {
            fontFamily,
            fontSize: 20,
            fontWeight: '400',
            fontStyle,
            fontVariantNumeric: 'normal',
            color: 'rgb(0, 0, 0)',
            opacity: 1,
            decoration: '',
            letterSpacing: 0,
        },
        ascent: 18,
        chars: [],
    };
}

function box(...texts: MeasuredText[]): MeasuredRichText {
    return { texts, rules: [], discs: [], justify: false };
}

function payload(...elements: Parameters<typeof buildElementsClipboardItem>[0]) {
    const item = buildElementsClipboardItem(elements, '');
    return item ? [item] : [];
}

describe('canvasImageScene', () => {
    test("a payload's elements item is what the image draws", () => {
        const scene = canvasImageScene(payload(shape({ id: 'r', type: 'rectangle' }), chart({ id: 'c' })));

        expect(scene.elements.map((el) => el.id)).toEqual(['r', 'c']);
        expect(scene.frames).toEqual([]);
    });

    test('a payload without elements draws nothing', () => {
        expect(canvasImageScene([]).elements).toEqual([]);
    });

    test('a selection draws on nothing, whatever the drawing is on', () => {
        const scene = canvasImageScene(payload(shape({ id: 'r', type: 'rectangle' }), chart({ id: 'c' })));

        expect(scene.meta.background).toBe('transparent');
    });

    test('a single chart draws on white, as a chart in a doc or a sheet does', () => {
        expect(canvasImageScene(payload(chart({ id: 'c' }))).meta.background).toBe('#ffffff');
    });

    test('the whole drawing draws on its own background', () => {
        expect(canvasImageScene(payload(chart({ id: 'c' })), '#123456').meta.background).toBe('#123456');
        expect(canvasImageScene(payload(shape({ id: 'r', type: 'rectangle' })), 'transparent').meta.background).toBe(
            'transparent',
        );
    });
});

describe('canvasImageFaces', () => {
    const files = (...args: Parameters<typeof canvasImageFaces>) => canvasImageFaces(...args).map((face) => face.file);

    test("a text box embeds the faces its measured runs draw in, not its own font's", () => {
        const text = richtext({ id: 't', html: '<p><em>x</em></p>', fontFamily: 'Inter' });

        expect(files([text], new Map([['t', box(measured('"Source Serif 4", serif', 'italic'))]]))).toEqual([
            'source-serif/SourceSerif4-Variable-Italic.woff2',
        ]);
    });

    test("a label draws upright in its family, a chart in its spec's font", () => {
        expect(
            files([arrow({ id: 'a', text: 'go', fontFamily: 'JetBrains Mono' }), chart({ id: 'c' })], new Map()),
        ).toEqual(['jetbrains-mono/JetBrainsMono-Variable.woff2', 'excalifont/Excalifont-Regular.woff2']);
    });

    test('a drawing without text embeds no face', () => {
        expect(canvasImageFaces([shape({ id: 'r', type: 'rectangle' })], new Map())).toEqual([]);
    });
});
