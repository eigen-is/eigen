import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { api, contactsApi } from './api';

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
