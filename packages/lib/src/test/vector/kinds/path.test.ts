import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { serializeFill, solidFill } from '../../../vector/fill';
import {
    bindingAnchor,
    bindingGap,
    boundEndpoint,
    elementBounds,
    type Point,
    rotatePoint,
    serializePoints,
} from '../../../vector/geometry';
import { capabilitiesOf, ELEMENT_FIELDS, ELEMENT_KINDS, isBindable, storedFields } from '../../../vector/kinds';
import { MAX_PATH_BYTES, MAX_PATH_COMMANDS, parseNormalizedPath } from '../../../vector/kinds/read-fields';
import {
    type OutlineShape,
    outlineContains,
    outlineDistance,
    scaledPathCommands,
    scaleNormalizedPath,
    serializePath,
} from '../../../vector/outline';
import { readVectorFromDoc } from '../../../vector/read-vector';
import { sceneToSvg } from '../../../vector/scene-to-svg';
import { serializeBinding, type VectorPathElement } from '../../../vector/types';
import { arrow, byIdOf, path, scene } from '../element-factories';

const SQUARE = 'M 0 0 L 1 0 L 1 1 L 0 1 Z';
// The square with a hole: the inner ring runs the other way, so nonzero leaves it empty.
const FRAME = `${SQUARE} M 0.25 0.25 L 0.25 0.75 L 0.75 0.75 L 0.75 0.25 Z`;
// The lower-left half of its box: the upper-right half is empty.
const TRIANGLE = 'M 0 0 L 1 1 L 0 1 Z';
const RED = solidFill('#ff0000');

const box = (d: string, over: Partial<VectorPathElement> = {}): VectorPathElement =>
    path({ id: 'p', x: 0, y: 0, width: 200, height: 200, path: d, closed: true, fill: RED, ...over });

const svgOf = (el: VectorPathElement): string => {
    const out = ELEMENT_KINDS.path.render(el, {});
    if ('html' in out) throw new Error('a path draws SVG');
    return out.svg;
};

function docWith(records: Record<string, unknown>[]): Y.Doc {
    const doc = new Y.Doc();
    const elements = doc.getMap('elements');
    for (const record of records) {
        const m = new Y.Map();
        for (const [k, v] of Object.entries(record)) m.set(k, v);
        elements.set(String(record.id), m);
    }
    return doc;
}

const readOne = (record: Record<string, unknown>) =>
    readVectorFromDoc(docWith([{ id: 'p', type: 'path', ...record }])).elements[0];

describe('parseNormalizedPath', () => {
    test('a canonical path reads back as itself', () => {
        expect(parseNormalizedPath(SQUARE)).toBe(SQUARE);
        expect(parseNormalizedPath(FRAME)).toBe(FRAME);
    });

    test('any SVG spelling of the five commands canonicalizes to one string', () => {
        expect(parseNormalizedPath('M0,0L1 0C.5.5 0.25,0.25 1 1Q0.123456 +1 -0 1e-1Z')).toBe(
            'M 0 0 L 1 0 C 0.5 0.5 0.25 0.25 1 1 Q 0.1235 1 0 0.1 Z',
        );
        expect(parseNormalizedPath('  M 0 0  L 1 1  ')).toBe('M 0 0 L 1 1');
        expect(parseNormalizedPath('\tM 0\t0\r\nL 1,1\n')).toBe('M 0 0 L 1 1');
    });

    test('only ASCII space, tab, CR, LF and comma separate, so a valid path is ASCII', () => {
        for (const d of ['M 0 0 L 1 1', 'M 0 0 L 1 1', 'M 0 0 L 1 1 ', '﻿M 0 0 L 1 1', 'M 0\f0']) {
            expect([d, parseNormalizedPath(d)]).toEqual([d, null]);
        }
    });

    test('numbers clamp to [-2, 3], so a coordinate bomb stays near the box', () => {
        expect(parseNormalizedPath('M -5 1e15 L 3.5 -2.5')).toBe('M -2 3 L 3 -2');
    });

    test('a number that is not finite drops the path', () => {
        for (const d of ['M NaN 0', 'M Infinity 0', 'M -Infinity 0', 'M 1e400 0', 'M 0x10 0']) {
            expect([d, parseNormalizedPath(d)]).toEqual([d, null]);
        }
    });

    test('only absolute M, L, C, Q and Z, each with its own count of numbers, starting from a move', () => {
        for (const d of [
            '',
            'M 0 0 H 1',
            'M 0 0 A 1 1 0 0 1 1 1',
            'm 0 0 l 1 1',
            'M 0 0 z',
            'L 1 1',
            'M 0 0 Z L 1 1',
            'M 0',
            'M 0 0 1',
            'M 0 0 C 1 1 1 1',
            'M 0 0,',
            'M 0 0 L 1 1 <script>',
        ]) {
            expect([d, parseNormalizedPath(d)]).toEqual([d, null]);
        }
        expect(parseNormalizedPath(42)).toBeNull();
        expect(parseNormalizedPath(undefined)).toBeNull();
    });

    test('a path is capped at MAX_PATH_COMMANDS commands', () => {
        const within = `M 0 0${' L 1 1'.repeat(MAX_PATH_COMMANDS - 1)}`;
        expect(parseNormalizedPath(within)).toBe(within);
        expect(parseNormalizedPath(`${within} L 1 1`)).toBeNull();
    });

    test('a path is capped at MAX_PATH_BYTES, before and after canonicalizing', () => {
        expect(parseNormalizedPath(`M 0 0${' '.repeat(MAX_PATH_BYTES)}`)).toBeNull();
        // 380 curves in 16,344 bytes, whose canonical spelling takes 19,005: stored, it would not read back.
        const tight = `M0 0${'C-1.2345-1.2345-1.2345-1.2345-1.2345-1.2345'.repeat(380)}`;
        expect(tight.length).toBeLessThanOrEqual(MAX_PATH_BYTES);
        expect(parseNormalizedPath(tight)).toBeNull();
    });
});

