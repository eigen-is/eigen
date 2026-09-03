import { describe, expect, test } from 'bun:test';
import { AppError } from '../../../core/api-error';
import { CreateUnconfirmedError, createWithReconcile } from '../../../core/drive/reconcile-create';

type Item = { id: string; name: string };

function item(name: string, id: string = 'new'): Item {
    return { id, name };
}

// Returns a listFolder that serves listings[0], listings[1], … one per call (last one repeats). The
// first call is createWithReconcile's pre-create snapshot; the rest are the reconcile polls. A
// listing may be an Error, standing in for a call that fails against slow storage.
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

// Every create here fails indeterminately, which is what puts createWithReconcile into its polls.
const unavailable = () =>
    new AppError({ error: { status: 503, value: { message: 'Storage unavailable' } }, status: 503 });

describe('createWithReconcile', () => {
    test('returns the match on the first poll without waiting', async () => {
        const { listFolder, calls } = pollingList([], [item('Notes.eigendoc')]);

        const found = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Notes.eigendoc',
            // A delay this long would hang the test, so resolving at all proves the first poll never slept.
            delayMs: 60_000,
        });

        expect(found).toEqual(item('Notes.eigendoc'));
        expect(calls()).toBe(2);
    });

    test('keeps polling until the item lands', async () => {
        const { listFolder, calls } = pollingList([], [], [], [item('Notes.eigendoc')]);

        const found = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Notes.eigendoc',
            delayMs: 1,
        });

        expect(found).toEqual(item('Notes.eigendoc'));
        expect(calls()).toBe(4);
    });

    test('matches a decomposed expected name against the NFC name the server stored', async () => {
        const stored = 'Café.eigendoc'.normalize('NFC');
        const { listFolder } = pollingList([], [item(stored)]);

        const found = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Café.eigendoc'.normalize('NFD'),
            delayMs: 1,
        });

        expect(found).toEqual(item(stored));
    });

    test('a failing poll does not abort the remaining polls', async () => {
        const { listFolder, calls } = pollingList([], new Error('listing failed'), [item('Notes.eigendoc')]);

        const found = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Notes.eigendoc',
            delayMs: 1,
        });

        expect(found).toEqual(item('Notes.eigendoc'));
        expect(calls()).toBe(3);
    });

    test('ignores a same-name item the snapshot already held', async () => {
        const { listFolder, calls } = pollingList([item('Notes.eigendoc', 'pre-existing')]);

        const error = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Notes.eigendoc',
            delayMs: 1,
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(CreateUnconfirmedError);
        expect(calls()).toBe(4); // the snapshot plus all 3 polls
    });

    test('picks the unseen id over a same-name sibling from the snapshot', async () => {
        const ours = item('Notes.eigendoc', 'ours');
        const { listFolder } = pollingList(
            [item('Notes.eigendoc', 'pre-existing')],
            [item('Notes.eigendoc', 'pre-existing'), ours],
        );

        const found = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Notes.eigendoc',
            delayMs: 1,
        });

        expect(found).toBe(ours);
    });

    test('rethrows a 4xx as is — the server already answered, so nothing to reconcile', async () => {
        const duplicate = new AppError({ error: { status: 409, value: 'A file with that name exists' }, status: 409 });
        let listings = 0;

        const error = await createWithReconcile({
            create: () => Promise.reject(duplicate),
            listFolder: async () => {
                listings++;
                return [item('Notes.eigendoc')];
            },
            expectedName: 'Notes.eigendoc',
        }).catch((e: unknown) => e);

        expect(error).toBe(duplicate);
        // Only the pre-create snapshot ran; the 4xx skipped the polls.
        expect(listings).toBe(1);
    });

    test('a timed-out create whose row landed anyway resolves with the row the listing found', async () => {
        // The exact rejection AbortSignal.timeout produces (Bun and the browsers alike): a
        // DOMException, not an AppError — a shape the 4xx check must classify as indeterminate.
        const timedOut = new DOMException('The operation timed out.', 'TimeoutError');
        const landed = item('Notes.eigendoc', 'landed');
        const { listFolder } = pollingList([item('Notes.eigendoc', 'pre-existing')], [landed]);

        const created = await createWithReconcile({
            create: () => Promise.reject(timedOut),
            listFolder,
            expectedName: 'Notes.eigendoc',
            delayMs: 1,
        });

        expect(created).toBe(landed);
    });

    test('an indeterminate failure with nothing to reconcile rejects with the slow-storage copy', async () => {
        const failure = unavailable();
        const { listFolder, calls } = pollingList([item('Other.eigendoc')]);

        const error = await createWithReconcile({
            create: () => Promise.reject(failure),
            listFolder,
            expectedName: 'Notes.eigendoc',
            // The 5s production budget would make this case wait 10s.
            delayMs: 1,
        }).catch((e: unknown) => e);

        if (!(error instanceof CreateUnconfirmedError)) throw error;
        expect(error.cause).toBe(failure);
        expect(error.message).toBe(
            'Storage is responding slowly. The item may still appear in the list automatically.',
        );
        expect(calls()).toBe(4); // the snapshot plus all 3 polls
    });

    // No expectedName: the chat wizard's dedupeName creates, where the server may store `Name (2)`.
    test('without an expected name there is no listing at all, only the error classification', async () => {
        const failure = unavailable();
        const { listFolder, calls } = pollingList([item('Notes.eigenchat')]);

        const error = await createWithReconcile({
            create: () => Promise.reject(failure),
            listFolder,
            delayMs: 1,
        }).catch((e: unknown) => e);

        if (!(error instanceof CreateUnconfirmedError)) throw error;
        expect(error.cause).toBe(failure);
        expect(calls()).toBe(0);
    });

    test('without an expected name a 4xx is still rethrown as is', async () => {
        const duplicate = new AppError({ error: { status: 409, value: 'A file with that name exists' }, status: 409 });
        const { listFolder, calls } = pollingList([]);

        const error = await createWithReconcile({
            create: () => Promise.reject(duplicate),
            listFolder,
        }).catch((e: unknown) => e);

        expect(error).toBe(duplicate);
        expect(calls()).toBe(0);
    });

    test('a failed snapshot leaves no anchor, so the failure is reported without polling', async () => {
        const { listFolder, calls } = pollingList(new Error('listing failed'), [item('Notes.eigendoc')]);

        const error = await createWithReconcile({
            create: () => Promise.reject(unavailable()),
            listFolder,
            expectedName: 'Notes.eigendoc',
            delayMs: 1,
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(CreateUnconfirmedError);
        expect(calls()).toBe(1);
    });
});
