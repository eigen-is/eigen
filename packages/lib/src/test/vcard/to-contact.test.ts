// The parsed-card -> Contact projection the import preview and the Drive quick-look render a file through.
// The parser itself is covered in vcard.test.ts; this pins what the projection does with its output.
import { describe, expect, test } from 'bun:test';
import { parseVCard } from '../../vcard';
import { parsedCardToContact } from '../../vcard/to-contact';

// A vCard is CRLF-joined and CRLF-terminated; fixtures are written as physical lines.
const vcard = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

// The encode side of the parser's atob decode — kept off Node globals, like the module it exercises.
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const PNG = toBase64(new Uint8Array([137, 80, 78, 71]));

const card = (...extra: string[]) =>
    parseVCard(
        vcard([
            'BEGIN:VCARD',
            'VERSION:3.0',
            'UID:card-1',
            'N:Doe;Jane;;;',
            'FN:Jane Doe',
            'EMAIL:jane@example.com',
            'TEL:+31612345678',
            ...extra,
            'END:VCARD',
        ]),
    );

describe('parsedCardToContact', () => {
    test('a card without a photo maps every required field and carries no avatar', () => {
        const { contact } = parsedCardToContact(card('ORG:Example Corp', 'TITLE:Engineer', 'BDAY:1990-01-02'));

        expect(contact.id).toBe('card-1');
        expect(contact.etag).toBe('');
        expect(contact.firstName).toBe('Jane');
        expect(contact.lastName).toBe('Doe');
        expect(contact.email).toEqual(['jane@example.com']);
        expect(contact.phone).toEqual(['+31612345678']);
        expect(contact.company).toBe('Example Corp');
        expect(contact.jobTitle).toBe('Engineer');
        expect(contact.birthday).toBe('1990-01-02');
        expect(contact.address).toEqual([]);
        expect(contact.labels).toEqual([]);
        expect(contact.avatar).toBeUndefined();
    });

    test('a card with no UID gets an empty id rather than an invented one', () => {
        const parsed = parseVCard(vcard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Jane Doe', 'END:VCARD']));

        expect(parsedCardToContact(parsed).contact.id).toBe('');
    });

    test('an inline photo becomes a data: URI carrying the media type the card declared', () => {
        const { contact } = parsedCardToContact(card(`PHOTO;ENCODING=b;TYPE=PNG:${PNG}`));

        expect(contact.avatar).toBe(`data:image/png;base64,${PNG}`);
    });

    test('an inline photo without a declared type falls back to image/jpeg, like the server cache does', () => {
        const { contact } = parsedCardToContact(card(`PHOTO;ENCODING=b:${PNG}`));

        expect(contact.avatar).toBe(`data:image/jpeg;base64,${PNG}`);
    });

    test('a uri photo is dropped — a preview never fetches a URL an untrusted card chose', () => {
        const { contact } = parsedCardToContact(card('PHOTO;VALUE=URI:https://example.com/jane.jpg'));

        expect(contact.avatar).toBeUndefined();
    });

    test('an inline photo that is not an image is dropped, whatever it declares', () => {
        const { contact } = parsedCardToContact(card(`PHOTO:data:text/html;base64,${PNG}`));

        expect(contact.avatar).toBeUndefined();
    });

    test('categories are returned beside the contact, never as its labels', () => {
        const { contact, categories } = parsedCardToContact(card('CATEGORIES:Friends,Work'));

        expect(categories).toEqual(['Friends', 'Work']);
        expect(contact.labels).toEqual([]);
    });
});
