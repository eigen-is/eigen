import { describe, expect, test } from 'bun:test';
import { getElementBounds } from '../../../vector/geometry';
import {
    CREATION_TOOL_TYPES,
    ELEMENT_FIELDS,
    ELEMENT_KINDS,
    TOOL_ORDER,
    VECTOR_STYLE_DEFAULTS,
} from '../../../vector/kinds';
import { BASE_ELEMENT_FIELDS, isVectorElementType } from '../../../vector/types';
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
        expect(TOOL_ORDER.filter((type) => ELEMENT_KINDS[type].capabilities.creation !== 'none')).toEqual([
            ...CREATION_TOOL_TYPES,
        ]);
        expect(Object.keys(ELEMENT_KINDS).sort()).toEqual([...TOOL_ORDER].sort());
        expect(ELEMENT_KINDS.image.capabilities.creation).toBe('none');
    });

    test('capabilities answer the questions the panel used to ask by type', () => {
        expect(ELEMENT_KINDS.ellipse.capabilities.corners).toBe(false);
        expect(ELEMENT_KINDS.rectangle.capabilities.bindable).toBe(true);
        expect(ELEMENT_KINDS.arrow.capabilities.bindable).toBe(false);
        expect(ELEMENT_KINDS.richtext.capabilities.typography).toBe(true);
        expect(ELEMENT_KINDS.image.capabilities.objectFit).toBe(true);
    });

    test('searchText covers rich text and arrow labels only, tags stripped', () => {
        expect(
            ELEMENT_KINDS.richtext.searchText(richtext({ id: 'x', html: '<p>hello <strong>world</strong></p>' })),
        ).toBe('hello world');
        expect(ELEMENT_KINDS.rectangle.searchText(shape({ id: 'r', type: 'rectangle' }))).toBe('');
    });
});
