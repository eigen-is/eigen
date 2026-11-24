// An occurrence saved at a scope: "this" writes an override into the master, "this and following" truncates the series
// and starts a new one, and "all" saves the change on the master as a delta. Every write answers to the held etag, a
// split that fails at its second write retries on the etag its first one answered, and a 412 reloads and says so. An
// "all" on a series loads the master it saves on, unless the cache already holds it.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CalendarEvent, CalendarEventOccurrence, SaveOccurrenceInput } from '../../../../types/calendar';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

type Answer = { data: unknown; error: unknown; status: number };
const ok = (etag: string): Answer => ({ data: { etag }, error: null, status: 200 });
const refused = (status: number): Answer => ({ data: null, error: { status, value: 'Refused' }, status });

// What each write is answered with, in order; past the end, a plain success.
let answers: Answer[] = [];
const sent: { write: string; id?: string; body: Record<string, unknown> }[] = [];
// The events whose stored row was read, which only the master is.
const loaded: string[] = [];
const write =
    (name: string, id?: string) =>
    async (body: Record<string, unknown>): Promise<Answer> => {
        sent.push({ write: name, id, body });
        return answers.shift() ?? ok('next');
    };

const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    calendarApi: () => ({
        calendars: () => ({
            events: Object.assign(
                ({ id }: { id: string }) => ({
                    put: write('put', id),
                    get: async () => {
                        loaded.push(id);
                        return { data: master, error: null, status: 200 };
                    },
                }),
                { post: write('post') },
            ),
        }),
    }),
}));
afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { wasToasted } = await import('../../../../core/api-error');
const { calendarKeys } = await import('../../../../core/calendar/hooks/keys');
const { useSaveOccurrence } = await import('../../../../core/calendar/hooks/use-save-occurrence');
const { useHeldEtag } = await import('../../../../core/use-held-etag');

const STALE_TOAST = 'error: This event changed elsewhere. Check it and try again.';
const master: CalendarEvent = {
    id: 's1',
    calendarId: 'work',
    uid: 's1@eigen',
    uri: 's1.ics',
    title: 'Standup',
    description: null,
    location: null,
    startTime: new Date('2026-10-01T09:00:00Z'),
    endTime: new Date('2026-10-01T09:15:00Z'),
    allDay: false,
    rrule: 'FREQ=WEEKLY',
    timezone: 'Europe/Amsterdam',
    parentEventId: null,
    recurrenceDate: null,
    status: 'confirmed',
    sequence: 0,
    etag: 'v1',
    data: null,
    createByUserId: OWNER,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};
const occurrence: CalendarEventOccurrence = {
    ...master,
    startTime: new Date('2026-10-15T09:00:00Z'),
    endTime: new Date('2026-10-15T09:15:00Z'),
    occurrenceDate: '2026-10-15',
};
const override: CalendarEventOccurrence = { ...occurrence, id: 'o1', rrule: null, parentEventId: 's1' };
// A drop's change: the occurrence an hour later, everything else as it is.
const anHourLater = (event: CalendarEventOccurrence): SaveOccurrenceInput['edited'] => ({
    ...event,
    startTime: new Date(event.startTime.getTime() + 3600_000),
    endTime: new Date(event.endTime.getTime() + 3600_000),
});

// A host as Edit event or a drop mounts it: the held etag over the event's live one, and the save bound to its owner.
async function mount(liveEtag = 'v1') {
    const { queryClient, invalidated } = trackingClient();
    const seen: { latest?: { held: ReturnType<typeof useHeldEtag>; save: ReturnType<typeof useSaveOccurrence> } } = {};
    function Host({ etag }: { etag: string }) {
        const held = useHeldEtag(etag, false);
        seen.latest = { held, save: useSaveOccurrence(OWNER, held) };
        return null;
    }
    const root = createRoot(document.createElement('div'));
    const render = async (etag: string) => {
        await act(async () => {
            root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Host, { etag })));
        });
    };
    await render(liveEtag);
    const latest = () => {
        if (!seen.latest) throw new Error('the host never rendered');
        return seen.latest;
    };
    // Saves as a caller does, through the held etag, and hands back the rejection instead of throwing it.
    const save = async (input: SaveOccurrenceInput) => {
        let failure: unknown = null;
        await act(async () => {
            const { held, save } = latest();
            await held.saveHeld(() => save(input).then(() => {})).catch((error: unknown) => (failure = error));
            // The query client tells its observers on a timer, so the act waits for that too.
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        return failure;
    };
    unmount = async () => {
        await act(async () => {
            root.unmount();
        });
    };
    return { save, render, latest, invalidated, queryClient };
}

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    answers = [];
    sent.length = 0;
    loaded.length = 0;
    toasts.length = 0;
});

