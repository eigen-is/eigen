import { describe, expect, test } from 'bun:test';
import { solidFill } from '../../../vector/fill';
import { paintsNothing } from '../../../vector/kinds';
import { image, linear, richtext, shape } from '../element-factories';

// A fresh element is created unpainted but bordered (DEFAULT_ELEMENT_PROPS' ink stroke), so every
// "invisible" fixture below says `strokeColor: 'transparent'` — that IS the case being described.
describe('paintsNothing', () => {
    test('a shape with neither fill nor border puts no ink on the page', () => {
        expect(paintsNothing(shape({ id: 'r', type: 'rectangle', strokeColor: 'transparent' }))).toBe(true);
        expect(paintsNothing(shape({ id: 'd', type: 'diamond', strokeColor: 'transparent' }))).toBe(true);
    });

    test('a fill or a border is enough to be visible', () => {
        expect(paintsNothing(shape({ id: 'r', type: 'rectangle' }))).toBe(false);
        expect(
            paintsNothing(
                shape({ id: 'r', type: 'rectangle', strokeColor: 'transparent', fill: solidFill('#ff0000') }),
            ),
        ).toBe(false);
    });

    test('a zero-width border paints nothing either', () => {
        expect(paintsNothing(shape({ id: 'r', type: 'rectangle', strokeWidth: 0 }))).toBe(true);
    });

    test('an empty rich text box is invisible; one with text is not', () => {
        expect(paintsNothing(richtext({ id: 't', strokeColor: 'transparent', html: '' }))).toBe(true);
        expect(paintsNothing(richtext({ id: 't', strokeColor: 'transparent', html: '<p>  </p>' }))).toBe(true);
        expect(paintsNothing(richtext({ id: 't', strokeColor: 'transparent', html: '<p>hi</p>' }))).toBe(false);
    });

    test('an empty box that paints its own background is visible', () => {
        expect(
            paintsNothing(richtext({ id: 't', strokeColor: 'transparent', html: '', fill: solidFill('#ff0') })),
        ).toBe(false);
    });

    test('an image with no picture is invisible unless it is framed', () => {
        expect(paintsNothing(image({ id: 'i', strokeColor: 'transparent', mediaName: '' }))).toBe(true);
        expect(paintsNothing(image({ id: 'i', mediaName: '' }))).toBe(false);
        expect(paintsNothing(image({ id: 'i', strokeColor: 'transparent', mediaName: 'photo.png' }))).toBe(false);
    });

    test('an ellipse answers the same way its rectangle sibling does', () => {
        expect(paintsNothing(shape({ id: 'e', type: 'ellipse', strokeColor: 'transparent' }))).toBe(true);
    });

    // The three kinds above are the ones a user can leave blank. A linear element IS its stroke, and the
    // panel offers it no None swatch, so the kind declines the question rather than answering it.
    test('a linear element never claims to be invisible', () => {
        expect(paintsNothing(linear({ id: 'l', type: 'line', strokeColor: 'transparent' }))).toBe(false);
    });
});
