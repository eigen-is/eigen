import { describe, expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import { handleApiError, isOutOfMemory } from '../../lib/core/errors';

const app = new Elysia()
    .onError(handleApiError)
    .get('/abandoned', () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
    })
    .get('/broken', () => {
        throw new Error('disk on fire');
    });

describe('handleApiError', () => {
    test('a caller who left mid-wait is a quiet 499, not a logged 500', async () => {
        const logged = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await app.handle(new Request('http://eigen/abandoned'));
            expect(res.status).toBe(499);
            expect(logged).not.toHaveBeenCalled();

            const broken = await app.handle(new Request('http://eigen/broken'));
            expect(broken.status).toBe(500);
            expect(logged).toHaveBeenCalledTimes(1);
        } finally {
            logged.mockRestore();
        }
    });
});

// JSC's own words for every allocation it can refuse with a throw: ArrayBuffers, strings past their length, JSON, zlib.
describe('isOutOfMemory', () => {
    test.each([
        [new RangeError('Out of memory'), true],
        [new RangeError('Out of memory: string too long'), true],
        [new RangeError('Maximum call stack size exceeded.'), false],
        [new RangeError('Invalid array length'), false],
        [new Error('Out of memory'), false],
        ['Out of memory', false],
    ])('%p is %p', (error, expected) => {
        expect(isOutOfMemory(error)).toBe(expected);
    });
});
