import { describe, expect, test } from 'bun:test';
import { IMPORT_MAX_CARDS, VCARD_PREVIEW_MAX_CARDS } from '@workspace/lib/constants/contact';
import { ApiError } from '../../lib/core/errors';
import { toTransferableBuffer, toTransferableText } from '../../lib/document/transform/protocol';
import { buildVCardPreviewPayload } from '../../lib/preview/vcard-preview';

// The payload the quick look and the drive hero both read. Every value in it came from an untrusted
// file, so the only reference that survives is an inline PHOTO turned into a data: URI — a
// PHOTO;VALUE=URI is never emitted, and the file cannot make a viewer fetch a URL it chose.

// A vCard is CRLF-joined and CRLF-terminated; fixtures are written as physical lines.
const vcard = (lines: string[]) => `${lines.join('\r\n')}\r\n`;
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const JPEG = toBase64(new Uint8Array([255, 216, 255, 224]));

const card = (fn: string, ...extra: string[]) =>
    vcard([
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:${fn.split(' ')[1]};${fn.split(' ')[0]};;;`,
        `FN:${fn}`,
        ...extra,
        'END:VCARD',
    ]);

const payloadOf = (text: string) => buildVCardPreviewPayload(toTransferableText(text));

describe('buildVCardPreviewPayload', () => {
    test('every card reaches the payload, an inline photo becomes an avatar and a named URL never does', () => {
        const payload = payloadOf(
            card('Jane Doe', 'EMAIL:jane@example.com', `PHOTO;ENCODING=b;TYPE=JPEG:${JPEG}`) +
                vcard([
                    'BEGIN:VCARD',
                    'VERSION:4.0',
                    'N:Roe;Richard;;;',
                    'FN:Richard Roe',
                    `PHOTO:data:image/jpeg;base64,${JPEG}`,
                    'END:VCARD',
                ]) +
                card('Sam Small', 'PHOTO;VALUE=URI:https://evil.example/beacon.jpg'),
        );

        expect(payload.cards.map((c) => `${c.contact.firstName} ${c.contact.lastName}`)).toEqual([
            'Jane Doe',
            'Richard Roe',
            'Sam Small',
        ]);
        expect(payload.cards[0].contact.avatar).toBe(`data:image/jpeg;base64,${JPEG}`);
        expect(payload.cards[1].contact.avatar).toBe(`data:image/jpeg;base64,${JPEG}`);
        expect(payload.cards[2].contact.avatar).toBeUndefined();
        expect(JSON.stringify(payload)).not.toContain('evil.example');
    });

    test('every field a card carries reaches the payload', () => {
        const { contact, categories } = payloadOf(
            card(
                'Jane Doe',
                'EMAIL:jane@example.com',
                'TEL:+31612345678',
                'ORG:Example Corp',
                'TITLE:Engineer',
                'ADR:;;Main Street 1;Amsterdam;;1011AA;NL',
                'BDAY:1990-01-02',
                'NOTE:Met at the conference',
                'CATEGORIES:Work,Friends',
            ),
        ).cards[0];

        expect(contact.email).toEqual(['jane@example.com']);
        expect(contact.phone).toEqual(['+31612345678']);
        expect(contact.company).toBe('Example Corp');
        expect(contact.jobTitle).toBe('Engineer');
        expect(contact.address).toEqual([
            { street: 'Main Street 1', city: 'Amsterdam', zipCode: '1011AA', country: 'NL' },
        ]);
        expect(contact.birthday).toBe('1990-01-02');
        expect(contact.notes).toBe('Met at the conference');
        expect(categories).toEqual(['Work', 'Friends']);
    });

    test('a card the parser refuses is counted, never fails the file', () => {
        const broken = vcard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Broken', 'NO-COLON-HERE', 'END:VCARD']);
        const payload = payloadOf(card('Jane Doe') + broken + card('Sam Small'));

        expect(payload.cards.map((c) => c.contact.firstName)).toEqual(['Jane', 'Sam']);
        expect(payload.dropped).toBe(1);
        expect(payload.total).toBe(3);
    });

    test('a long address book carries the first 200 cards and reports what the file holds', () => {
        const payload = payloadOf(Array.from({ length: 250 }, (_, i) => card(`Person ${i}`)).join(''));

        expect(payload.cards.length).toBe(VCARD_PREVIEW_MAX_CARDS);
        expect(payload.total).toBe(250);
        expect(payload.dropped).toBe(0);
    });

    test('no more cards are parsed than an import would accept', () => {
        const broken = vcard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Broken', 'NO-COLON-HERE', 'END:VCARD']);
        const payload = payloadOf(broken.repeat(IMPORT_MAX_CARDS + 5));

        expect(payload.dropped).toBe(IMPORT_MAX_CARDS);
        expect(payload.total).toBe(IMPORT_MAX_CARDS + 5);
    });

    test('a file that is not UTF-8 is a controlled failure, not a throw the runner reports as a crash', () => {
        const read = () => buildVCardPreviewPayload(toTransferableBuffer(new Uint8Array([0xff, 0xfe, 0x41])));

        expect(read).toThrow(new ApiError(422, 'Could not read this file'));
    });

    test('a file holding no card is an empty payload', () => {
        expect(payloadOf('')).toEqual({ cards: [], dropped: 0, total: 0 });
    });
});
