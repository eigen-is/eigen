import { describe, expect, test } from 'bun:test';
import { CREATION_TOOL_TYPES } from '@workspace/lib/vector';
import { VECTOR_TOOLS } from '../../../../components/vector/hooks/use-tool';

describe('VECTOR_TOOLS', () => {
    test('is select, every creatable kind in registry order, then eraser', () => {
        expect(VECTOR_TOOLS.map((t) => t.tool)).toEqual(['select', ...CREATION_TOOL_TYPES, 'eraser']);
    });

    test('every creatable kind has an icon, a label and a unique shortcut', () => {
        const shortcuts = VECTOR_TOOLS.map((t) => t.shortcut);
        expect(new Set(shortcuts).size).toBe(shortcuts.length);
        for (const entry of VECTOR_TOOLS) {
            expect(entry.icon).toBeDefined();
            expect(entry.label.length).toBeGreaterThan(0);
        }
    });

    test('only the kinds insert', () => {
        expect(VECTOR_TOOLS.filter((t) => t.inserts).map((t) => t.tool)).toEqual([...CREATION_TOOL_TYPES]);
    });
});
