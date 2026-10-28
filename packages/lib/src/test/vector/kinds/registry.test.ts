import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { solidFill } from '../../../vector/fill';
import { getElementBounds } from '../../../vector/geometry';
import {
    baseDefaultsFor,
    CREATION_TOOL_TYPES,
    capabilitiesOf,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    isBindable,
    isTextual,
    isVectorElementType,
    VECTOR_STYLE_DEFAULTS,
} from '../../../vector/kinds';
import { EMPTY_OUTLINE } from '../../../vector/outline';
import { serializePoints } from '../../../vector/points';
import { readElementFromFields } from '../../../vector/read-vector';
import type {
    Textual,
    VectorElement,
    VectorElementBase,
    VectorRichTextElement,
    VectorTextualElement,
} from '../../../vector/types';
import { BASE_ELEMENT_FIELDS, DEFAULT_ELEMENT_PROPS } from '../../../vector/types';
import { chart, ellipse, image, linear, path, pie, richtext, shape } from '../element-factories';

const TYPES = [
    'rectangle',
    'diamond',
    'ellipse',
    'pie',
    'path',
    'chart',
    'image',
    'richtext',
    'freedraw',
    'line',
    'arrow',
] as const;

describe('ELEMENT_KINDS', () => {
    test('every element type has exactly one entry, keyed by its own type', () => {
        expect(Object.keys(ELEMENT_KINDS).sort()).toEqual([...TYPES].sort());
        for (const [key, kind] of Object.entries(ELEMENT_KINDS)) {
            expect(key).toBe(kind.type);
            expect(isVectorElementType(key)).toBe(true);
        }
    });

    test('ELEMENT_FIELDS is the base fields plus every kind field, with no duplicates', () => {
        expect(ELEMENT_FIELDS.slice(0, BASE_ELEMENT_FIELDS.length)).toEqual([...BASE_ELEMENT_FIELDS]);
        expect(new Set(ELEMENT_FIELDS).size).toBe(ELEMENT_FIELDS.length);
        for (const kind of Object.values(ELEMENT_KINDS)) {
            for (const field of kind.fields) expect(ELEMENT_FIELDS).toContain(field);
        }
    });

    test('roughness and seed are base fields, so the reader answers for every kind', () => {
        expect(BASE_ELEMENT_FIELDS).toContain('roughness');
        expect(BASE_ELEMENT_FIELDS).toContain('seed');
        const bare = new Y.Doc().getMap<unknown>('bare');
        bare.set('id', 'i');
        bare.set('type', 'image');
        const el = readElementFromFields(bare);
        expect(el?.roughness).toBe(0);
        expect(el?.seed).toBe(1);
    });

    test('a kind ignores an element of another kind instead of throwing', () => {
        const rect = shape({ id: 'r', type: 'rectangle' });
        expect(ELEMENT_KINDS.arrow.searchText(rect)).toBe('');
        expect(ELEMENT_KINDS.arrow.hitTest(rect, { x: 0, y: 0 }, 8)).toBe(false);
        expect(ELEMENT_KINDS.arrow.outline(rect, 0)).toEqual(EMPTY_OUTLINE);
        // the fallback bounds are still the element's own box, so nothing disappears from a viewBox
        expect(ELEMENT_KINDS.arrow.bounds(rect)).toEqual(getElementBounds(rect));
        expect(ELEMENT_KINDS.arrow.render(rect, {})).toEqual({ svg: '' });
    });

    test('the creation tools are exactly the kinds that can be drawn, in toolbar order', () => {
        expect(CREATION_TOOL_TYPES).toEqual([
            'rectangle',
            'diamond',
            'ellipse',
            'arrow',
            'line',
            'freedraw',
            'richtext',
        ]);
        // the hand-written tuple can never drift from the capabilities
        const drawable = Object.entries(ELEMENT_KINDS)
            .filter(([, kind]) => kind.capabilities.creation !== 'none')
            .map(([type]) => type);
        expect(drawable.sort()).toEqual([...CREATION_TOOL_TYPES].sort());
        expect(ELEMENT_KINDS.image.capabilities.creation).toBe('none');
    });

    test('the bindable kinds are the closed shapes, the pie slice, the path, the chart and the two DOM boxes', () => {
        // isBindable READS this table, so the only thing worth pinning is which kinds set the capability:
        // the arrow endpoint docks on anything with a real outline, never on a stroke.
        expect(TYPES.filter((type) => ELEMENT_KINDS[type].capabilities.bindable)).toEqual([
            'rectangle',
            'diamond',
            'ellipse',
            'pie',
            'path',
            'chart',
            'image',
            'richtext',
        ]);
        expect(isBindable(pie({ id: 'p' }))).toBe(true);
        // an open path has no edge to dock to (capabilitiesOf)
        expect(isBindable(path({ id: 'c' }))).toBe(true);
        expect(isBindable(path({ id: 'o', path: 'M 0 0 L 1 1', closed: false }))).toBe(false);
        expect(isBindable(chart({ id: 'c' }))).toBe(true);
        expect(isBindable(richtext({ id: 't' }))).toBe(true);
        expect(isBindable(shape({ id: 'r', type: 'rectangle' }))).toBe(true);
        expect(isBindable(linear({ id: 'l', type: 'line' }))).toBe(false);
    });

    test('the text kinds are the rich-text box and the closed shapes, pinned against VectorTextualElement', () => {
        // A Record over the union's types: a type the union gains or loses fails to compile here, and the
        // capability list below must then match it.
        const textual: Record<VectorTextualElement['type'], true> = {
            rectangle: true,
            diamond: true,
            ellipse: true,
            pie: true,
            path: true,
            richtext: true,
        };
        expect(TYPES.filter((type) => ELEMENT_KINDS[type].capabilities.text)).toEqual(
            TYPES.filter((type) => Object.hasOwn(textual, type)),
        );
        for (const el of [
            shape({ id: 'r', type: 'rectangle' }),
            shape({ id: 'd', type: 'diamond' }),
            ellipse({ id: 'e' }),
            pie({ id: 'p' }),
            path({ id: 'c' }),
            richtext({ id: 't' }),
        ]) {
            expect([el.type, isTextual(el)]).toEqual([el.type, true]);
        }
        for (const el of [chart({ id: 'c' }), image({ id: 'i' }), linear({ id: 'l', type: 'line' })]) {
            expect([el.type, isTextual(el)]).toEqual([el.type, false]);
        }
    });

    test('an open path is a line and holds no text; a closed one does', () => {
        expect(capabilitiesOf(path({ id: 'c' })).text).toBe(true);
        expect(capabilitiesOf(path({ id: 'o', path: 'M 0 0 L 1 1', closed: false })).text).toBe(false);
        expect(isTextual(path({ id: 'o', path: 'M 0 0 L 1 1', closed: false }))).toBe(false);
    });

    test('every text kind stores every Textual key', () => {
        // A Record over Textual's keys, so a key the block gains must be listed here too.
        const keys: Record<keyof Textual, true> = {
            html: true,
            fontFamily: true,
            fontSize: true,
            fontWeight: true,
            fontStyle: true,
            textDecoration: true,
            textAlign: true,
            verticalAlign: true,
            color: true,
            letterSpacing: true,
            lineHeight: true,
            padding: true,
        };
        for (const type of ['rectangle', 'diamond', 'ellipse', 'pie', 'path', 'richtext'] as const) {
            for (const key of Object.keys(keys))
                expect([type, ELEMENT_KINDS[type].fields]).toEqual([type, expect.arrayContaining([key])]);
        }
    });

    test('every bindable kind answers the docking questions', () => {
        // Docking needs an outline, four anchors and two aim lines. The DOM boxes declare no anchorPoints
        // or aimLines of their own, so this is what pins defineKind's box defaults reaching them.
        const bindables: VectorElement[] = [
            shape({ id: 'r', type: 'rectangle' }),
            shape({ id: 'd', type: 'diamond' }),
            ellipse({ id: 'e' }),
            pie({ id: 'p' }),
            path({ id: 'pa' }),
            chart({ id: 'c' }),
            image({ id: 'i' }),
            richtext({ id: 't' }),
        ];
        expect(bindables.map((el) => el.type)).toEqual(
            TYPES.filter((type) => ELEMENT_KINDS[type].capabilities.bindable),
        );
        for (const el of bindables) {
            const kind = ELEMENT_KINDS[el.type];
            expect(isBindable(el)).toBe(true);
            expect(kind.outline(el, 0)).not.toEqual(EMPTY_OUTLINE);
            expect(kind.anchorPoints(el)).toHaveLength(4);
            expect(kind.aimLines(el)).toHaveLength(2);
        }
    });

    test('the elbow router reads each silhouette off the kind, never off the type', () => {
        expect(ELEMENT_KINDS.rectangle.capabilities.silhouette).toBe('box');
        expect(ELEMENT_KINDS.diamond.capabilities.silhouette).toBe('diamond');
        expect(ELEMENT_KINDS.ellipse.capabilities.silhouette).toBe('ellipse');
        expect(ELEMENT_KINDS.pie.capabilities.silhouette).toBe('ellipse');
        expect(ELEMENT_KINDS.path.capabilities.silhouette).toBe('box');
        expect(ELEMENT_KINDS.chart.capabilities.silhouette).toBe('box');
    });

    test('ELEMENT_FIELDS stores every kind the registry holds, a kind off the toolbar included', () => {
        expect(ELEMENT_KINDS.pie.capabilities.creation).toBe('none');
        expect(ELEMENT_FIELDS).toContain('startAngle');
        expect(ELEMENT_FIELDS).toContain('sweepAngle');
        expect(ELEMENT_KINDS.chart.capabilities.creation).toBe('none');
        expect(ELEMENT_FIELDS).toContain('specChart');
    });

    test('the dock anchors are the right/bottom/left/top points, whatever the kind derives them from', () => {
        const anchors = [
            { x: 100, y: 30 },
            { x: 50, y: 60 },
            { x: 0, y: 30 },
            { x: 50, y: 0 },
        ];
        // the rect's edge midpoints and the diamond's tips are the same four points
        for (const type of ['rectangle', 'ellipse', 'diamond'] as const) {
            expect(ELEMENT_KINDS[type].anchorPoints(shape({ id: 's', type }))).toEqual(anchors);
        }
    });

    test('a rectangle too small to shrink aims along its whole diagonal', () => {
        // 20x20: the diagonal is 28.3px, shorter than the 15px pulled in at each end, so shrinking it
        // would flip it end for end and aim the arrow backwards through the shape.
        expect(ELEMENT_KINDS.rectangle.aimLines(shape({ id: 'r', type: 'rectangle', width: 20, height: 20 }))).toEqual([
            [
                { x: 0, y: 0 },
                { x: 20, y: 20 },
            ],
            [
                { x: 20, y: 0 },
                { x: 0, y: 20 },
            ],
        ]);
    });

    test('only the rectangle aims along its corner diagonals; the others use the centre lines', () => {
        // 100×60 shrunk by 15 at each end along the (100, 60) diagonal
        expect(ELEMENT_KINDS.rectangle.aimLines(shape({ id: 'r', type: 'rectangle' }))[0][0].x).toBeCloseTo(
            (15 * 100) / Math.hypot(100, 60),
            9,
        );
        for (const type of ['ellipse', 'diamond'] as const) {
            expect(ELEMENT_KINDS[type].aimLines(shape({ id: 's', type }))).toEqual([
                [
                    { x: 50, y: 0 },
                    { x: 50, y: 60 },
                ],
                [
                    { x: 0, y: 30 },
                    { x: 100, y: 30 },
                ],
            ]);
        }
    });

    test('the Edges row belongs to the two drawn polylines, not to a freehand stroke', () => {
        // freedraw stores a roundness too, so the capability is what separates "has the field" from
        // "the user picks it".
        expect(TYPES.filter((type) => ELEMENT_KINDS[type].capabilities.edges)).toEqual(['line', 'arrow']);
    });

    test('capabilities answer the questions the panel used to ask by type', () => {
        expect(ELEMENT_KINDS.ellipse.capabilities.corners).toBe(false);
        expect(ELEMENT_KINDS.rectangle.capabilities.bindable).toBe(true);
        expect(ELEMENT_KINDS.arrow.capabilities.bindable).toBe(false);
        expect(ELEMENT_KINDS.image.capabilities.fill).toBe(false);
    });

    test('no kind answers a roughness capability — every kind is drawn by roughjs', () => {
        for (const kind of Object.values(ELEMENT_KINDS)) {
            expect(Object.keys(kind.capabilities)).not.toContain('roughness');
        }
    });

    test('rich text carries a padding field, unpadded by default', () => {
        expect(ELEMENT_KINDS.richtext.fields).toContain('padding');
        expect(ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS).padding).toBe(0);
    });

    test('a kind defaults to its OWN element, so a consumer spreads them instead of re-listing fields', () => {
        const base: VectorElementBase = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 't',
            type: 'richtext',
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            angle: 0,
            index: 'a0',
        };
        // The annotation is the pin: `defaults` typed as Record<string, unknown> would leave every kind
        // field missing here, and a typo'd override would not be caught.
        const el: VectorRichTextElement = {
            ...base,
            ...ELEMENT_KINDS.richtext.defaults(VECTOR_STYLE_DEFAULTS),
            type: 'richtext',
            html: '<p>hi</p>',
            textAlign: 'center',
        };
        expect(Object.keys(el).sort()).toEqual([...BASE_ELEMENT_FIELDS, ...ELEMENT_KINDS.richtext.fields].sort());
        expect(el.textAlign).toBe('center');
        expect(el.lineHeight).toBe(1.2);
    });

    test('the shape factories carry the text block, so a fixture is exactly the stored field set', () => {
        for (const el of [
            shape({ id: 'r', type: 'rectangle' }),
            shape({ id: 'd', type: 'diamond' }),
            ellipse({ id: 'e' }),
            pie({ id: 'p' }),
            path({ id: 'c' }),
        ]) {
            expect([el.type, Object.keys(el).sort()]).toEqual([
                el.type,
                [...BASE_ELEMENT_FIELDS, ...ELEMENT_KINDS[el.type].fields].sort(),
            ]);
            expect(el).toMatchObject({ html: '', textAlign: 'center', verticalAlign: 'center', padding: 10 });
        }
    });

    test('searchText covers the text kinds and arrow labels, tags stripped', () => {
        expect(
            ELEMENT_KINDS.richtext.searchText(richtext({ id: 'x', html: '<p>hello <strong>world</strong></p>' })),
        ).toBe('hello world');
        expect(ELEMENT_KINDS.rectangle.searchText(shape({ id: 'r', type: 'rectangle' }))).toBe('');
        for (const el of [
            shape({ id: 'r', type: 'rectangle', html: '<p>in <em>shape</em></p>' }),
            shape({ id: 'd', type: 'diamond', html: '<p>in <em>shape</em></p>' }),
            ellipse({ id: 'e', html: '<p>in <em>shape</em></p>' }),
            pie({ id: 'p', html: '<p>in <em>shape</em></p>' }),
            path({ id: 'c', html: '<p>in <em>shape</em></p>' }),
        ]) {
            expect([el.type, ELEMENT_KINDS[el.type].searchText(el)]).toEqual([el.type, 'in shape']);
        }
    });

    test('a shape with text embeds its face in an SVG download; one without embeds none', () => {
        const el = shape({ id: 'r', type: 'rectangle', html: '<p>hi</p>', fontFamily: 'Inter' });
        expect(ELEMENT_KINDS.rectangle.fontFamilies(el)).toEqual(['Inter']);
        expect(ELEMENT_KINDS.rectangle.fontFamilies(shape({ id: 'r', type: 'rectangle' }))).toEqual([]);
    });
});

