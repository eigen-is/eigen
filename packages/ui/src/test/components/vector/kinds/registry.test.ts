import { describe, expect, test } from 'bun:test';
import { CREATION_TOOL_TYPES, ELEMENT_KINDS, isVectorElementType, type VectorElementType } from '@workspace/lib/vector';
import { VECTOR_TOOLS } from '../../../../components/vector/hooks/use-tool';
import { ELEMENT_KIND_UI } from '../../../../components/vector/kinds';

// The kind vocabulary, from the one table that owns it.
function vectorElementTypes(): VectorElementType[] {
    return Object.keys(ELEMENT_KINDS).filter(isVectorElementType);
}

describe('ELEMENT_KIND_UI', () => {
    test('has exactly one entry per element kind', () => {
        expect(Object.keys(ELEMENT_KIND_UI).sort()).toEqual(Object.keys(ELEMENT_KINDS).sort());
    });

    test('every creatable kind has a shortcut and no other kind does', () => {
        for (const type of vectorElementTypes()) {
            const creatable = CREATION_TOOL_TYPES.some((t) => t === type);
            expect(Boolean(ELEMENT_KIND_UI[type].shortcut)).toBe(creatable);
        }
    });

    test('letters and digits are unique across the tool list', () => {
        const letters = VECTOR_TOOLS.map((t) => t.shortcut);
        const digits = VECTOR_TOOLS.map((t) => t.digit);
        expect(new Set(letters).size).toBe(letters.length);
        expect(new Set(digits).size).toBe(digits.length);
    });

    test('the tool list reads its icons and labels from the registry', () => {
        for (const entry of VECTOR_TOOLS) {
            if (entry.tool === 'select' || entry.tool === 'eraser') continue;
            expect(entry.icon).toBe(ELEMENT_KIND_UI[entry.tool].icon);
            expect(entry.label).toBe(ELEMENT_KIND_UI[entry.tool].label);
        }
    });

    test('a kind carries its own panel rows exactly when a capability calls for them', () => {
        // The generic rows (fill, stroke, corners, opacity) are the panel's; a kind entry exists only for
        // what they cannot express — rich text's typography and the image's fit.
        for (const type of vectorElementTypes()) {
            const caps = ELEMENT_KINDS[type].capabilities;
            expect([type, Boolean(ELEMENT_KIND_UI[type].PanelSection)]).toEqual([
                type,
                caps.typography || caps.objectFit,
            ]);
        }
    });

    test('only rich text has an in-place editor', () => {
        for (const type of vectorElementTypes()) {
            expect(Boolean(ELEMENT_KIND_UI[type].InPlaceEditor)).toBe(type === 'richtext');
        }
    });
});
