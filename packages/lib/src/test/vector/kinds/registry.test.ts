import { describe, expect, test } from 'bun:test';
import { getElementBounds } from '../../../vector/geometry';
import {
    CREATION_TOOL_TYPES,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    isVectorElementType,
    VECTOR_STYLE_DEFAULTS,
} from '../../../vector/kinds';
import {
    BASE_ELEMENT_FIELDS,
    DEFAULT_ELEMENT_PROPS,
    isBindable,
    type VectorElementBase,
    type VectorRichTextElement,
} from '../../../vector/types';
import { richtext, shape } from '../element-factories';

const TYPES = ['rectangle', 'diamond', 'ellipse', 'image', 'richtext', 'freedraw', 'line', 'arrow'] as const;

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

    test('every kind defaults to a complete element when merged with the base', () => {
        for (const kind of Object.values(ELEMENT_KINDS)) {
            const defaults = kind.defaults(VECTOR_STYLE_DEFAULTS);
            expect(Object.keys(defaults).sort()).toEqual([...kind.fields].sort());
        }
    });

    test('a kind ignores an element of another kind instead of throwing', () => {
        const rect = shape({ id: 'r', type: 'rectangle' });
        expect(ELEMENT_KINDS.arrow.searchText(rect)).toBe('');
        expect(ELEMENT_KINDS.arrow.hitTest(rect, { x: 0, y: 0 }, 8)).toBe(false);
        expect(ELEMENT_KINDS.arrow.outline(rect, 0)).toEqual({ kind: 'polyline', points: [] });
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

    test('isBindable and capabilities.bindable name the same kinds', () => {
        // isBindable stays in types.ts (moving it into kinds/ would make types → kinds an eval cycle), so
        // it is a second list of one fact — pinned here in both directions.
        for (const type of ['rectangle', 'diamond', 'ellipse'] as const) {
            expect(isBindable(shape({ id: 'b', type }))).toBe(ELEMENT_KINDS[type].capabilities.bindable);
            expect(ELEMENT_KINDS[type].capabilities.bindable).toBe(true);
        }
        expect(isBindable(richtext({ id: 't' }))).toBe(ELEMENT_KINDS.richtext.capabilities.bindable);
        expect(TYPES.filter((type) => ELEMENT_KINDS[type].capabilities.bindable)).toEqual([
            'rectangle',
            'diamond',
            'ellipse',
        ]);
    });

    test('the elbow router reads each silhouette off the kind, never off the type', () => {
        expect(ELEMENT_KINDS.rectangle.capabilities.silhouette).toBe('box');
        expect(ELEMENT_KINDS.diamond.capabilities.silhouette).toBe('diamond');
        expect(ELEMENT_KINDS.ellipse.capabilities.silhouette).toBe('ellipse');
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

    test('capabilities answer the questions the panel used to ask by type', () => {
        expect(ELEMENT_KINDS.ellipse.capabilities.corners).toBe(false);
        expect(ELEMENT_KINDS.rectangle.capabilities.bindable).toBe(true);
        expect(ELEMENT_KINDS.arrow.capabilities.bindable).toBe(false);
        expect(ELEMENT_KINDS.richtext.capabilities.roughness).toBe(false);
        expect(ELEMENT_KINDS.image.capabilities.fill).toBe(false);
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

    test('searchText covers rich text and arrow labels only, tags stripped', () => {
        expect(
            ELEMENT_KINDS.richtext.searchText(richtext({ id: 'x', html: '<p>hello <strong>world</strong></p>' })),
        ).toBe('hello world');
        expect(ELEMENT_KINDS.rectangle.searchText(shape({ id: 'r', type: 'rectangle' }))).toBe('');
    });
});
