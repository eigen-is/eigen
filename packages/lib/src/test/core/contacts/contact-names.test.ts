import { describe, expect, test } from 'bun:test';
import { contactFullName, findContactByEmail } from '../../../core/contacts/contact-names';
import type { Contact } from '../../../types/contact';

const grace: Contact = {
    id: 'c1',
    etag: 'e1',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: ['Grace@Example.com', 'gh@navy.mil'],
    phone: [],
};

describe('contact names', () => {
    test('an address finds its contact whatever its case', () => {
        expect(findContactByEmail([grace], 'grace@example.com')).toBe(grace);
        expect(findContactByEmail([grace], 'GH@NAVY.MIL')).toBe(grace);
        expect(findContactByEmail([grace], 'ada@example.com')).toBeUndefined();
    });

    test('a full name leaves out an empty part', () => {
        expect(contactFullName(grace)).toBe('Grace Hopper');
        expect(contactFullName({ ...grace, lastName: '' })).toBe('Grace');
    });
});