describe('capabilities agree with the stored fields', () => {
    test('fill, corners and text are derivable from each kind own fields', () => {
        for (const [type, kind] of Object.entries(ELEMENT_KINDS)) {
            const fields = kind.fields;
            expect([type, kind.capabilities.fill]).toEqual([type, fields.includes('fill')]);
            expect([type, kind.capabilities.corners]).toEqual([type, fields.includes('corners')]);
            expect([type, kind.capabilities.text]).toEqual([type, fields.includes('html')]);
            // roughness and seed are the base's, so no kind may declare them again.
            expect([type, fields.includes('roughness') || fields.includes('seed')]).toEqual([type, false]);
        }
    });

    test('only the kinds roughjs hatches honour the fill style half', () => {
        // The hatch style rides the stored `fill`, so it is NOT derivable from the field list: an image
        // carries no fill at all and an arrow's is its arrowheads'.
        const hatched = Object.entries(ELEMENT_KINDS)
            .filter(([, kind]) => kind.capabilities.fillStyle)
            .map(([type]) => type);
        expect(hatched.sort()).toEqual([
            'chart',
            'diamond',
            'ellipse',
            'freedraw',
            'line',
            'path',
            'pie',
            'rectangle',
            'richtext',
        ]);
    });

    test('every kind but freedraw honours the stroke dash style', () => {
        // A freehand stroke is a filled outline rather than a drawn line, so dashes mean nothing to it —
        // which is why the panel's Style row asks the capability instead of the kind's name.
        const dashable = Object.entries(ELEMENT_KINDS)
            .filter(([, kind]) => kind.capabilities.strokeStyle)
            .map(([type]) => type);
        expect(dashable.sort()).toEqual([
            'arrow',
            'chart',
            'diamond',
            'ellipse',
            'image',
            'line',
            'path',
            'pie',
            'rectangle',
            'richtext',
        ]);
    });

    test('the stroke is optional exactly on the kinds that still have a body without it', () => {
        // NOT derivable from `fill`: a line and a freedraw stroke fill when their path closes (fill:
        // true) yet ARE their stroke, and an image's body is pixels rather than a Fill (fill: false). A
        // path's answer is its kind's for a closed one; an open one takes it back (capabilitiesOf).
        const optional = Object.entries(ELEMENT_KINDS)
            .filter(([, kind]) => kind.capabilities.strokeOptional)
            .map(([type]) => type);
        expect(optional.sort()).toEqual([
            'chart',
            'diamond',
            'ellipse',
            'image',
            'path',
            'pie',
            'rectangle',
            'richtext',
        ]);
    });

    test('only a bindable kind declares a silhouette', () => {
        // The elbow router's heading heuristics are the one reader, and they only ever see a shape an
        // arrow can dock to; a linear kind answering 'box' would be an answer nobody asks for.
        for (const [type, kind] of Object.entries(ELEMENT_KINDS)) {
            expect([type, kind.capabilities.silhouette !== undefined]).toEqual([type, kind.capabilities.bindable]);
        }
    });
});

