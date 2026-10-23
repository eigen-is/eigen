// The pure half of Download image: the elements it draws, what they are drawn on, which faces the file embeds and
// what the file is called. The browser half (layout, fetches) is packages/ui's canvas image writer.
import { describe, expect, test } from 'bun:test';
import { FLAT_CHART_LOOK, sampleChartSpec } from '../../charts';
import { buildChartClipboardItem } from '../../core/clipboard/clipboard';
import { canvasImageFaces, canvasImageName, canvasImageScene, chartImageName } from '../../vector/canvas-image';
import { solidFill } from '../../vector/fill';
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

describe('canvasImageScene', () => {
    test("the editor's own elements are what the image draws, read directly", () => {
        const scene = canvasImageScene([shape({ id: 'r', type: 'rectangle' }), chart({ id: 'c' })]);

        expect(scene.elements.map((el) => el.id)).toEqual(['r', 'c']);
        expect(scene.frames).toEqual([]);
    });

    // The paste reader stops at 10,000 records a forged wire claims; the editor's own drawing is no clipboard input.
    test('a drawing past the paste cap draws every element', () => {
        const elements = Array.from({ length: 10_001 }, (_, i) => shape({ id: `r${i}`, type: 'rectangle' }));

        expect(canvasImageScene(elements).elements).toHaveLength(10_001);
    });

    test('a chart another app copies draws as the one chart element a paste makes of it, at the origin', () => {
        const spec = JSON.stringify(sampleChartSpec('column'));
        const item = buildChartClipboardItem({
            spec,
            box: { width: 480, height: 300 },
            look: { ...FLAT_CHART_LOOK, fill: solidFill('#ff0000'), strokeColor: '#00ff00', roughness: 2, seed: 7 },
        });
        if (!item) throw new Error('no chart item');

        const [el, ...rest] = canvasImageScene(item).elements;
        expect(rest).toEqual([]);
        expect(el).toMatchObject({
            type: 'chart',
            chart: spec,
            x: 0,
            y: 0,
            width: 480,
            height: 300,
            angle: 0,
            fill: solidFill('#ff0000'),
            strokeColor: '#00ff00',
            roughness: 2,
            seed: 7,
        });
    });

    test('a selection draws on nothing, whatever the drawing is on', () => {
        const scene = canvasImageScene([shape({ id: 'r', type: 'rectangle' }), chart({ id: 'c' })]);

        expect(scene.meta.background).toBe('transparent');
    });

    test('a single chart draws on white, as a chart in a doc or a sheet does', () => {
        expect(canvasImageScene([chart({ id: 'c' })]).meta.background).toBe('#ffffff');
        const item = buildChartClipboardItem({
            spec: JSON.stringify(sampleChartSpec('pie')),
            box: { width: 9, height: 9 },
            look: FLAT_CHART_LOOK,
        });
        if (!item) throw new Error('no chart item');
        expect(canvasImageScene(item).meta.background).toBe('#ffffff');
    });

    test('the whole drawing draws on its own background', () => {
        expect(canvasImageScene([chart({ id: 'c' })], '#123456').meta.background).toBe('#123456');
        expect(canvasImageScene([shape({ id: 'r', type: 'rectangle' })], 'transparent').meta.background).toBe(
            'transparent',
        );
    });
});

describe('canvasImageName', () => {
    const titled = (title: string) => chart({ id: 'c', chart: JSON.stringify({ ...sampleChartSpec('bar'), title }) });

    test("a chart is named for its title, without the characters a file name can't hold", () => {
        expect(canvasImageName([titled('Q3: sales / costs?')], 'Plan')).toBe('Q3 sales costs');
        expect(chartImageName(JSON.stringify({ ...sampleChartSpec('bar'), title: 'Light' }))).toBe('Light');
    });

    test('a chart without a title, or one that does not parse, is "Chart"', () => {
        expect(canvasImageName([titled('  ')], 'Plan')).toBe('Chart');
        expect(chartImageName('{')).toBe('Chart');
    });

    test('anything else is a selection of the file', () => {
        expect(canvasImageName([titled('Light'), shape({ id: 'r', type: 'rectangle' })], 'Plan')).toBe(
            'Plan – selection',
        );
        expect(canvasImageName([shape({ id: 'r', type: 'rectangle' })], 'Plan')).toBe('Plan – selection');
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
