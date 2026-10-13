import { describe, expect, test } from 'bun:test';
import type { BackgroundFill } from '@workspace/lib/types/background';
import {
    generateNKeysBetween,
    type NewVectorElement,
    normalizeAngle,
    parseFill,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    serializeFill,
    type VectorElement,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { toTransferableBuffer } from '../../../lib/document/transform/protocol';
import { sanitizeSceneHtml } from '../../../lib/export/sanitize';
import { eigenslidesToPptx } from '../../../lib/export/slides/to-pptx';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { PIXEL_PNG } from '../../fixtures/pptx';

// A deck exported to .pptx and read back: what the writer states, the reader reads the same. A rounded diamond and a
// painted rounded text box are left out: the writer draws both as custGeom, whose outline the reader drops.

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

function roundTrip() {
    const doc = new Y.Doc();
    writeFrameInDoc(doc, { id: 'f1', index: 'a0', ...FRAME, background: serializeBackgroundFill(BACKGROUND) });
    const keys = generateNKeysBetween(null, null, ELEMENTS.length);
    for (const [i, element] of ELEMENTS.entries())
        writeElementInDoc(doc, { ...element, frameId: 'f1' }, keys[i], SLIDES_STYLE_DEFAULTS, `el-${i}`);
    const scene = sanitizeSceneHtml(readVectorFromDoc(doc));
    const media = [{ name: 'pic.png', contentType: 'image/png', data: toTransferableBuffer(PIXEL_PNG.slice()) }];
    const bytes = eigenslidesToPptx(scene, media, 'Round trip.eigenslides');
    return { sent: scene.elements, deck: readPptx(bytes, { frame: FRAME, maxMediaBytes: 1024 * 1024 }) };
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

    test('keeps a picture and its bytes', () => {
        expect(deck.media).toHaveLength(1);
        expect(new Uint8Array(deck.media[0].data)).toEqual(PIXEL_PNG);
        expect(slide.elements.at(-1)).toMatchObject({ mediaName: deck.media[0].name, objectFit: 'fill' });
    });
});
