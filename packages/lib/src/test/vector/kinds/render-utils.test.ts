import { describe, expect, test } from 'bun:test';
import { solidFill } from '../../../vector/fill';
import { serializePoints } from '../../../vector/geometry';
import { svgId } from '../../../vector/kinds/render-utils';
import { diamondOutline, ellipseOutline, outlinePath, rectOutline, scaleNormalizedPath } from '../../../vector/outline';
import { elementToSvg } from '../../../vector/scene-to-svg';
import { FILL_STYLES, type FillStyle, type VectorElement } from '../../../vector/types';
import { ellipse, linear, path, pie, richtext, shape } from '../element-factories';

const FILL = '#ff0000';
const STROKE = '#0000ff';
const BOX = { x: 0, y: 0, width: 13, height: 13 };
const TRIANGLE = 'M 0 0 L 1 1 L 0 1 Z';
const HATCHES = FILL_STYLES.filter((style) => style !== 'solid');

// A legend swatch's size, where roughjs's zigzag overshoots its square by about 3px; the expected clip for a shape
// whose outline the test can name, else null.
function elementsIn(style: FillStyle): { el: VectorElement; d: string | null }[] {
    const paint = { ...BOX, fill: solidFill(FILL, style), strokeColor: STROKE, strokeWidth: 2 };
    const loop = serializePoints([
        { x: 0, y: 0 },
        { x: 13, y: 0 },
        { x: 13, y: 13 },
        { x: 0, y: 0 },
    ]);
    return [
        {
            el: shape({ id: 'r1', type: 'rectangle', corners: 'straight', ...paint }),
            d: outlinePath(rectOutline(BOX, 0, 0)),
        },
        { el: shape({ id: 'r2', type: 'rectangle', corners: 'curved', ...paint, width: 60, height: 40 }), d: null },
        {
            el: shape({ id: 'd1', type: 'diamond', corners: 'straight', ...paint }),
            d: outlinePath(diamondOutline(BOX, 0, 0)),
        },
        { el: ellipse({ id: 'e1', ...paint }), d: outlinePath(ellipseOutline(BOX, 0)) },
        { el: pie({ id: 'p1', ...paint, width: 60, height: 60, startAngle: 0, sweepAngle: 40 }), d: null },
        { el: path({ id: 'pa', ...paint, path: TRIANGLE, closed: true }), d: scaleNormalizedPath(TRIANGLE, 13, 13) },
        { el: richtext({ id: 't1', corners: 'straight', ...paint }), d: outlinePath(rectOutline(BOX, 0, 0)) },
        { el: linear({ id: 'l1', type: 'line', roundness: 'sharp', ...paint, points: loop }), d: null },
        { el: linear({ id: 'l2', type: 'line', roundness: 'round', ...paint, points: loop }), d: null },
        { el: linear({ id: 'f1', type: 'freedraw', ...paint, points: loop }), d: null },
    ];
}

// The hatch's clip and the svg split into what the clip holds and what it doesn't.
function clipOf(svg: string, id: string): { d: string; inside: string; outside: string } {
    const clip = new RegExp(`<clipPath id="${id}"><path d="([^"]*)"/></clipPath>`).exec(svg);
    const group = new RegExp(`<g clip-path="url\\(#${id}\\)">(.*?)</g>`).exec(svg);
    if (!clip || !group) throw new Error(`no clip ${id} in ${svg}`);
    return { d: clip[1], inside: group[1], outside: svg.replace(clip[0], '').replace(group[0], '') };
}

describe('a hatched fill is clipped to its shape', () => {
    for (const style of HATCHES) {
        test(`${style}: the hatch draws inside a clip of the outline, the outline outside it`, () => {
            for (const { el, d } of elementsIn(style)) {
                const svg = elementToSvg(el);
                const clip = clipOf(svg, svgId('hatch', el.id));
                if (d !== null) expect([el.id, clip.d]).toEqual([el.id, d]);
                expect([el.id, clip.d]).not.toEqual([el.id, '']);
                expect([el.id, clip.inside.includes(`stroke="${FILL}"`)]).toEqual([el.id, true]);
                expect([el.id, clip.inside.includes(STROKE)]).toEqual([el.id, false]);
                expect([el.id, clip.outside.includes(FILL)]).toEqual([el.id, false]);
                // freedraw's stroke is perfect-freehand ink, filled in the stroke color
                expect([el.id, clip.outside.includes(STROKE)]).toEqual([el.id, true]);
            }
        });
    }

    test('a solid fill draws as before, with no clip', () => {
        for (const { el } of elementsIn('solid'))
            expect([el.id, elementToSvg(el).includes('clipPath')]).toEqual([el.id, false]);
    });

    test('a hatch with no paint draws no clip', () => {
        const el = shape({ id: 'r1', type: 'rectangle', fill: solidFill('transparent', 'zigzag') });
        expect(elementToSvg(el)).not.toContain('clipPath');
    });
});
