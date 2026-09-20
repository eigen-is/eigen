import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
    api,
    contactsApi,
    emlPreviewRoute,
    icsPreviewRoute,
    mailEmlPreviewRoute,
    mailIcsPreviewRoute,
    mailVCardPreviewRoute,
    vcardPreviewRoute,
} from '../../core/api';

afterEach(() => mock.restore());

describe('API date parsing', () => {
    test('keeps Contacts birthdays as date-only strings', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json([
                {
                    id: 'contact-1',
                    firstName: 'Ada',
                    lastName: 'Lovelace',
                    email: ['ada@example.com'],
                    phone: [],
                    birthday: '1990-01-01',
                },
            ]),
        );

        const response = await contactsApi({ ownerId: 'owner-1' }).contacts.get();

        expect(response.error).toBeNull();
        expect(response.data?.[0]?.birthday).toBe('1990-01-01');
        expect(response.data?.[0]?.birthday).not.toBeInstanceOf(Date);
    });

    test('keeps vCard preview birthdays as date-only strings', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({
                cards: [
                    {
                        contact: {
                            id: '',
                            etag: '',
                            firstName: 'Ada',
                            lastName: 'Lovelace',
                            email: [],
                            phone: [],
                            birthday: '1990-01-01',
                        },
                        categories: [],
                    },
                ],
                dropped: 0,
                total: 1,
            }),
        );

        const response = await vcardPreviewRoute('owner-1', 'm1', 'p1').get({ query: {} });

        expect(response.error).toBeNull();
        expect(response.data?.cards[0]?.contact.birthday).toBe('1990-01-01');
        expect(response.data?.cards[0]?.contact.birthday).not.toBeInstanceOf(Date);
    });

    test('keeps mail part vCard preview birthdays as date-only strings', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json({
                cards: [
                    {
                        contact: {
                            id: '',
                            etag: '',
                            firstName: 'Ada',
                            lastName: 'Lovelace',
                            email: [],
                            phone: [],
                            birthday: '1990-01-01',
                        },
                        categories: [],
                    },
                ],
                dropped: 0,
                total: 1,
            }),
        );

        const response = await mailVCardPreviewRoute('owner-1', 'msg-1', 0).get();

        expect(response.error).toBeNull();
        expect(response.data?.cards[0]?.contact.birthday).toBe('1990-01-01');
        expect(response.data?.cards[0]?.contact.birthday).not.toBeInstanceOf(Date);
    });

    test('keeps the .eml preview date an ISO string on both routes', async () => {
        const preview = {
            subject: 'Engine notes',
            from: null,
            to: null,
            cc: null,
            date: '2026-08-15T10:30:00.000Z',
            html: null,
            text: 'The engine weaves patterns.',
            attachments: [],
            droppedAttachments: 0,
        };
        // One Response per call: a body reads once, and both routes read the same preview.
        spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(Response.json(preview))
            .mockResolvedValueOnce(Response.json(preview));

        const drive = await emlPreviewRoute('owner-1', 'm1', 'p1').get({ query: {} });
        const mail = await mailEmlPreviewRoute('owner-1', 'msg-1', 0).get();

        for (const response of [drive, mail]) {
            expect(response.error).toBeNull();
            expect(response.data?.date).toBe('2026-08-15T10:30:00.000Z');
            expect(response.data?.date).not.toBeInstanceOf(Date);
        }
    });

    test('keeps the .ics preview dates and a date-shaped title strings on both routes', async () => {
        const preview = {
            events: [
                {
                    uid: 'holiday@eigen',
                    // A summary that looks like a date is a title, and the card prints it.
                    title: '2026-09-20',
                    description: null,
                    location: null,
                    start: '2026-09-20',
                    end: '2026-09-22',
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
        // One Response per call: a body reads once, and both routes read the same preview.
        spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(Response.json(preview))
            .mockResolvedValueOnce(Response.json(preview));

        const drive = await icsPreviewRoute('owner-1', 'm1', 'p1').get({ query: {} });
        const mail = await mailIcsPreviewRoute('owner-1', 'msg-1', 0).get();

        for (const response of [drive, mail]) {
            expect(response.error).toBeNull();
            expect(response.data?.events[0]?.title).toBe('2026-09-20');
            expect(response.data?.events[0]?.start).toBe('2026-09-20');
            expect(response.data?.events[0]?.start).not.toBeInstanceOf(Date);
        }
    });

    test('keeps default Eden date revival for instant domains', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(
            Response.json([
                {
                    id: 'calendar-1',
                    name: 'Personal',
                    color: '#123456',
                    isDefault: true,
                    visible: true,
                    ctag: 1,
                    shares: null,
                    createdAt: '2026-08-15T10:30:00.000Z',
                    updatedAt: '2026-08-15T10:30:00.000Z',
                },
            ]),
        );

        const response = await api.calendar({ ownerId: 'owner-1' }).calendars.get();

        expect(response.error).toBeNull();
        expect(response.data?.[0]?.createdAt).toBeInstanceOf(Date);
        expect(response.data?.[0]?.createdAt).toEqual(new Date('2026-08-15T10:30:00.000Z'));
    });
});
