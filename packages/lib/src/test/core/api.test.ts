import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { api, contactsApi, getDriveItemUrl, openDocument } from '../../core/api';
import { AppError } from '../../core/api-error';
import { DRIVE_MIME_FOLDER } from '../../types/drive';

afterEach(() => mock.restore());

// The contract of the one treaty: a string becomes a Date only when it has the exact shape toJSON writes and sits
// under a key the naming rule keeps for timestamps. Each test reads a real route through a stubbed fetch.
describe('API date parsing', () => {
    const TIMESTAMP = '2026-08-15T10:30:00.000Z';
    const serve = (body: unknown, init?: ResponseInit) =>
        spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body, init));

    test('a timestamp under a timestamp key becomes a Date', async () => {
        serve([{ id: 'calendar-1', name: 'Personal', createdAt: TIMESTAMP, updatedAt: TIMESTAMP }]);

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.error).toBeNull();
        expect(response.data?.[0]?.createdAt).toEqual(new Date(TIMESTAMP));
        expect(response.data?.[0]?.updatedAt).toBeInstanceOf(Date);
    });

    for (const written of ['2026-10-09', TIMESTAMP, '10/09/2026', 'Mon Jan 05 2026 10:00:00 GMT+0100 (CET)']) {
        test(`a title, name or subject of "${written}" stays the string it is`, async () => {
            serve([{ id: 'e1', etag: 'v1', title: written, startTime: TIMESTAMP, occurrenceDate: '2026-10-09' }]);
            const events = await api.calendar({ ownerId: 'owner-1' })['event-range']({ from: '1' })({ to: '2' }).get();
            expect(events.data?.[0]?.title).toBe(written);

            serve([{ id: 'calendar-1', name: written, createdAt: TIMESTAMP }]);
            const calendars = await api.calendar({ ownerId: 'owner-1' }).calendars.get();
            expect(calendars.data?.[0]?.name).toBe(written);

            serve({ subject: written, date: TIMESTAMP, attachments: [] });
            const message = await api
                .mail({ ownerId: 'owner-1' })
                .message({ id: 'm1' })
                .attachment({ index: 0 })
                .preview.eml.get();
            expect(message.data?.subject).toBe(written);
        });
    }

    test('a bare birthday stays a date-only string', async () => {
        serve([{ id: 'contact-1', firstName: 'Ada', birthday: '1990-01-01' }]);
        const contacts = await contactsApi({ ownerId: 'owner-1' }).contacts.get();
        expect(contacts.data?.[0]?.birthday).toBe('1990-01-01');

        serve({ cards: [{ contact: { firstName: 'Ada', birthday: '1990-01-01' }, categories: [] }] });
        const preview = await api
            .drive({ ownerId: 'owner-1' })({ mountId: 'm1' })
            .file({ pathId: 'p1' })
            ['vcard-preview'].get({ query: {} });
        expect(preview.data?.cards[0]?.contact.birthday).toBe('1990-01-01');
    });

    test('an occurrence keeps its bare occurrenceDate beside a revived startTime', async () => {
        serve([{ id: 'e1', etag: 'v1', title: 'Standup', startTime: TIMESTAMP, occurrenceDate: '2026-10-09' }]);

        const response = await api.calendar({ ownerId: 'owner-1' })['event-range']({ from: '1' })({ to: '2' }).get();

        expect(response.data?.[0]?.occurrenceDate).toBe('2026-10-09');
        expect(response.data?.[0]?.startTime).toEqual(new Date(TIMESTAMP));
    });

    test("an .ics preview keeps a timed and an all-day event's bounds as strings", async () => {
        serve({
            events: [
                { start: TIMESTAMP, end: TIMESTAMP },
                { start: '2026-09-20', end: '2026-09-22' },
            ],
        });

        const response = await api
            .mail({ ownerId: 'owner-1' })
            .message({ id: 'm1' })
            .attachment({ index: 0 })
            .preview.ics.get();

        expect(response.data?.events.map((event) => [event.start, event.end])).toEqual([
            [TIMESTAMP, TIMESTAMP],
            ['2026-09-20', '2026-09-22'],
        ]);
    });

    test('a timestamp key holding any other date shape stays a string', async () => {
        const shapes = [
            '2026-08-15',
            '2026-08-15T10:30:00Z',
            '2026-08-15T10:30:00.000+02:00',
            ` ${TIMESTAMP}`,
            `${TIMESTAMP} `,
        ];
        serve(shapes.map((createdAt) => ({ createdAt })));

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.data?.map((calendar) => String(calendar.createdAt))).toEqual(shapes);
    });

    test('a key that only ends in "at" or "date" is no timestamp key', async () => {
        serve({ path: { id: 'p1', details: { format: TIMESTAMP, update: TIMESTAMP, datetime: TIMESTAMP } } });

        const response = await api.collab({ ownerId: 'owner-1' })({ mountId: 'm1' })({ pathId: 'p1' }).info.get();

        expect(response.data?.path?.details).toEqual({ format: TIMESTAMP, update: TIMESTAMP, datetime: TIMESTAMP });
    });

    test('timestamps revive at any depth, in arrays and objects', async () => {
        serve({
            path: { id: 'p1', name: TIMESTAMP, createdAt: TIMESTAMP },
            folderContents: [{ id: 'p2', updatedAt: TIMESTAMP, trashedAt: null }],
        });

        const response = await api.collab({ ownerId: 'owner-1' })({ mountId: 'm1' })({ pathId: 'p1' }).info.get();

        expect(response.data?.path?.createdAt).toEqual(new Date(TIMESTAMP));
        expect(response.data?.path?.name).toBe(TIMESTAMP);
        expect(response.data?.folderContents?.[0]?.updatedAt).toEqual(new Date(TIMESTAMP));
        expect(response.data?.folderContents?.[0]?.trashedAt).toBeNull();
    });

    test('a JSON document carried as a string inside a response is left untouched', async () => {
        const document = JSON.stringify({ createdAt: TIMESTAMP, rows: [{ date: TIMESTAMP }] });
        serve({ body: document, mode: 'prose' });

        const response = await api
            .mail({ ownerId: 'owner-1' })
            .message({ id: 'm1' })
            .attachment({ index: 0 })
            .preview.text.get();

        expect(response.data?.body).toBe(document);
    });

    test('a refused request still answers its error, and AppError reads the JSON message', async () => {
        const refusal = { message: 'This calendar is read-only', createdAt: TIMESTAMP };
        serve(refusal, { status: 403 });

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.data).toBeNull();
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.error?.value)).toBe(JSON.stringify(refusal));
        expect(new AppError(response).message).toBe('This calendar is read-only');
    });

    test('a refused request with a plain-text reason keeps the reason', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(new Response('No access', { status: 403 }));

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.data).toBeNull();
        expect(new AppError(response).message).toBe('No access');
        expect(new AppError(response).status).toBe(403);
    });

    test('a null body answers null data and no error', async () => {
        serve(null);

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.data).toBeNull();
        expect(response.error).toBeNull();
        expect(response.status).toBe(200);
    });

    test('a 204 answers no error', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars({ calId: 'c1' }).delete();

        expect(response.error).toBeNull();
        expect(response.status).toBe(204);
    });

    test('a text body stays text, a timestamp included', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(new Response(TIMESTAMP));

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.error).toBeNull();
        expect(String(response.data)).toBe(TIMESTAMP);
        expect(response.data).not.toBeInstanceOf(Date);
    });

    // Eden hands every hook a clone, and a clone nobody reads buffers the whole body beside the original.
    test('a response the client does not parse has its unread copy cancelled', async () => {
        const copies: Response[] = [];
        const clone = Response.prototype.clone;
        spyOn(Response.prototype, 'clone').mockImplementation(function (this: Response) {
            const copy = clone.call(this);
            copies.push(copy);
            return copy;
        });
        spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(new Uint8Array(8), { headers: { 'content-type': 'application/octet-stream' } }),
            )
            .mockResolvedValueOnce(Response.json({ message: 'Gone' }, { status: 404 }));

        await api.calendar({ ownerId: 'owner-1' }).calendars.get();
        await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(copies.map((copy) => copy.bodyUsed)).toEqual([true, true]);
    });
});

// A document app's details panel opens an item's folder the way its rows open a document: in the Drive app.
test('openDocument opens a folder in Drive', () => {
    const folder = {
        id: 'f1',
        ownerId: 'o1',
        mountId: 'default',
        name: 'Plans',
        type: 'folder',
        mimeType: DRIVE_MIME_FOLDER,
    } as const;
    // biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
    const g = globalThis as any;
    const realWindow = g.window;
    g.window = { location: { href: '' } };
    try {
        openDocument(folder);
        expect(g.window.location.href).toBe(getDriveItemUrl(folder));
    } finally {
        g.window = realWindow;
    }
});
