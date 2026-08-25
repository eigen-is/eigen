import { describe, expect, test } from 'bun:test';
import { contextFactory } from '../factories/context';

describe('sheet/core/hooks/sheet', () => {
    const getContext = () => contextFactory();

    test('basic sheet test', async () => {
        const ctx = getContext();
        // Basic test - just ensure it doesn't crash
        expect(ctx).toBeDefined();
    });
});
