// The event writes send the etag their dialog loaded, in the place the route reads it. One that meets a 412 says the
// event changed elsewhere and reloads the events, instead of the generic error toast. That toast counts as shown, so a
// dialog that awaits the write drops the rejection instead of logging it. Any other failure keeps the generic toast.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderHook } from '../../../render-hook';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

let answer: { data: unknown; error: unknown; status: number };
const sent: { write: string; args: unknown[] }[] = [];
const write =
    (name: string) =>
    async (...args: unknown[]) => {
        sent.push({ write: name, args });
        return answer;
    };

const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    calendarApi: () => ({
        calendars: () => ({
            events: Object.assign(
                () => ({ put: write('put'), delete: write('delete'), move: { put: write('move') } }),
                {
                    post: write('post'),
                },
            ),
        }),
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

const { act } = await import('react');
const { wasToasted } = await import('../../../../core/api-error');
const { useCreateEvent, useDeleteEvent, useMoveEvent, useUpdateEvent } = await import(
    '../../../../core/calendar/hooks/use-calendar'
);
const { calendarKeys } = await import('../../../../core/calendar/hooks/keys');

const stale = { data: null, error: { status: 412, value: 'Event was changed elsewhere' }, status: 412 };
const STALE_TOAST = 'error: This event changed elsewhere. Check it and try again.';
const event = { calendarId: 'work', id: 'e1', etag: 'v1' };
const override = {
    calendarId: 'work',
    title: 'One occurrence',
    startTime: new Date(0),
    endTime: new Date(0),
    allDay: false,
    parentEventId: 's1',
    recurrenceDate: '2026-10-09',
    etag: 'v1',
};

const move = { ...event, targetCalendarId: 'personal' };

async function run<Input>(useWrite: () => { mutateAsync: (input: Input) => Promise<unknown> }, input: Input) {
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(useWrite, queryClient);
    let failure: unknown = null;
    await act(async () => {
        await latest.mutateAsync(input).catch((error: unknown) => (failure = error));
    });
    await unmount();
    return { failure, invalidated };
}
const runUpdate = () => run(() => useUpdateEvent(OWNER), event);
const runDelete = () => run(() => useDeleteEvent(OWNER), event);
const runMove = () => run(() => useMoveEvent(OWNER), move);
const runOverride = () => run(() => useCreateEvent(OWNER), override);

beforeEach(() => {
    toasts.length = 0;
    sent.length = 0;
    answer = { data: { etag: 'v2' }, error: null, status: 200 };
});

describe('what an event write sends', () => {
    test('an update carries the etag in its body', async () => {
        await runUpdate();
        expect(sent).toEqual([{ write: 'put', args: [{ etag: 'v1' }] }]);
    });

    test('a delete carries the etag as a query parameter', async () => {
        await runDelete();
        expect(sent).toEqual([{ write: 'delete', args: [{}, { query: { etag: 'v1' } }] }]);
    });

    test('a move carries the etag in its body', async () => {
        await runMove();
        expect(sent).toEqual([{ write: 'move', args: [{ targetCalendarId: 'personal', etag: 'v1' }] }]);
    });

    test("an override's creation carries the etag in its body", async () => {
        await runOverride();
        expect(sent).toMatchObject([{ write: 'post', args: [{ parentEventId: 's1', etag: 'v1' }] }]);
    });
});

describe('an event write that meets a 412', () => {
    const staleWrites = { update: runUpdate, delete: runDelete, move: runMove, 'override create': runOverride };
    for (const [name, runWrite] of Object.entries(staleWrites)) {
        test(`a stale ${name} says the event changed elsewhere, reloads the events, and counts as toasted`, async () => {
            answer = stale;
            const { failure, invalidated } = await runWrite();
            expect(toasts).toEqual([STALE_TOAST]);
            expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
            expect(wasToasted(failure)).toBe(true);
        });
    }

    test('any other failure keeps the generic toast', async () => {
        answer = {
            data: null,
            error: { status: 409, value: 'The target calendar already holds this event' },
            status: 409,
        };
        await runMove();
        expect(toasts).toEqual(['error: The target calendar already holds this event (409)']);
    });
});