describe('capabilitiesOf', () => {
    // The renderers paint a linear fill only when the path loops (freedraw's render arm and
    // linearRoughOptions), so the capability has to be answered per ELEMENT, not per kind.
    const open = serializePoints([
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
    ]);
    const closed = serializePoints([
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 0 },
    ]);

    test('an open freedraw or line has no fill to offer; a closed one does', () => {
        for (const type of ['freedraw', 'line'] as const) {
            expect([type, capabilitiesOf(linear({ id: 'o', type, points: open })).fill]).toEqual([type, false]);
            expect([type, capabilitiesOf(linear({ id: 'c', type, points: closed })).fill]).toEqual([type, true]);
        }
    });

    test('a kind without geometry-dependent answers gets its static table', () => {
        const rect = shape({ id: 'r', type: 'rectangle' });
        expect(capabilitiesOf(rect)).toEqual(ELEMENT_KINDS.rectangle.capabilities);
        expect(capabilitiesOf(richtext({ id: 't' }))).toEqual(ELEMENT_KINDS.richtext.capabilities);
    });

    test('the capability and the renderer agree on which strokes paint a fill', () => {
        for (const type of ['freedraw', 'line'] as const) {
            for (const points of [open, closed]) {
                const el = linear({ id: 'l', type, points, fill: solidFill('#ff0000') });
                const output = ELEMENT_KINDS[type].render(el, {});
                const painted = !('html' in output) && output.svg.includes('#ff0000');
                expect([type, points === closed, painted]).toEqual([type, points === closed, capabilitiesOf(el).fill]);
            }
        }
    });
});

