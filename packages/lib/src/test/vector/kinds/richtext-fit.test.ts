import { describe, expect, test } from 'bun:test';
import { richTextFitHeight } from '../../../vector/kinds';
import type { VectorRichTextElement } from '../../../vector/types';
import { richtext } from '../element-factories';

// A fresh box paints no border (the kind's baseDefaults), so the fixtures say so explicitly — the
// chrome cases below add one back.
const box = (over: Partial<VectorRichTextElement>) => richtext({ id: 't', strokeColor: 'transparent', ...over });

describe('richTextFitHeight', () => {
    test('grows to the measured text', () => {
        expect(richTextFitHeight(box({ height: 40 }), 180)).toBe(180);
    });

    test("never shrinks: the stored height is the user's minimum, not a maximum", () => {
        // A taller box than its text is deliberate — it is what verticalAlign aligns within, and a
        // manual resize is how the user sets it.
        expect(richTextFitHeight(box({ height: 400 }), 24)).toBeNull();
        expect(richTextFitHeight(box({ height: 400, verticalAlign: 'center' }), 24)).toBeNull();
    });

    test('a sub-pixel shortfall writes nothing (the loop guard every peer shares)', () => {
        expect(richTextFitHeight(box({ height: 40 }), 40)).toBeNull();
        expect(richTextFitHeight(box({ height: 40 }), 39.4)).toBeNull();
        expect(richTextFitHeight(box({ height: 40 }), 40.2)).toBeNull();
    });

    test('rounds up, so the last line is never clipped by a fraction', () => {
        expect(richTextFitHeight(box({ height: 40 }), 120.2)).toBe(121);
    });

    test('the inset rides inside the stored border box', () => {
        expect(richTextFitHeight(box({ height: 40, padding: 20 }), 100)).toBe(140);
    });

    test('a painted border counts twice; a transparent one not at all', () => {
        expect(richTextFitHeight(box({ height: 40, strokeColor: '#000000', strokeWidth: 4 }), 100)).toBe(108);
        expect(richTextFitHeight(box({ height: 40, strokeWidth: 4 }), 100)).toBe(100);
    });
});
