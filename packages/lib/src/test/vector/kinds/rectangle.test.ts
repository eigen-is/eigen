import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { serializeFill, solidFill } from '../../../vector/fill';
import {
    ELEMENT_KINDS,
    isTextBox,
    richTextCssText,
    SLIDES_STYLE_DEFAULTS,
    textBoxFitHeight,
} from '../../../vector/kinds';
import { readElementFromFields, readVectorFromDoc } from '../../../vector/read-vector';
import type { VectorRectangleElement } from '../../../vector/types';
import { writeElementInDoc } from '../../../vector/write-vector';
import { shape, textBox } from '../element-factories';

// A stored record as a peer writes it.
function stored(fields: Record<string, unknown>): Map<string, unknown> {
    return new Map(Object.entries({ id: 'el', x: 0, y: 0, width: 100, height: 40, ...fields }));
}

describe('the text box is a rectangle that fits its text', () => {
    test('the registry has no rich-text kind, and a stored one is dropped', () => {
        expect(Object.keys(ELEMENT_KINDS)).not.toContain('richtext');
        expect(readElementFromFields(stored({ type: 'richtext', html: '<p>old</p>' }))).toBeNull();
    });

    test('a rectangle stores autoFit, read as false unless it is true', () => {
        expect(ELEMENT_KINDS.rectangle.fields).toContain('autoFit');
        const read = (autoFit: unknown) => {
            const el = readElementFromFields(stored({ type: 'rectangle', autoFit }));
            return el?.type === 'rectangle' && el.autoFit;
        };
        expect(read(true)).toBe(true);
        expect(read(undefined)).toBe(false);
        expect(read('yes')).toBe(false);
    });

    test('isTextBox answers for a rectangle with autoFit only', () => {
        expect(isTextBox(textBox({ id: 't' }))).toBe(true);
        expect(isTextBox(shape({ id: 'r', type: 'rectangle', autoFit: false }))).toBe(false);
        expect(isTextBox(shape({ id: 'e', type: 'ellipse' }))).toBe(false);
        expect(isTextBox({ type: 'rectangle', autoFit: true })).toBe(true);
    });

    test('a new autoFit rectangle starts with the text box look, a new rectangle with the shape look', () => {
        const doc = new Y.Doc();
        writeElementInDoc(doc, { type: 'rectangle', autoFit: true }, 'a0', SLIDES_STYLE_DEFAULTS, 'text');
        writeElementInDoc(doc, { type: 'rectangle' }, 'a1', SLIDES_STYLE_DEFAULTS, 'shape');
        const [text, plain] = readVectorFromDoc(doc).elements;
        expect(text).toMatchObject({
            type: 'rectangle',
            autoFit: true,
            textAlign: 'left',
            verticalAlign: 'top',
            padding: 0,
            strokeColor: 'transparent',
        });
        expect(plain).toMatchObject({
            type: 'rectangle',
            autoFit: false,
            textAlign: 'center',
            verticalAlign: 'center',
            padding: 10,
            strokeColor: SLIDES_STYLE_DEFAULTS.strokeColor,
        });
    });

    test('an empty text box still renders its text body, and no backdrop while unpainted', () => {
        const text = shape({ id: 't', type: 'rectangle', autoFit: true, strokeColor: 'transparent', html: '' });
        expect(ELEMENT_KINDS.rectangle.render(text, {})).toMatchObject({ html: '', svg: '' });
        const plain = shape({ id: 'r', type: 'rectangle', autoFit: false, html: '' });
        expect('html' in ELEMENT_KINDS.rectangle.render(plain, {})).toBe(false);
    });

    test('an arrow aims at a text box along its center lines and at a rectangle along its diagonals', () => {
        const box = { id: 'r', type: 'rectangle', width: 200, height: 100 } as const;
        const [vertical] = ELEMENT_KINDS.rectangle.aimLines(shape({ ...box, autoFit: true }));
        expect(vertical).toEqual([
            { x: 100, y: 0 },
            { x: 100, y: 100 },
        ]);
        const [diagonal] = ELEMENT_KINDS.rectangle.aimLines(shape({ ...box, autoFit: false }));
        expect(diagonal[0].x).not.toBe(diagonal[1].x);
    });
});

function renderOf(el: VectorRectangleElement): { style: string; svg: string } {
    const out = ELEMENT_KINDS.rectangle.render(el, {});
    if (!('html' in out)) throw new Error('a text box must render html');
    return out;
}

function styleOf(el: VectorRectangleElement): string {
    return renderOf(el).style;
}

// The roughjs drawable painted behind the text — the box's own fill and border.
function backdropOf(el: VectorRectangleElement): string {
    return renderOf(el).svg;
}