describe('baseDefaults', () => {
    test('a new rich text box or image paints no border until a stroke colour is picked', () => {
        for (const type of ['richtext', 'image'] as const) {
            expect([type, baseDefaultsFor(type, VECTOR_STYLE_DEFAULTS).strokeColor]).toEqual([type, 'transparent']);
        }
        const out = ELEMENT_KINDS.richtext.render(richtext({ id: 'rt', ...ELEMENT_KINDS.richtext.baseDefaults }), {});
        expect('html' in out && out.style).not.toContain('border:');
    });

    test('a kind that draws its stroke keeps the shared base defaults', () => {
        for (const type of [
            'rectangle',
            'diamond',
            'ellipse',
            'pie',
            'path',
            'chart',
            'freedraw',
            'line',
            'arrow',
        ] as const) {
            expect([type, ELEMENT_KINDS[type].baseDefaults]).toEqual([type, {}]);
            expect([type, baseDefaultsFor(type, VECTOR_STYLE_DEFAULTS).strokeColor]).toEqual([
                type,
                DEFAULT_ELEMENT_PROPS.strokeColor,
            ]);
        }
    });

    test('baseDefaultsFor answers what creating the kind would give it — what a panel reset restores', () => {
        // The reset bug: an image whose border was colored must reset to none, not to the shared ink
        // color. The panel reads this, the creation path spreads it, so the two cannot drift.
        for (const [type, kind] of Object.entries(ELEMENT_KINDS)) {
            expect([type, baseDefaultsFor(kind.type, VECTOR_STYLE_DEFAULTS)]).toEqual([
                type,
                { ...DEFAULT_ELEMENT_PROPS, roughness: VECTOR_STYLE_DEFAULTS.roughness, ...kind.baseDefaults },
            ]);
        }
    });
});