describe('path read', () => {
    test('a path element round-trips through the document', () => {
        const el = box(FRAME, { x: 10, y: 20, angle: 30, strokeStyle: 'dashed' });
        const doc = docWith([Object.fromEntries(storedFields(el, ELEMENT_FIELDS))]);
        expect(readVectorFromDoc(doc).elements).toEqual([el]);
    });

    test('the reader stores the canonical spelling', () => {
        expect(readOne({ path: 'M0,0L1,1Z', closed: true })).toMatchObject({ path: 'M 0 0 L 1 1 Z', closed: true });
    });

    test('a malformed path drops the element, as a hostile peer write would be', () => {
        const scene = readVectorFromDoc(
            docWith([
                { id: 'bad', type: 'path', path: 'M 0 0 A 1 1 0 0 1 1 1' },
                { id: 'missing', type: 'path' },
                { id: 'ok', type: 'path', path: SQUARE },
            ]),
        );
        expect(scene.elements.map((el) => el.id)).toEqual(['ok']);
    });

    test('closed is a boolean, and false for a path without a Z', () => {
        expect(readOne({ path: 'M 0 0 L 1 0 L 1 1', closed: true })).toMatchObject({ closed: false });
        expect(readOne({ path: SQUARE, closed: 'yes' })).toMatchObject({ closed: false });
        expect(readOne({ path: SQUARE })).toMatchObject({ closed: false });
        expect(readOne({ path: SQUARE, closed: true })).toMatchObject({ closed: true });
    });
});

describe('scaledPathCommands', () => {
    const d = 'M 0 0 L 1 0.5 C 0.5 0 1 1 0.25 -0.1 Q 2 3 0 1 Z';

    test('scales x by the width and y by the height, commands kept', () => {
        expect(scaleNormalizedPath(d, 200, 100)).toBe('M 0 0 L 200 50 C 100 0 200 100 50 -10 Q 400 300 0 100 Z');
    });

    test('the drawn d is the command list the hit test and the outline read, written out', () => {
        const commands = scaledPathCommands(d, 333, 77);
        expect(commands.map((c) => c.op)).toEqual(['M', 'L', 'C', 'Q', 'Z']);
        expect(commands[1].points).toEqual([{ x: 333, y: 38.5 }]);
        expect(serializePath(commands)).toBe(scaleNormalizedPath(d, 333, 77));
    });

    test('a path at a fractional scale outlines on the rounded points it draws', () => {
        // 0.3333 × 1000.0001 is 333.30003, which the drawn d rounds to 333.3
        const el = box('M 0.3333 0 L 0.3333 1', { closed: false, width: 1000.0001, strokeWidth: 0 });
        expect(ELEMENT_KINDS.path.outline(el, 0)).toEqual({
            kind: 'polyline',
            points: [
                { x: 333.3, y: 0 },
                { x: 333.3, y: 200 },
            ],
        });
    });
});

