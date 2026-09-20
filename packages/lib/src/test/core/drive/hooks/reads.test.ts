// The drive read hooks, rendered against a stubbed transport. What this pins is the treaty choice:
// useVCardPreview reads a route that serves contact birthdays, and a Date here reaches
// ContactDetailCard's formatDateOnly, which splits a string; useEmlPreview reads a route whose `date`
// is an ISO string the payload type declares as one.
import { afterAll, describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { installHappyDom } from '../../../happy-dom';

// react-dom needs a DOM to render the hooks into.
installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The real Eden client, so the reviver the hook reads through is the one under test.
const realFetch = g.fetch;
const emlPayload = {
    subject: 'Engine notes',
    from: { value: [{ name: 'Ada Lovelace', address: 'ada@example.com' }], text: 'ada@example.com' },
    to: null,
    cc: null,
    date: '2026-08-15T10:30:00.000Z',
    html: null,
    text: 'The engine weaves patterns.',
    attachments: [],
    droppedAttachments: 0,
};
const payload = {
    cards: [
        {
            contact: {
                id: '',
                etag: '',
                firstName: 'Ada',
                lastName: 'Lovelace',
                email: ['ada@example.com'],
                phone: [],
                birthday: '1990-01-01',
            },
            categories: ['Work'],
        },
    ],
    dropped: 0,
    total: 1,
};
const icsPayload = {
    method: 'REQUEST',
    events: [
        {
            uid: 'uid-1',
            title: '2026-09-20',
            description: null,
            location: null,
            start: '2026-09-20',
            end: '2026-09-21',
            allDay: true,
            timezone: null,
            rrule: null,
            status: 'confirmed',
            organizer: null,
            attendees: [],
            droppedAttendees: 0,
        },
    ],
    dropped: 0,
    total: 1,
};
g.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('eml-preview')) return Response.json(emlPayload);
    if (url.includes('ics-preview')) return Response.json(icsPayload);
    return Response.json(payload);
};

afterAll(() => {
    g.fetch = realFetch;
});

// Render one read hook and hand back its settled result.
async function settled<T extends { data: unknown }>(useHook: () => T): Promise<T> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = useHook();
        return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });

    // The query resolves off a microtask and re-renders on a scheduled batch, so let it land.
    while (!seen.latest?.data) {
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
    }
    const latest = seen.latest;
    await act(() => root.unmount());
    return latest;
}

describe('useVCardPreview', () => {
    test('serves a card birthday as the date-only string it is, never a Date', async () => {
        const { useVCardPreview } = await import('../../../../core/drive/hooks/reads');
        const result = await settled(() => useVCardPreview('owner-1', 'm1', 'p1', new Date(1), 1024));

        // The annotation is the type assertion: Eden carries the route's return type to the hook, so a
        // Date on the wire — or a payload that stopped being the preview's — fails `bun run typecheck`.
        const birthday: string | undefined = result.data?.cards[0]?.contact.birthday;
        expect(birthday).toBe('1990-01-01');
        expect(birthday).not.toBeInstanceOf(Date);
    });
});

describe('useEmlPreview', () => {
    test('serves the message date as the ISO string it is, never a Date', async () => {
        const { useEmlPreview } = await import('../../../../core/drive/hooks/reads');
        const result = await settled(() => useEmlPreview('owner-1', 'm1', 'p1', new Date(1), 1024));

        const date: string | null | undefined = result.data?.date;
        expect(date).toBe('2026-08-15T10:30:00.000Z');
        expect(date).not.toBeInstanceOf(Date);
        expect(result.data?.subject).toBe('Engine notes');
    });
});

describe('useIcsPreview', () => {
    test('serves an all-day bound, and a date-shaped title, as the strings they are', async () => {
        const { useIcsPreview } = await import('../../../../core/drive/hooks/reads');
        const result = await settled(() => useIcsPreview('owner-1', 'm1', 'p1', new Date(1), 1024));

        const event = result.data?.events[0];
        const start: string | undefined = event?.start;
        expect(start).toBe('2026-09-20');
        expect(start).not.toBeInstanceOf(Date);
        expect(event?.title).toBe('2026-09-20');
        expect(event?.title).not.toBeInstanceOf(Date);
    });
});
