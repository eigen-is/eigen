import { describe, expect, test } from 'bun:test';
import { AppError } from '../../../core/api-error';
import {
    CreateUnconfirmedError,
    createWithReconcile,
    RECONCILE_ATTEMPTS,
    reconcileCreatedItem,
} from '../../../core/drive/reconcile-create';

type Item = { name: string; createdAt: Date };

const SINCE = new Date('2026-09-02T10:00:00Z');
const BEFORE = new Date('2026-09-02T09:59:00Z');
const AFTER = new Date('2026-09-02T10:00:01Z');

function item(name: string, createdAt: Date = AFTER): Item {
    return { name, createdAt };
}

// Returns a listFolder that serves listings[0], listings[1], … one per poll (last one repeats).
// A listing may be an Error, standing in for a poll that fails against slow storage.
function pollingList(...listings: (Item[] | Error)[]): { listFolder: () => Promise<Item[]>; calls: () => number } {
    let calls = 0;
    return {
        listFolder: async () => {
            const listing = listings[Math.min(calls, listings.length - 1)];
            calls++;
            if (listing instanceof Error) throw listing;
            return listing;
        },
        calls: () => calls,
    };
}

describe('reconcileCreatedItem', () => {
    test('returns the match on the first poll without waiting', async () => {
        const { listFolder, calls } = pollingList([item('Notes.eigendoc')]);
        const started = Date.now();

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Notes.eigendoc',
            since: SINCE,
            attempts: 3,
            delayMs: 500,
        });

        expect(found).toEqual(item('Notes.eigendoc'));
        expect(calls()).toBe(1);
        expect(Date.now() - started).toBeLessThan(500);
    });

    test('keeps polling until the item lands', async () => {
        const { listFolder, calls } = pollingList([], [], [item('Notes.eigendoc')]);

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Notes.eigendoc',
            since: SINCE,
            attempts: 3,
            delayMs: 1,
        });

        expect(found).toEqual(item('Notes.eigendoc'));
        expect(calls()).toBe(3);
    });

    test('returns null when the item never appears', async () => {
        const { listFolder, calls } = pollingList([item('Other.eigendoc')]);

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Notes.eigendoc',
            since: SINCE,
            attempts: 3,
            delayMs: 1,
        });

        expect(found).toBeNull();
        expect(calls()).toBe(3);
    });

    test('matches a decomposed expected name against the NFC name the server stored', async () => {
        const stored = 'Café.eigendoc'.normalize('NFC');
        const { listFolder } = pollingList([item(stored)]);

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Café.eigendoc'.normalize('NFD'),
            since: SINCE,
            attempts: 3,
            delayMs: 1,
        });

        expect(found).toEqual(item(stored));
    });

    test('a failing poll does not abort the remaining polls', async () => {
        const { listFolder, calls } = pollingList(new Error('listing failed'), [item('Notes.eigendoc')]);

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Notes.eigendoc',
            since: SINCE,
            attempts: 3,
            delayMs: 1,
        });

        expect(found).toEqual(item('Notes.eigendoc'));
        expect(calls()).toBe(2);
    });

    test('ignores a same-name item created before the floor', async () => {
        const { listFolder, calls } = pollingList([item('Notes.eigendoc', BEFORE)]);

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Notes.eigendoc',
            since: SINCE,
            attempts: 3,
            delayMs: 1,
        });

        expect(found).toBeNull();
        expect(calls()).toBe(3);
    });

    test('picks the fresh item over an older same-name sibling', async () => {
        const ours = item('Notes.eigendoc', AFTER);
        const { listFolder } = pollingList([item('Notes.eigendoc', BEFORE), ours]);

        const found = await reconcileCreatedItem({
            listFolder,
            expectedName: 'Notes.eigendoc',
            since: SINCE,
            attempts: 3,
            delayMs: 1,
        });

        expect(found).toBe(ours);
    });
});

describe('createWithReconcile', () => {
    test('rethrows a 4xx as is — the server already answered, so nothing to reconcile', async () => {
        const duplicate = new AppError({ error: { status: 409, value: 'A file with that name exists' }, status: 409 });
        let polls = 0;

        const error = await createWithReconcile({
            create: () => Promise.reject(duplicate),
            listFolder: async () => {
                polls++;
                return [item('Notes.eigendoc')];
            },
            expectedName: 'Notes.eigendoc',
        }).catch((e: unknown) => e);

        expect(error).toBe(duplicate);
        expect(polls).toBe(0);
    });

    test('an indeterminate failure with nothing to reconcile rejects with the slow-storage copy', async () => {
        const unavailable = new AppError({
            error: { status: 503, value: { message: 'Storage unavailable' } },
            status: 503,
        });
        let polls = 0;

        const error = await createWithReconcile({
            create: () => Promise.reject(unavailable),
            listFolder: async () => {
                polls++;
                return [item('Other.eigendoc')];
            },
            expectedName: 'Notes.eigendoc',
            // The 5s production budget would make this case wait 10s.
            delayMs: 1,
        }).catch((e: unknown) => e);

        if (!(error instanceof CreateUnconfirmedError)) throw error;
        expect(error.cause).toBe(unavailable);
        expect(error.message).toBe(
            'Storage is responding slowly. The item may still appear in the list automatically.',
        );
        expect(polls).toBe(RECONCILE_ATTEMPTS);
    });
});