describe('path render', () => {
    test('a closed path fills under its stroke', () => {
        const svg = svgOf(box(SQUARE, { roughness: 0 }));
        expect(svg).toContain('fill="#ff0000" stroke="none"');
        expect(svg).toContain('stroke="#1e1e1e"');
        expect(svg.indexOf('fill="#ff0000"')).toBeLessThan(svg.indexOf('stroke="#1e1e1e"'));
    });

    test('an open path never fills, whatever its fill says', () => {
        const svg = svgOf(box('M 0 0 L 1 0 L 1 1', { closed: false }));
        expect(svg).not.toContain('#ff0000');
        expect(svg).toContain('stroke="#1e1e1e"');
        const gradient = serializeFill({ type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90, style: 'solid' });
        expect(svgOf(box('M 0 0 L 1 0 L 1 1', { closed: false, fill: gradient }))).not.toContain('linearGradient');
    });

    test('a hatched path draws its fill as strokes', () => {
        const svg = svgOf(box(SQUARE, { fill: solidFill('#ff0000', 'hachure') }));
        expect(svg).toMatch(/stroke="#ff0000" stroke-width="1"/);
        expect(svg).not.toContain('fill="#ff0000"');
    });

    test('a gradient path paints from its own defs', () => {
        const fill = serializeFill({ type: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90, style: 'solid' });
        const svg = svgOf(box(SQUARE, { fill }));
        expect(svg.startsWith('<defs><linearGradient id="fill-p"')).toBe(true);
        expect(svg).toContain('fill="url(#fill-p)"');
    });

    test('the stroke is drawn in the local frame at the box size, dashed when asked', () => {
        const svg = svgOf(box(SQUARE, { roughness: 0, strokeStyle: 'dashed', fill: solidFill('transparent') }));
        expect(svg).toContain('stroke-dasharray="8 10"');
        expect(svg).toMatch(/d="M0 0 [^"]*200 200/);
    });

    test('a switched-off stroke draws the fill alone', () => {
        const svg = svgOf(box(SQUARE, { strokeColor: 'transparent' }));
        expect(svg).toContain('fill="#ff0000"');
        expect(svg).not.toContain('stroke-width="2"');
    });

    test('the jitter is the seed’s: one seed draws one path, another draws another', () => {
        const rough = box(SQUARE, { roughness: 2 });
        expect(svgOf(rough)).toBe(svgOf({ ...rough }));
        expect(svgOf({ ...rough, seed: 2 })).not.toBe(svgOf(rough));
    });

    test('an open path, or a closed one with neither paint, paints nothing', () => {
        const kind = ELEMENT_KINDS.path;
        const bare = { strokeColor: 'transparent' };
        expect(kind.paintsNothing(box(SQUARE, bare))).toBe(false);
        expect(kind.paintsNothing(box('M 0 0 L 1 1', { ...bare, closed: false }))).toBe(true);
        expect(kind.paintsNothing(box(SQUARE, { ...bare, fill: solidFill('transparent') }))).toBe(true);
    });
});

describe('path bounds', () => {
    // a cubic arching from the bottom corners up to half its height above the box
    const arch = (over: Partial<VectorPathElement> = {}) =>
        box('M 0 1 C 0 -1 1 -1 1 1 Z', { width: 100, height: 100, strokeWidth: 2, ...over });

    test('a curve past its box is in the bounds, half the stroke beyond the contour', () => {
        const b = elementBounds(arch());
        expect(b.minX).toBeCloseTo(-1, 6);
        expect(b.maxX).toBeCloseTo(101, 6);
        expect(b.maxY).toBeCloseTo(101, 6);
        expect(b.minY).toBeCloseTo(-51, 0);
    });

    test('a rotated path is bounded where it is drawn', () => {
        const b = elementBounds(arch({ angle: 90 }));
        expect(b.minX).toBeCloseTo(-1, 6);
        expect(b.maxX).toBeCloseTo(151, 0);
        expect(b.minY).toBeCloseTo(-1, 6);
        expect(b.maxY).toBeCloseTo(101, 6);
    });

    test('the SVG export frames the overshoot instead of cropping it', () => {
        const viewBox = sceneToSvg(scene([arch()]))
            .match(/viewBox="([^"]+)"/)?.[1]
            .split(' ')
            .map(Number);
        expect(viewBox?.[1]).toBeLessThan(-51);
    });

    test('a probe outside the bounds misses; inside the overshoot it hits', () => {
        expect(ELEMENT_KINDS.path.hitTest(arch(), { x: 50, y: -40 }, 0)).toBe(true);
        expect(ELEMENT_KINDS.path.hitTest(arch(), { x: 50, y: -60 }, 8)).toBe(false);
        expect(ELEMENT_KINDS.path.hitTest(arch(), { x: 50, y: -55 }, 8)).toBe(true);
    });
});

