import { describe, expect, test } from 'bun:test';

// geometry dispatches through the registry and the registry uses geometry's box primitives: one
// deliberate cycle. Both entry orders must initialize, so neither consumer can be import-order sensitive.
describe('the geometry ↔ kinds cycle', () => {
    test('importing geometry first initializes the registry', async () => {
        const geometry = await import('../../../vector/geometry');
        const kinds = await import('../../../vector/kinds');
        expect(Object.keys(kinds.ELEMENT_KINDS)).toHaveLength(8);
        expect(geometry.hitTestElement).toBeInstanceOf(Function);
    });

    test('importing kinds first initializes geometry', async () => {
        const kinds = await import('../../../vector/kinds');
        const geometry = await import('../../../vector/geometry');
        expect(kinds.ELEMENT_KINDS.rectangle.type).toBe('rectangle');
        expect(geometry.getElementBounds({ x: 0, y: 0, width: 1, height: 1, angle: 0 })).toBeDefined();
    });
});
