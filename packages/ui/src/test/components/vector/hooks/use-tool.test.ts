import { describe, expect, test } from 'bun:test';
import { CREATION_TOOL_TYPES, VECTOR_STYLE_DEFAULTS } from '@workspace/lib/vector';
import { VECTOR_TOOLS } from '../../../../components/vector/hooks/use-tool';
import { creatingElement, isBoxTool } from '../../../../components/vector/tools/create-shape';

describe('VECTOR_TOOLS', () => {
    test('is select, every creatable kind in registry order, then text and eraser', () => {
        expect(VECTOR_TOOLS.map((t) => t.tool)).toEqual(['select', ...CREATION_TOOL_TYPES, 'text', 'eraser']);
    });

    test('every creatable kind has an icon, a label and a unique shortcut', () => {
        const shortcuts = VECTOR_TOOLS.map((t) => t.shortcut);
        expect(new Set(shortcuts).size).toBe(shortcuts.length);
        for (const entry of VECTOR_TOOLS) {
            expect(entry.icon).toBeDefined();
            expect(entry.label.length).toBeGreaterThan(0);
        }
    });

    test('only the kinds and the Text tool insert', () => {
        expect(VECTOR_TOOLS.filter((t) => t.inserts).map((t) => t.tool)).toEqual([...CREATION_TOOL_TYPES, 'text']);
    });
});

describe('the Text tool', () => {
    test('is a tool of its own, on T and 8, beside the kinds it inserts with', () => {
        expect(VECTOR_TOOLS.find((t) => t.tool === 'text')).toMatchObject({
            label: 'Text',
            shortcut: 'T',
            digit: '8',
            inserts: true,
        });
    });

    test('drags out a text box: a rectangle that fits its text, previewed as a dashed outline', () => {
        expect(isBoxTool('text')).toBe(true);
        const box = { x: 0, y: 0, width: 10, height: 10, angle: 0 };
        expect(creatingElement({ tool: 'text', seed: 1, box }, VECTOR_STYLE_DEFAULTS)).toMatchObject({
            type: 'rectangle',
            autoFit: true,
            textAlign: 'left',
            verticalAlign: 'top',
            padding: 0,
            strokeStyle: 'dashed',
        });
    });
});
