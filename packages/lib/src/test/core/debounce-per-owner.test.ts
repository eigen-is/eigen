import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { debouncePerOwner } from '../../core/debounce-per-owner';

const OWNER = 'owner-1';

// Sends one event every gapMs for durationMs, then lets the last delay run out.
function trickle(run: (queryClient: QueryClient, ownerId: string) => void, gapMs: number, durationMs: number): void {
    const queryClient = new QueryClient();
    for (let at = 0; at < durationMs; at += gapMs) {
        run(queryClient, OWNER);
        jest.advanceTimersByTime(gapMs);
    }
    jest.advanceTimersByTime(10_000);
}

describe('debouncePerOwner', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('a burst refetches once, after it', () => {
        const owners: string[] = [];
        trickle(
            debouncePerOwner((_client, ownerId) => owners.push(ownerId), 250),
            10,
            500,
        );

        expect(owners).toEqual([OWNER]);
    });

    // A 2,000-photo upload sends an event every few hundred ms for minutes. Without a max wait the open
    // folder would show none of it until the upload ends.
    test('a long trickle refetches at least once per max wait', () => {
        let refetches = 0;
        trickle(
            debouncePerOwner(() => refetches++, 250, 1500),
            100,
            5000,
        );

        expect(refetches).toBe(4);
    });

    test('without a max wait, a long trickle refetches once, after it', () => {
        let refetches = 0;
        trickle(
            debouncePerOwner(() => refetches++, 250),
            100,
            5000,
        );

        expect(refetches).toBe(1);
    });

    test('each owner has a burst of its own', () => {
        const owners: string[] = [];
        const run = debouncePerOwner((_client, ownerId) => owners.push(ownerId), 250, 1500);
        const queryClient = new QueryClient();
        run(queryClient, OWNER);
        run(queryClient, 'owner-2');
        run(queryClient, OWNER);
        jest.advanceTimersByTime(250);

        expect(owners.sort()).toEqual([OWNER, 'owner-2']);
    });
});
