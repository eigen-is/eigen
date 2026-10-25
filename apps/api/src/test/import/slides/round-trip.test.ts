import { describe, expect, test } from 'bun:test';
import { defaultChartSpec, newChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { BackgroundFill } from '@workspace/lib/types/background';
import type { ChartStacking } from '@workspace/lib/types/chart';
import type { NewVectorElement, VectorElement } from '@workspace/lib/vector';
import {
    generateNKeysBetween,
    normalizeAngle,
    parseFill,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    serializeFill,
    TRANSPARENT_FILL,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { toTransferableBuffer } from '../../../lib/document/transform/protocol';
import { sanitizeSceneHtml } from '../../../lib/export/sanitize';
import { writePptx } from '../../../lib/export/slides/pptx/to-pptx';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { seriesIdsByPlace } from '../../../scripts/office-audit';
import { sampleChartParts } from '../../fixtures/chart-parts';
import { box, buildPptx, PIXEL_PNG, solid as solidFill, sp } from '../../fixtures/pptx';

// A deck exported to .pptx and read back: what the writer states, the reader reads the same.

const FRAME = { width: 1920, height: 1080 };

const gradient = (from: string, to: string, angle: number) =>
    serializeFill({ type: 'gradient', from, to, angle, style: 'solid' });

const twoPoints = (width: number, height: number) =>
    JSON.stringify([
        [0, 0],
        [width, height],
    ]);

const ELEMENTS: NewVectorElement[] = [
    { type: 'rectangle', x: 40, y: 40, width: 400, height: 100, angle: 0, fill: gradient('#ff0000', '#0000ff', 0) },
    { type: 'rectangle', x: 40, y: 200, width: 400, height: 100, angle: 0, fill: gradient('#00aa00', '#ffff00', 45) },
    { type: 'rectangle', x: 500, y: 40, width: 100, height: 300, angle: 0, fill: gradient('#123456', '#fedcba', 120) },
    { type: 'ellipse', x: 650, y: 40, width: 300, height: 120, angle: 15, fill: gradient('#ff8800', '#8800ff', 250) },
    {
        type: 'rectangle',
        x: 1000,
        y: 40,
        width: 200,
        height: 150,
        angle: 0,
        strokeColor: '#222222',
        strokeWidth: 4,
        corners: 'straight',
    },
    {
        type: 'diamond',
        x: 1250,
        y: 40,
        width: 200,
        height: 120,
        angle: 0,
        corners: 'straight',
        fill: gradient('#ff000080', '#0000ff', 30),
    },
    { type: 'pie', x: 1500, y: 40, width: 240, height: 160, angle: 20, startAngle: 30, sweepAngle: 120 },
    {
        type: 'richtext',
        x: 100,
        y: 500,
        width: 600,
        height: 240,
        angle: 30,
        html: '<p>Plain <strong>bold</strong> and <em>italic</em></p><ul><li><p>one</p></li><li><p>two</p></li></ul>',
        fontFamily: 'Source Serif 4',
        fontSize: 40,
        color: '#333333',
        textAlign: 'center',
        verticalAlign: 'center',
    },
    {
        type: 'richtext',
        x: 1000,
        y: 800,
        width: 500,
        height: 200,
        angle: 0,
        html: '<p><a href="https://eigen.is">Linked</a> line</p><p>second</p><ol><li><p>first</p></li></ol>',
        fontWeight: 'bold',
        textDecoration: 'underline',
        letterSpacing: 2,
        lineHeight: 1.5,
        padding: 12,
        textAlign: 'right',
        verticalAlign: 'bottom',
        corners: 'straight',
        fill: serializeFill({ type: 'solid', color: '#ffeedd', style: 'solid' }),
    },
    {
        type: 'arrow',
        x: 900,
        y: 600,
        width: 400,
        height: 200,
        angle: 0,
        points: twoPoints(400, 200),
        strokeColor: '#c0504d',
        strokeWidth: 3,
        startArrowhead: 'none',
        endArrowhead: 'triangle',
        elbow: false,
    },
    { type: 'line', x: 600, y: 850, width: 300, height: 0, angle: 0, points: twoPoints(300, 0), strokeStyle: 'dashed' },
    { type: 'image', x: 1400, y: 500, width: 320, height: 180, angle: 0, mediaName: 'pic.png', objectFit: 'fill' },
];

const BACKGROUND: BackgroundFill = { type: 'gradient', from: '#102030', to: '#f0e0d0', angle: 135 };

function roundTrip(elements = ELEMENTS, name = '') {
    const doc = new Y.Doc();
    writeFrameInDoc(doc, { id: 'f1', index: 'a0', name, ...FRAME, background: serializeBackgroundFill(BACKGROUND) });
    const keys = generateNKeysBetween(null, null, elements.length);
    for (const [i, element] of elements.entries())
        writeElementInDoc(doc, { ...element, frameId: 'f1' }, keys[i], SLIDES_STYLE_DEFAULTS, `el-${i}`);
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const media = [{ name: 'pic.png', contentType: 'image/png', data: toTransferableBuffer(PIXEL_PNG.slice()) }];
    const bytes = writePptx(scene, { title: 'Round trip.eigenslides', media });
    return { sent: scene.elements, deck: readPptx(bytes, { deck: scene.meta, maxMediaBytes: 1024 * 1024 }) };
}

function expectPx(found: number | undefined, wanted: number) {
    expect(Math.abs((found ?? Number.NaN) - wanted)).toBeLessThanOrEqual(1);
}

function expectDegrees(found: number | undefined, wanted: number) {
    const off = normalizeAngle((found ?? Number.NaN) - wanted);
    expect(Math.min(off, 360 - off)).toBeLessThanOrEqual(0.01);
}

describe('a deck exported and read back', () => {
    const { sent, deck } = roundTrip();
    const [slide] = deck.slides;
    const pairs = sent.map((element, i): [VectorElement, NewVectorElement] => [element, slide.elements[i]]);

    test('keeps one slide and every element, in order', () => {
        expect(deck.slides).toHaveLength(1);
        expect(slide.elements.map((found) => found.type)).toEqual(sent.map((element) => element.type));
        expect(deck.warnings).toEqual([]);
    });

    test('keeps each box, its turn and its corners', () => {
        for (const [element, found] of pairs) {
            expectPx(found.x, element.x);
            expectPx(found.y, element.y);
            expectPx(found.width, element.width);
            expectPx(found.height, element.height);
            expectDegrees(found.angle, element.angle);
            if (element.type === 'rectangle' || element.type === 'diamond' || element.type === 'image')
                expect(found.corners).toBe(element.corners);
        }
    });

    test("keeps a gradient's angle on a box of any shape, and its end stops", () => {
        let gradients = 0;
        for (const [element, found] of pairs) {
            const fill = 'fill' in element ? parseFill(element.fill) : undefined;
            if (fill?.type !== 'gradient') continue;
            const back = parseFill(String(found.fill));
            expect(back.type).toBe('gradient');
            if (back.type !== 'gradient') continue;
            expectDegrees(back.angle, fill.angle);
            expect([back.from, back.to]).toEqual([fill.from, fill.to]);
            gradients++;
        }
        expect(gradients).toBe(5);
    });

    test('keeps a gradient background at its angle, and its end stops', () => {
        expect(slide.background).toEqual(BACKGROUND);
    });

    test("keeps a pie's angles, and each stroke's colour, width and dash", () => {
        const [pie, back] = pairs[6];
        expect(back.type).toBe('pie');
        if (pie.type !== 'pie') throw new Error('not a pie');
        expectDegrees(back.startAngle, pie.startAngle);
        expectDegrees(back.sweepAngle, pie.sweepAngle);
        for (const [element, found] of pairs) {
            expect(found.strokeColor).toBe(element.strokeColor);
            expect(found.strokeStyle).toBe(element.strokeStyle);
            if (element.strokeColor !== 'transparent') expectPx(found.strokeWidth, element.strokeWidth);
        }
    });

    test('keeps rich text: its html, typography and box fields', () => {
        for (const [element, found] of pairs) {
            if (element.type !== 'richtext') continue;
            expect(found).toMatchObject({
                html: element.html,
                fontFamily: element.fontFamily,
                fontWeight: element.fontWeight,
                fontStyle: element.fontStyle,
                textDecoration: element.textDecoration,
                color: element.color,
                textAlign: element.textAlign,
                verticalAlign: element.verticalAlign,
                fill: element.fill,
            });
            expectPx(found.fontSize, element.fontSize);
            expectPx(found.padding, element.padding);
            expect(found.lineHeight).toBeCloseTo(element.lineHeight, 2);
            expect(found.letterSpacing).toBeCloseTo(element.letterSpacing, 2);
        }
    });

    test("keeps a line's points and an arrow's heads", () => {
        for (const [element, found] of pairs) {
            if (element.type !== 'arrow' && element.type !== 'line') continue;
            expect(found.points).toBe(element.points);
            if (element.type === 'arrow')
                expect(found).toMatchObject({
                    startArrowhead: element.startArrowhead,
                    endArrowhead: element.endArrowhead,
                });
        }
    });

    test("keeps a bordered text box's text inside its border, where the canvas draws it", () => {
        const bordered: NewVectorElement = {
            type: 'richtext',
            x: 100,
            y: 100,
            width: 400,
            height: 200,
            angle: 0,
            html: '<p>Boxed</p>',
            strokeColor: '#222222',
            strokeWidth: 4,
            padding: 12,
            corners: 'straight',
        };
        const [found] = roundTrip([bordered]).deck.slides[0].elements;
        expectPx(found.padding, 12);
    });

    test("keeps the slide's name, which no title gives it", () => {
        expect(roundTrip([], 'Agenda').deck.slides[0].name).toBe('Agenda');
    });

    test('keeps a picture and its bytes', () => {
        expect(deck.media).toHaveLength(1);
        expect(new Uint8Array(deck.media[0].data)).toEqual(PIXEL_PNG);
        expect(slide.elements.at(-1)).toMatchObject({ mediaName: deck.media[0].name, objectFit: 'fill' });
    });
});

describe('charts exported and read back', () => {
    const stacked = (type: 'column' | 'bar', stacking: ChartStacking) => {
        const spec = sampleChartSpec(type);
        return newChartSpecParts({ ...spec, plots: { ...spec.plots, [type]: { stacking } } });
    };
    const CHARTS: NewVectorElement[] = [
        sampleChartParts('column'),
        stacked('bar', 'stacked'),
        stacked('column', 'percent'),
        sampleChartParts('line'),
        sampleChartParts('pie', 'Source Serif 4'),
    ].map((parts, i) => ({ type: 'chart', x: 40 + i * 300, y: 100, width: 280, height: 200, angle: 0, ...parts }));
    const { sent, deck } = roundTrip(CHARTS);
    const found = deck.slides[0].elements;
    // A series id is identity, not content, and the writer writes none.
    const specOf = (element: object) => {
        const { spec } = readChartSpec(element);
        return spec && seriesIdsByPlace(spec);
    };

    test('come back as the same charts, at their boxes, in their text colour', () => {
        expect(found.map((element) => element.type)).toEqual(sent.map(() => 'chart'));
        expect(deck.warnings).toEqual([]);
        for (const [i, element] of sent.entries()) {
            const back = found[i];
            const spec = specOf(element);
            // A pie has no axes in Office, so its axis fields come back as Excel's pie's: no titles, no gridlines.
            const { x, y } = defaultChartSpec('pie', { source: 'inline', categories: [], series: [] }).axes;
            const axes = spec?.chart.type === 'pie' ? { x, y: { ...y, gridlines: { visible: false } } } : spec?.axes;
            expect(specOf(back)).toEqual(spec && { ...spec, axes });
            for (const field of ['x', 'y', 'width', 'height'] as const) expectPx(back[field], element[field]);
            if (element.type === 'chart') expect(back).toMatchObject({ color: element.color, fill: element.fill });
        }
    });
});

// A path's numbers, each within 0.0001 of the unit box's.
function expectPath(found: unknown, wanted: string) {
    const tokens = (path: string) => path.split(' ');
    const [back, sent] = [tokens(String(found)), tokens(wanted)];
    expect(back.map((token) => /[A-Z]/.test(token) && token)).toEqual(
        sent.map((token) => /[A-Z]/.test(token) && token),
    );
    for (const [i, token] of sent.entries())
        if (!/[A-Z]/.test(token)) expect(Math.abs(Number(back[i]) - Number(token))).toBeLessThanOrEqual(0.0001);
}

describe('paths exported and read back', () => {
    const solid = serializeFill({ type: 'solid', color: '#336699', style: 'solid' });
    const PATHS: NewVectorElement[] = [
        {
            type: 'path',
            x: 100,
            y: 100,
            width: 400,
            height: 300,
            angle: 10,
            // Clockwise, its hole the other way round, as the reader winds a contour inside another.
            path: 'M 0 0 L 1 0 C 1 0.3333 1.05 0.6667 1 1 L 0 1 Z M 0.25 0.25 Q 0.2 0.5 0.25 0.75 L 0.75 0.75 L 0.75 0.25 Z',
            closed: true,
            fill: solid,
            strokeColor: '#222222',
            strokeWidth: 3,
            strokeStyle: 'dashed',
        },
        {
            type: 'path',
            x: 600,
            y: 100,
            width: 300,
            height: 120,
            angle: 0,
            path: 'M 0 0 C 0.3 1 0.7 1 1 0 L 1 0.5',
            closed: false,
            strokeColor: '#c0504d',
            strokeWidth: 2,
        },
        {
            type: 'path',
            x: 1000,
            y: 100,
            width: 200,
            height: 400,
            angle: 0,
            path: 'M 0.5 0 L 1 1 L 0 1 Z',
            closed: true,
            fill: gradient('#ff0000', '#0000ff', 60),
        },
    ];
    const ROUNDED: NewVectorElement[] = [
        { type: 'diamond', x: 100, y: 600, width: 300, height: 200, angle: 0, corners: 'curved', fill: solid },
        {
            type: 'richtext',
            x: 600,
            y: 600,
            width: 400,
            height: 200,
            angle: 0,
            html: '<p>Rounded</p>',
            corners: 'curved',
            fill: solid,
        },
    ];
    const { sent, deck } = roundTrip([...PATHS, ...ROUNDED]);
    const [slide] = deck.slides;

    test('come back as paths of the same geometry, box, paint and stroke', () => {
        expect(deck.warnings).toEqual([]);
        for (const [i, element] of sent.slice(0, PATHS.length).entries()) {
            const found = slide.elements[i];
            if (element.type !== 'path') throw new Error('not a path');
            expect(found).toMatchObject({
                type: 'path',
                closed: element.closed,
                strokeColor: element.strokeColor,
                strokeStyle: element.strokeStyle,
            });
            expectPath(found.path, element.path);
            for (const field of ['x', 'y', 'width', 'height'] as const) expectPx(found[field], element[field]);
            expectDegrees(found.angle, element.angle);
            if (element.strokeColor !== 'transparent') expectPx(found.strokeWidth, element.strokeWidth);
            const [fill, back] = [parseFill(element.fill), parseFill(String(found.fill))];
            if (fill.type === 'gradient' && back.type === 'gradient') {
                expectDegrees(back.angle, fill.angle);
                expect([back.from, back.to]).toEqual([fill.from, fill.to]);
            } else expect(back).toEqual(element.closed ? fill : TRANSPARENT_FILL);
        }
    });

    test('a rounded diamond and a painted rounded text box, which the writer draws as custGeom, come back as paths', () => {
        const [diamond, box, text] = slide.elements.slice(PATHS.length);
        expect(slide.elements).toHaveLength(PATHS.length + 3);
        expect(diamond).toMatchObject({ type: 'path', closed: true, fill: solid });
        expect(String(diamond.path)).toMatch(/^M [^MZ]* C [^MZ]* Z$/);
        expect(box).toMatchObject({ type: 'path', closed: true, fill: solid });
        expect(text).toMatchObject({ type: 'richtext', html: '<p>Rounded</p>' });
        for (const [found, element] of [
            [diamond, ROUNDED[0]],
            [box, ROUNDED[1]],
            [text, ROUNDED[1]],
        ] as const) {
            expectPx(found.x, Number(element.x));
            expectPx(found.width, Number(element.width));
        }
    });
});

describe("a shape's overlapping paths imported, exported and read back", () => {
    test('are a path element each, so a reader filling each a:path even-odd still fills both', () => {
        // A wall and a brick on it, painting alike.
        const rect = (from: number, to: number) =>
            `<a:path w="10" h="10"><a:moveTo><a:pt x="${from}" y="${from}"/></a:moveTo><a:lnTo><a:pt x="${to}" y="${from}"/></a:lnTo><a:lnTo><a:pt x="${to}" y="${to}"/></a:lnTo><a:lnTo><a:pt x="${from}" y="${to}"/></a:lnTo><a:close/></a:path>`;
        const geometry = `<a:custGeom><a:avLst/><a:gdLst/><a:pathLst>${rect(0, 10)}${rect(2, 4)}</a:pathLst></a:custGeom>`;
        const shapes = sp({ xfrm: box(100, 100, 200, 200), spPr: `${geometry}${solidFill('993300')}` });
        const imported = readPptx(buildPptx({ slides: [{ shapes }] }), { maxMediaBytes: 1024 * 1024 });
        const { deck } = roundTrip(imported.slides[0].elements);
        const back = deck.slides[0].elements;
        expect(back.map((found) => [found.type, String(found.path).split('M').length - 1])).toEqual([
            ['path', 1],
            ['path', 1],
        ]);
        for (const found of back)
            expect(parseFill(String(found.fill))).toMatchObject({ type: 'solid', color: '#993300' });
    });
});
