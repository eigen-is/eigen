import { describe, expect, test } from 'bun:test';
import { CREATION_TOOL_TYPES, ELEMENT_KINDS, isVectorElementType, type VectorElementType } from '@workspace/lib/vector';
import { VECTOR_TOOLS } from '../../../../components/vector/hooks/use-tool';
import { ELEMENT_KIND_UI } from '../../../../components/vector/kinds';
import { creatingElement, isBoxTool } from '../../../../components/vector/tools/create-shape';

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

    test('only rich text and the image carry their own panel rows', () => {
        // The generic rows (fill, stroke, corners, opacity) gate on capabilities and are the panel's; a
        // PanelSection exists only for what they cannot express — rich text's typography, the image's fit.
        for (const type of vectorElementTypes()) {
            const own = type === 'richtext' || type === 'image';
            expect([type, Boolean(ELEMENT_KIND_UI[type].PanelSection)]).toEqual([type, own]);
        }
    });

    test('every kind the registry marks box-creatable previews as itself', () => {
        // isBoxTool answers from the registry, creatingElement composes per kind off its own literal
        // tuple: a kind that gained `creation: 'box'` without joining the tuple would preview as a
        // rectangle, which is exactly what this catches.
        const box = { x: 0, y: 0, width: 10, height: 10, angle: 0 };
        for (const type of vectorElementTypes()) {
            if (ELEMENT_KINDS[type].capabilities.creation !== 'box') continue;
            expect([type, isBoxTool(type)]).toEqual([type, true]);
            if (!isBoxTool(type)) continue;
            expect(creatingElement({ type, seed: 1, box }).type).toBe(type);
        }
    });

    test('only rich text has an in-place editor', () => {
        for (const type of vectorElementTypes()) {
            expect(Boolean(ELEMENT_KIND_UI[type].InPlaceEditor)).toBe(type === 'richtext');
        }
    });
});
