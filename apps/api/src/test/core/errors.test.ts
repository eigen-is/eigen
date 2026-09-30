import { describe, expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';
import { handleApiError } from '../../lib/core/errors';

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
