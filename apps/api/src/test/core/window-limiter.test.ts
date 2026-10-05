import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { WindowLimiter } from '../../lib/core/window-limiter';

describe('WindowLimiter', () => {
    afterEach(() => setSystemTime());

    test('a full key takes again once its hits age out of the window', () => {
        const limiter = new WindowLimiter(60_000, 2);
        expect(limiter.take('a')).toBe(true);
        expect(limiter.take('a')).toBe(true);
        expect(limiter.take('a')).toBe(false);
        expect(limiter.take('b')).toBe(true);

        setSystemTime(new Date(Date.now() + 60_000));
        expect(limiter.take('a')).toBe(true);
    });
});
