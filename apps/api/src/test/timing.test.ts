import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { time } from '../utils/timing';

describe('time()', () => {
    let logs: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
        logs = [];
        originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logs.push(args.map(String).join(' '));
        };
    });

    afterEach(() => {
        console.log = originalLog;
    });

    test('returns the resolved value of an async function', async () => {
        const result = await time('test.async', async () => 42);
        expect(result).toBe(42);
    });

    test('returns the value of a sync function', async () => {
        const result = await time('test.sync', () => 'hello');
        expect(result).toBe('hello');
    });

    test('logs a [timing] line with label and ms', async () => {
        await time('test.logs', async () => {
            await Bun.sleep(5);
        });
        expect(logs.length).toBe(1);
        expect(logs[0]).toMatch(/^\[timing\] test\.logs \d+\.\d+ms$/);
    });

    test('logs even if the function throws', async () => {
        await expect(
            time('test.throws', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(logs.length).toBe(1);
        expect(logs[0]).toMatch(/^\[timing\] test\.throws \d+\.\d+ms$/);
    });

    test('accepts a sync function that returns a promise', async () => {
        const result = await time('test.promise', () => Promise.resolve('ok'));
        expect(result).toBe('ok');
    });
});
