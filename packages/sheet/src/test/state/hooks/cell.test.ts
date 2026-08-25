import { describe, expect, test } from 'bun:test';
import { handleCellAreaMouseDown } from '../../../state/events/mouse';
import { updateCell } from '../../../state/index';

// Mock DOM for tests. globalThis is intentionally widened — Bun's test runtime
// has no DOM by default and these mocks are scoped to this test file.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = {
    createElement: (_tag: string) => ({
        innerHTML: '',
        style: {},
        setAttribute: () => {},
        getAttribute: () => null,
        getBoundingClientRect: () => ({
            width: 1000,
            height: 400,
            left: 0,
            top: 0,
        }),
    }),
    getElementById: () => null,
};

// Mock DOM classes
g.MouseEvent = class MouseEvent {
    type: string;
    button: number = 0;
    pageX: number = 0;
    pageY: number = 0;

    constructor(type: string, options: Record<string, unknown> = {}) {
        this.type = type;
        Object.assign(this, options);
    }

    preventDefault: () => void = () => {};
};

describe('sheet/core/hooks/cell', () => {
    test('updateCell', async () => {
        // Basic test - just ensure the function exists and can be called
        expect(typeof updateCell).toBe('function');
    });

    test('handleCellAreaMouseDown', async () => {
        // Basic test - just ensure the function exists
        expect(typeof handleCellAreaMouseDown).toBe('function');
    });
});
