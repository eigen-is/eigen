import { describe, expect, test } from 'bun:test';
import { RWLock } from '../../utils/rw-lock';

// Pure deferreds: a grant the lock withholds either reorders `order` or deadlocks the test.
describe('RWLock', () => {
    test('two shared holders overlap', async () => {
        const lock = new RWLock();
        const aIn = Promise.withResolvers<void>();
        const bIn = Promise.withResolvers<void>();
        await Promise.all([
            lock.shared(async () => {
                aIn.resolve();
                await bIn.promise;
            }),
            lock.shared(async () => {
                bIn.resolve();
                await aIn.promise;
            }),
        ]);
    });

    test('an exclusive waits for a shared holder and excludes a later shared', async () => {
        const lock = new RWLock();
        const order: string[] = [];
        const releaseShared = Promise.withResolvers<void>();
        const exclusiveIn = Promise.withResolvers<void>();
        const releaseExclusive = Promise.withResolvers<void>();

        const first = lock.shared(async () => {
            order.push('shared');
            await releaseShared.promise;
            order.push('shared-end');
        });
        const exclusive = lock.exclusive(async () => {
            order.push('exclusive');
            exclusiveIn.resolve();
            await releaseExclusive.promise;
            order.push('exclusive-end');
        });
        releaseShared.resolve();
        await exclusiveIn.promise;
        const later = lock.shared(async () => {
            order.push('later');
        });
        releaseExclusive.resolve();
        await Promise.all([first, exclusive, later]);

        expect(order).toEqual(['shared', 'shared-end', 'exclusive', 'exclusive-end', 'later']);
    });

    test('a shared request arriving after a queued exclusive waits behind it', async () => {
        const lock = new RWLock();
        const order: string[] = [];
        const releaseShared = Promise.withResolvers<void>();

        const first = lock.shared(async () => {
            order.push('shared');
            await releaseShared.promise;
            order.push('shared-end');
        });
        const exclusive = lock.exclusive(async () => {
            order.push('exclusive');
        });
        const later = lock.shared(async () => {
            order.push('later');
        });
        releaseShared.resolve();
        await Promise.all([first, exclusive, later]);

        expect(order).toEqual(['shared', 'shared-end', 'exclusive', 'later']);
    });

    test('an exclusive holder excludes a later exclusive', async () => {
        const lock = new RWLock();
        const order: string[] = [];
        const releaseFirst = Promise.withResolvers<void>();
        const first = lock.exclusive(async () => {
            order.push('first');
            await releaseFirst.promise;
            order.push('first-end');
        });
        const second = lock.exclusive(async () => {
            order.push('second');
        });
        await Promise.resolve();
        expect(order).toEqual(['first']);
        releaseFirst.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(['first', 'first-end', 'second']);
    });

    test('a body that throws releases the lock and rethrows', async () => {
        const lock = new RWLock();
        const failing = lock.exclusive(async () => {
            throw new Error('boom');
        });
        const next = lock.exclusive(async () => 'next');
        await expect(failing).rejects.toThrow('boom');
        expect(await next).toBe('next');
    });

    test('a release grants the whole run of queued shared requests up to the next exclusive', async () => {
        const lock = new RWLock();
        const order: string[] = [];
        const releaseFirst = Promise.withResolvers<void>();
        const aIn = Promise.withResolvers<void>();
        const bIn = Promise.withResolvers<void>();

        const first = lock.exclusive(async () => {
            await releaseFirst.promise;
            order.push('first-end');
        });
        const a = lock.shared(async () => {
            aIn.resolve();
            await bIn.promise;
            order.push('a');
        });
        const b = lock.shared(async () => {
            bIn.resolve();
            await aIn.promise;
            order.push('b');
        });
        const second = lock.exclusive(async () => {
            order.push('second');
        });
        const tail = lock.shared(async () => {
            order.push('tail');
        });
        releaseFirst.resolve();
        await Promise.all([first, a, b, second, tail]);

        expect(order[0]).toBe('first-end');
        expect(order.slice(1, 3).sort()).toEqual(['a', 'b']);
        expect(order.slice(3)).toEqual(['second', 'tail']);
    });
});