describe('path hit test', () => {
    const kind = ELEMENT_KINDS.path;

    test('a closed path is hit inside and on its edge, not outside', () => {
        const el = box(TRIANGLE);
        expect(kind.hitTest(el, { x: 40, y: 160 }, 0)).toBe(true);
        expect(kind.hitTest(el, { x: 160, y: 40 }, 0)).toBe(false);
        // just past the hypotenuse
        expect(kind.hitTest(el, { x: 104, y: 96 }, 0)).toBe(false);
        expect(kind.hitTest(el, { x: 104, y: 96 }, 8)).toBe(true);
        expect(kind.hitTest(el, { x: -50, y: 100 }, 8)).toBe(false);
    });

    test('a hole is not the path, but its rim is', () => {
        const el = box(FRAME);
        expect(kind.hitTest(el, { x: 100, y: 100 }, 0)).toBe(false);
        expect(kind.hitTest(el, { x: 25, y: 100 }, 0)).toBe(true);
        expect(kind.hitTest(el, { x: 52, y: 100 }, 8)).toBe(true);
    });

    test('containment is nonzero: two rings wound the same way both fill their overlap', () => {
        const twice = box('M 0 0 L 1 0 L 1 1 L 0 1 Z M 0.25 0.25 L 0.75 0.25 L 0.75 0.75 L 0.25 0.75 Z');
        expect(kind.hitTest(twice, { x: 100, y: 100 }, 0)).toBe(true);
    });

    test('a closed path is hit inside whatever its fill, as a rectangle is; an open one only on its stroke', () => {
        const clear = box(TRIANGLE, { fill: solidFill('transparent') });
        expect(kind.hitTest(clear, { x: 40, y: 160 }, 0)).toBe(true);
        expect(kind.hitTest(clear, { x: 160, y: 40 }, 0)).toBe(false);
        expect(kind.hitTest(clear, { x: 0, y: 100 }, 0)).toBe(true);
        const open = box('M 0 0 L 1 1 L 0 1', { closed: false });
        expect(kind.hitTest(open, { x: 40, y: 160 }, 0)).toBe(false);
        expect(kind.hitTest(open, { x: 100, y: 200 }, 0)).toBe(true);
        // the closing edge an open path never draws
        expect(kind.hitTest(open, { x: 0, y: 100 }, 0)).toBe(false);
    });

    test('a curve is hit where it bends, not along its chord', () => {
        // a cubic bulging up from the bottom edge to y = 50 (three quarters of the way to its control points)
        const arch = box('M 0 1 C 0 0.6667 1 0.6667 1 1 Z');
        expect(kind.hitTest(arch, { x: 100, y: 160 }, 0)).toBe(true);
        expect(kind.hitTest(arch, { x: 100, y: 145 }, 0)).toBe(false);
    });

    test('a rotated path is hit where it is drawn', () => {
        const el = box(TRIANGLE, { angle: 180 });
        expect(kind.hitTest(el, { x: 160, y: 40 }, 0)).toBe(true);
        expect(kind.hitTest(el, { x: 40, y: 160 }, 0)).toBe(false);
    });

    test('a resize scales the drawn path, and the stored one stays as it was', () => {
        const el = box(TRIANGLE);
        const wide = { ...el, width: 400 };
        expect(wide.path).toBe(el.path);
        expect(kind.hitTest(wide, { x: 300, y: 190 }, 0)).toBe(true);
        expect(kind.hitTest(el, { x: 300, y: 190 }, 0)).toBe(false);
        expect(svgOf({ ...wide, roughness: 0 })).toMatch(/d="M0 0 [^"]*400 200/);
    });
});

