import { describe, expect, test } from 'bun:test';
import { richTextCssText, SLIDES_STYLE_DEFAULTS } from '../../../vector/kinds';
import { MAX_HTML_BYTES } from '../../../vector/kinds/read-fields';
import { plainText, readTextual, textRender, textualDefaults } from '../../../vector/kinds/textual';
import type { Textual } from '../../../vector/types';
import { DEFAULT_RICHTEXT_PROPS, DEFAULT_SHAPE_TEXT_PROPS } from '../../../vector/types';
import { shape } from '../element-factories';

const stored = (fields: Record<string, unknown>) => new Map(Object.entries(fields));

describe('textualDefaults', () => {
    test('a new element has no text, the host font, size and color, and the typography of the props given', () => {
        expect(textualDefaults(SLIDES_STYLE_DEFAULTS, DEFAULT_SHAPE_TEXT_PROPS)).toEqual({
            html: '',
            fontFamily: 'Inter',
            fontSize: 48,
            color: '#000000',
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
            textAlign: 'center',
            verticalAlign: 'center',
            letterSpacing: 0,
            lineHeight: 1.2,
            padding: 10,
        });
        expect(textualDefaults(SLIDES_STYLE_DEFAULTS, DEFAULT_RICHTEXT_PROPS)).toMatchObject({
            textAlign: 'left',
            verticalAlign: 'top',
            padding: 0,
        });
    });
});

describe('readTextual', () => {
    test('a record with none of the keys reads the fallbacks of the props given', () => {
        expect(readTextual(stored({}), DEFAULT_SHAPE_TEXT_PROPS)).toEqual({
            html: '',
            fontFamily: 'Excalifont',
            fontSize: 20,
            color: '#1e1e1e',
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
            textAlign: 'center',
            verticalAlign: 'center',
            letterSpacing: 0,
            lineHeight: 1.2,
            padding: 10,
        });
        expect(readTextual(stored({}), DEFAULT_RICHTEXT_PROPS)).toMatchObject({
            textAlign: 'left',
            verticalAlign: 'top',
            padding: 0,
        });
    });

    test('a value outside its vocabulary falls back to the props given, not to the text box', () => {
        const forged = stored({
            fontWeight: 'heavy',
            fontStyle: 'oblique',
            textDecoration: 'blink',
            textAlign: 'middle',
            verticalAlign: 'baseline',
            padding: 'wide',
        });
        expect(readTextual(forged, DEFAULT_SHAPE_TEXT_PROPS)).toMatchObject({
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
            textAlign: 'center',
            verticalAlign: 'center',
            padding: 10,
        });
    });

    test('a stored value in range reads as stored', () => {
        const fields: Textual = {
            html: '<p>hello</p>',
            fontFamily: 'Inter',
            fontSize: 30,
            color: '#0a0b0c',
            fontWeight: 'bold',
            fontStyle: 'italic',
            textDecoration: 'underline',
            textAlign: 'justify',
            verticalAlign: 'bottom',
            letterSpacing: 2,
            lineHeight: 1.5,
            padding: 16,
        };
        expect(readTextual(stored(fields), DEFAULT_SHAPE_TEXT_PROPS)).toEqual(fields);
    });

    test('clamps each field as the text box reader does', () => {
        const hostile = readTextual(
            stored({
                html: `<p>${'x'.repeat(MAX_HTML_BYTES)}</p>`,
                fontFamily: 'Inter;color:red',
                fontSize: 1e9,
                color: 'url(#evil)',
                letterSpacing: 1e9,
                lineHeight: -5,
                padding: 1e9,
            }),
            DEFAULT_SHAPE_TEXT_PROPS,
        );
        expect(new TextEncoder().encode(hostile.html).length).toBeLessThanOrEqual(MAX_HTML_BYTES);
        expect(hostile.fontFamily).toBe('Excalifont');
        expect(hostile.fontSize).toBeLessThan(1e9);
        expect(hostile.color).toBe('#1e1e1e');
        expect(hostile.letterSpacing).toBe(200);
        expect(hostile.lineHeight).toBe(0.5);
        expect(hostile.padding).toBe(200);
        expect(readTextual(stored({ padding: -4 }), DEFAULT_SHAPE_TEXT_PROPS).padding).toBe(0);
    });
});

describe('textRender', () => {
    test('a shape with no text draws exactly its svg, as before shapes held text', () => {
        expect(textRender(shape({ id: 'r', type: 'rectangle' }), '<path/>')).toEqual({ svg: '<path/>' });
    });

    test('a shape with text draws its html over its svg, styled by richTextCssText', () => {
        const el = shape({ id: 'r', type: 'rectangle', html: '<p>hi</p>' });
        expect(textRender(el, '<path/>')).toEqual({ html: '<p>hi</p>', style: richTextCssText(el), svg: '<path/>' });
    });
});

describe('plainText', () => {
    test('is the text without its tags and outer space', () => {
        expect(plainText(shape({ id: 'r', type: 'rectangle', html: '<p> Total <strong>budget</strong> </p>' }))).toBe(
            'Total budget',
        );
        expect(plainText(shape({ id: 'r', type: 'rectangle', html: '<p></p>' }))).toBe('');
    });
});