describe('text box paint', () => {
    test('a solid fill is the roughjs fill every shape paints, not a CSS background', () => {
        const el = textBox({ id: 'rt1', fill: solidFill('#ffcc00') });
        expect(backdropOf(el)).toContain('#ffcc00');
        expect(styleOf(el)).not.toContain('background-color');
    });

    test('a gradient fill rides the per-element defs every other kind emits', () => {
        const fill = serializeFill({ type: 'gradient', from: '#000000', to: '#ffffff', angle: 45, style: 'solid' });
        const el = textBox({ id: 'rt1', fill });
        expect(backdropOf(el)).toContain('<defs><linearGradient id="fill-rt1"');
        expect(styleOf(el)).not.toContain('background-image');
    });

    test('a hatch style hatches, which is the capability the box gained', () => {
        const paths = backdropOf(textBox({ id: 'rt1', fill: solidFill('#ffcc00', 'cross-hatch') })).match(/<path/g);
        expect(paths?.length).toBeGreaterThan(1);
    });

    test('stroke fields are the border, drawn as the shapes drawable rather than CSS', () => {
        const el = textBox({ id: 'rt1', strokeColor: '#1e1e1e', strokeWidth: 2, strokeStyle: 'dashed' });
        expect(backdropOf(el)).toContain('<g stroke-linecap="round">');
        expect(styleOf(el)).not.toContain('border:');
    });

    test('corners shape the drawn box, never a CSS border-radius', () => {
        const straight = textBox({ id: 'rt1', corners: 'straight', width: 200, height: 80 });
        const round = textBox({ id: 'rt1', corners: 'round', width: 200, height: 80 });
        expect(backdropOf(round)).not.toBe(backdropOf(straight));
        expect(styleOf(round)).not.toContain('border-radius');
    });

    test('a box with neither fill nor border carries no backdrop at all', () => {
        expect(backdropOf(textBox({ id: 'rt1', strokeColor: 'transparent' }))).toBe('');
        expect(backdropOf(textBox({ id: 'rt1', strokeColor: '#111', strokeWidth: 0 }))).toBe('');
    });

    test('the inset absorbs the border width, and border-box rides along once', () => {
        const style = styleOf(textBox({ id: 'rt1', padding: 8, strokeColor: '#111', strokeWidth: 2 }));
        expect(style).toContain('padding:10px');
        expect(style.match(/box-sizing:border-box/g)?.length).toBe(1);
    });

    test('richTextCssText is exactly the style the renderer emits', () => {
        const el = textBox({ id: 'rt1', fill: solidFill('#ffcc00'), padding: 8 });
        expect(styleOf(el)).toBe(richTextCssText(el));
    });

    test('the box still spills its text and keeps its typography', () => {
        const style = styleOf(textBox({ id: 'rt1', fill: solidFill('#ffcc00'), strokeColor: '#111' }));
        expect(style).toContain('overflow:visible');
        expect(style).toContain('font-size:20px');
    });
});

// A fresh text box paints no border (TEXT_BOX_BASE_DEFAULTS), so the fixtures say so explicitly — the
// chrome cases below add one back.
const box = (over: Partial<VectorRectangleElement>) => textBox({ id: 't', strokeColor: 'transparent', ...over });

describe('textBoxFitHeight', () => {
    test('grows to the measured text', () => {
        expect(textBoxFitHeight(box({ height: 40 }), 180)).toBe(180);
    });

    test("never shrinks: the stored height is the user's minimum, not a maximum", () => {
        // A taller box than its text is deliberate — it is what verticalAlign aligns within, and a
        // manual resize is how the user sets it.
        expect(textBoxFitHeight(box({ height: 400 }), 24)).toBeNull();
        expect(textBoxFitHeight(box({ height: 400, verticalAlign: 'center' }), 24)).toBeNull();
    });

    test('a sub-pixel shortfall writes nothing (the loop guard every peer shares)', () => {
        expect(textBoxFitHeight(box({ height: 40 }), 40)).toBeNull();
        expect(textBoxFitHeight(box({ height: 40 }), 39.4)).toBeNull();
        expect(textBoxFitHeight(box({ height: 40 }), 40.2)).toBeNull();
    });

    test('rounds up, so the last line is never clipped by a fraction', () => {
        expect(textBoxFitHeight(box({ height: 40 }), 120.2)).toBe(121);
    });

    test('the inset rides inside the stored border box', () => {
        expect(textBoxFitHeight(box({ height: 40, padding: 20 }), 100)).toBe(140);
    });

    test('a painted border counts twice; a transparent one not at all', () => {
        expect(textBoxFitHeight(box({ height: 40, strokeColor: '#000000', strokeWidth: 4 }), 100)).toBe(108);
        expect(textBoxFitHeight(box({ height: 40, strokeWidth: 4 }), 100)).toBe(100);
    });
});