describe('path outline and docking', () => {
    test('a closed path is bindable and fills; an open one does neither and keeps its stroke', () => {
        expect(isBindable(box(SQUARE))).toBe(true);
        expect(capabilitiesOf(box(SQUARE))).toMatchObject({ fill: true, bindable: true, strokeOptional: true });
        const open = box('M 0 0 L 1 1', { closed: false });
        expect(isBindable(open)).toBe(false);
        expect(capabilitiesOf(open)).toMatchObject({ fill: false, bindable: false, strokeOptional: false });
    });

    test('the outline is the outer contour, every point of it the inflate off the edge', () => {
        const outline = ELEMENT_KINDS.path.outline(box(FRAME, { x: 10, y: 20 }), 5);
        if (outline.kind !== 'polygon') throw new Error('a closed path outlines as a polygon');
        const square: OutlineShape = {
            kind: 'polygon',
            corners: [
                { x: 10, y: 20 },
                { x: 210, y: 20 },
                { x: 210, y: 220 },
                { x: 10, y: 220 },
            ],
        };
        for (const p of outline.corners) expect(outlineDistance(square, p)).toBeCloseTo(5, 9);
        // the hole is the path's own business: an arrow docks on the outside
        expect(outlineContains(outline, { x: 110, y: 120 })).toBe(true);
    });

    test('a sharp tip grows by the inflate, not by its miter', () => {
        // a spike 20 wide and 200 tall: its tip's miter would reach 60 units past it
        const spike = box('M 0 1 L 0.5 0 L 1 1 Z', { width: 20 });
        const outline = ELEMENT_KINDS.path.outline(spike, 6);
        if (outline.kind !== 'polygon') throw new Error('a closed path outlines as a polygon');
        expect(Math.min(...outline.corners.map((p) => p.y))).toBeCloseTo(-6, 9);
    });

    test('a shrunk outline keeps only what lies deeper than the inset', () => {
        const outline = ELEMENT_KINDS.path.outline(box(TRIANGLE), -10);
        expect(outlineContains(outline, { x: 30, y: 170 })).toBe(true);
        expect(outlineContains(outline, { x: 95, y: 105 })).toBe(false);
        expect(outlineContains(outline, { x: 5, y: 100 })).toBe(false);
    });

    test('an open path outlines as its stroke', () => {
        const outline = ELEMENT_KINDS.path.outline(box('M 0 0 L 1 1', { closed: false }), 5);
        expect(outline).toEqual({
            kind: 'polyline',
            points: [
                { x: 0, y: 0 },
                { x: 200, y: 200 },
            ],
        });
    });

    test('the snap anchors sit on the contour, nearest each side midpoint of the box', () => {
        const anchors = ELEMENT_KINDS.path.anchorPoints(box(TRIANGLE));
        expect(anchors).toEqual([
            { x: 150, y: 150 },
            { x: 100, y: 200 },
            { x: 0, y: 100 },
            { x: 50, y: 50 },
        ]);
        const turned = ELEMENT_KINDS.path.anchorPoints(box(TRIANGLE, { angle: 90 }));
        // the triangle turned a quarter about its center: its right angle now sits top-left
        for (const [p, q] of turned.map((p, i) => [p, rotatePoint(anchors[i], { x: 100, y: 100 }, 90)])) {
            expect(p.x).toBeCloseTo(q.x, 9);
            expect(p.y).toBeCloseTo(q.y, 9);
        }
    });

    test('an anchor lands on a curve, not on its chord or its box', () => {
        // a low bump from the bottom corners, its crest halfway up the box
        const top = ELEMENT_KINDS.path.anchorPoints(box('M 0 1 Q 0.5 0 1 1 Z', { width: 400, height: 100 }))[3];
        expect(top.x).toBeCloseTo(200, 6);
        expect(top.y).toBeCloseTo(50, 1);
    });

    // A straight arrow from `from` to an anchor inside the path, bound at its end.
    const dock = (el: VectorPathElement, from: Point, anchor: Point): Point => {
        const x = Math.min(from.x, anchor.x);
        const y = Math.min(from.y, anchor.y);
        const a = arrow({
            id: 'a',
            x,
            y,
            width: Math.abs(anchor.x - from.x),
            height: Math.abs(anchor.y - from.y),
            roundness: 'sharp',
            points: serializePoints([
                { x: from.x - x, y: from.y - y },
                { x: anchor.x - x, y: anchor.y - y },
            ]),
            endBinding: serializeBinding({ elementId: el.id, fixedPoint: bindingAnchor(el, anchor) }),
        });
        return boundEndpoint(a, 'end', el, byIdOf(el));
    };

    test('an arrow docks the binding gap off the contour, not off the box', () => {
        const el = box(TRIANGLE);
        // across the empty half, square onto the hypotenuse
        const end = dock(el, { x: 300, y: -100 }, { x: 50, y: 150 });
        expect((end.x - end.y) / Math.SQRT2).toBeCloseTo(bindingGap(el), 1);
    });

    test('an arrow docks on a curve where it is drawn', () => {
        const arch = box('M 0 1 C 0 0.6667 1 0.6667 1 1 Z');
        const end = dock(arch, { x: 100, y: -200 }, { x: 100, y: 180 });
        expect(end.x).toBeCloseTo(100, 6);
        expect(end.y).toBeCloseTo(150 - bindingGap(arch), 0);
    });

    test('a rotated path docks where it is drawn', () => {
        const el = box(TRIANGLE, { angle: 180 });
        const end = dock(el, { x: -100, y: 300 }, { x: 150, y: 50 });
        const flat = rotatePoint(end, { x: 100, y: 100 }, -180);
        expect((flat.x - flat.y) / Math.SQRT2).toBeCloseTo(bindingGap(el), 1);
    });
});
