import { describe, expect, test } from 'bun:test';
import { IMPORT_MAX_CARDS } from '@workspace/lib/constants/contact';
import { toTransferableBuffer, toTransferableText } from '../../lib/document/transform/protocol';
import { renderVCardPreviewBody } from '../../lib/preview/vcard-render';

// A vCard preview body is injected as live DOM by the preview pane, and every byte in it came from an
// untrusted file: the names are escaped, and the only reference that survives is an inline PHOTO turned
// into a data: URI. A PHOTO;VALUE=URI is never emitted, so the file cannot make a viewer fetch a URL
// it chose.

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

const bodyOf = (text: string) => renderVCardPreviewBody(toTransferableText(text)).body;

describe('renderVCardPreviewBody', () => {
    test('renders every card, inlines an inline photo and fetches nothing a card names', () => {
        const body = bodyOf(
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

        expect(body).toContain('Jane Doe');
        expect(body).toContain('Richard Roe');
        expect(body).toContain('Sam Small');
        expect(body).toContain(`src="data:image/jpeg;base64,${JPEG}"`);
        expect(body).not.toContain('evil.example');
    });

    test('every field a card carries reaches the body, escaped', () => {
        const body = bodyOf(
            card(
                'Jane Doe',
                'EMAIL:jane@example.com',
                'TEL:+31612345678',
                'ORG:Example <Corp>',
                'TITLE:Engineer',
                'ADR:;;Main Street 1;Amsterdam;;1011AA;NL',
                'BDAY:1990-01-02',
                'NOTE:Met at the conference',
                'CATEGORIES:Work,Friends',
            ),
        );

        expect(body).toContain('jane@example.com');
        expect(body).toContain('+31612345678');
        expect(body).toContain('Example &lt;Corp&gt;');
        expect(body).toContain('Engineer');
        expect(body).toContain('Main Street 1, Amsterdam, 1011AA, NL');
        expect(body).toContain('Jan 2, 1990');
        expect(body).toContain('Met at the conference');
        expect(body).toContain('Work');
        expect(body).toContain('Friends');
    });

    test('a card the parser refuses is counted, never fails the file', () => {
        const broken = vcard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Broken', 'NO-COLON-HERE', 'END:VCARD']);
        const body = bodyOf(card('Jane Doe') + broken + card('Sam Small'));

        expect(body).toContain('Jane Doe');
        expect(body).toContain('Sam Small');
        expect(body).toContain('1 contact could not be read');
    });

    test('a long address book renders the first 200 cards and counts the rest', () => {
        const body = bodyOf(Array.from({ length: 250 }, (_, i) => card(`Person ${i}`)).join(''));

        expect(body.match(/class="vcard-card"/g)?.length).toBe(200);
        expect(body).toContain('and 50 more contacts');
    });

    test('a file that is not UTF-8 reads as a notice, not a throw', () => {
        const body = renderVCardPreviewBody(toTransferableBuffer(new Uint8Array([0xff, 0xfe, 0x41]))).body;

        expect(body).toContain('Could not read this file');
    });

    test('a file whose readable cards all fail still counts the ones it never looked at', () => {
        const broken = vcard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Broken', 'NO-COLON-HERE', 'END:VCARD']);
        const body = bodyOf(broken.repeat(IMPORT_MAX_CARDS + 5));

        expect(body).toContain(`${IMPORT_MAX_CARDS} contacts could not be read`);
        expect(body).toContain('and 5 more contacts');
    });

    test('a file holding no card says so', () => {
        expect(bodyOf('')).toContain('No contacts in this file');
    });
});