describe('a save at each scope', () => {
    test('this writes an override into the master, on the held etag, with the occurrence fields only', async () => {
        // A host whose form froze an older etag than the list copy's answers to the frozen one.
        const { save } = await mount('v0');
        await save({ occurrence, scope: 'this', edited: anHourLater(occurrence) });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            write: 'post',
            body: {
                parentEventId: 's1',
                recurrenceDate: '2026-10-15',
                rrule: null,
                etag: 'v0',
                startTime: new Date('2026-10-15T10:00:00Z'),
            },
        });
        expect(Object.keys(sent[0].body)).not.toContain('uid');
    });

    test('this and following truncates the series on the held etag, then starts a new one with the rule', async () => {
        const { save } = await mount();
        await save({ occurrence, scope: 'this-and-following', edited: anHourLater(occurrence) });

        expect(sent.map(({ write, id, body }) => [write, id, body.etag])).toEqual([
            ['put', 's1', 'v1'],
            ['post', undefined, undefined],
        ]);
        expect(sent[0].body.rrule).toContain('UNTIL=');
        expect(sent[1].body).toMatchObject({ rrule: 'FREQ=WEEKLY', startTime: new Date('2026-10-15T10:00:00Z') });
        expect(sent[1].body.parentEventId).toBeUndefined();
    });

    test('all saves the change on the master as a delta, so the series keeps its own start', async () => {
        const { save, queryClient } = await mount();
        // Edit event's form has loaded the master already.
        queryClient.setQueryData(calendarKeys.event(OWNER, 'work', 's1'), master);
        await save({ occurrence, scope: 'all', edited: anHourLater(occurrence) });

        expect(loaded).toEqual([]);
        expect(sent).toEqual([
            {
                write: 'put',
                id: 's1',
                body: {
                    etag: 'v1',
                    rrule: 'FREQ=WEEKLY',
                    timezone: 'Europe/Amsterdam',
                    startTime: new Date('2026-10-01T10:00:00Z'),
                    endTime: new Date('2026-10-01T10:15:00Z'),
                },
            },
        ]);
    });

    test("all with no master loaded reads it once and sends the master's start, not the occurrence's", async () => {
        const { save } = await mount();
        await save({ occurrence, scope: 'all', edited: anHourLater(occurrence) });

        expect(loaded).toEqual(['s1']);
        expect(sent).toHaveLength(1);
        expect(sent[0].body).toMatchObject({
            startTime: new Date('2026-10-01T10:00:00Z'),
            endTime: new Date('2026-10-01T10:15:00Z'),
        });
    });

    test("all from an override keeps the master's rule and takes the series data it is given", async () => {
        const { save } = await mount();
        const seriesData = {
            attendees: [{ email: 'ada@example.org', status: 'pending' as const, role: 'required' as const }],
        };
        await save({ occurrence: override, scope: 'all', edited: anHourLater(override), seriesData });

        expect(sent).toHaveLength(1);
        expect(loaded).toEqual(['s1']);
        expect(sent[0]).toMatchObject({ write: 'put', id: 's1', body: { data: seriesData } });
        expect(sent[0].body.rrule).toBeUndefined();
    });

    test('all on a single event sends its fields whole', async () => {
        const single = { ...occurrence, id: 'e1', rrule: null };
        const { save } = await mount();
        await save({ occurrence: single, scope: 'all', edited: { ...anHourLater(single), title: 'Dentist' } });

        expect(loaded).toEqual([]);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
            write: 'put',
            id: 'e1',
            body: { etag: 'v1', title: 'Dentist', rrule: null, startTime: new Date('2026-10-15T10:00:00Z') },
        });
    });
});

describe('a save that fails', () => {
    test('this and following failing at its new series retries from what the truncation answered', async () => {
        answers = [ok('v2'), refused(500)];
        const { save } = await mount();
        const edited = anHourLater(occurrence);
        // The truncation took the occurrence out of the list: the live etag stays the one it opened with.
        expect(await save({ occurrence, scope: 'this-and-following', edited })).not.toBeNull();

        answers = [ok('v3'), ok('v4')];
        expect(await save({ occurrence, scope: 'this-and-following', edited })).toBeNull();
        expect(sent.map(({ write, body }) => [write, body.etag])).toEqual([
            ['put', 'v1'],
            ['post', undefined],
            ['put', 'v2'],
            ['post', undefined],
        ]);
        expect(toasts).not.toContain(STALE_TOAST);
    });

    test('a 412 reloads the events and says so, writes nothing more, and the retry answers to the reload', async () => {
        answers = [refused(412)];
        const { save, render, invalidated } = await mount();
        const failure = await save({ occurrence, scope: 'this-and-following', edited: anHourLater(occurrence) });

        expect(wasToasted(failure)).toBe(true);
        expect(toasts).toEqual([STALE_TOAST]);
        expect(hasKey(invalidated, calendarKeys.events(OWNER))).toBe(true);
        expect(sent.map(({ write }) => write)).toEqual(['put']);

        await render('v2');
        await save({ occurrence, scope: 'all', edited: anHourLater(occurrence) });
        expect(sent.map(({ body }) => body.etag)).toEqual(['v1', 'v2']);
    });
});
