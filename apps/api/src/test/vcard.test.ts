// vCard content-line AST (RFC 2426 / RFC 6350 §3) — parsing, serialization, and byte-preserving
// round-trip. All Phase-1 CardDAV vCard tasks extend this file.
import { describe, expect, test } from 'bun:test';
import {
    escapeText,
    getVersion,
    makeLine,
    parseVCardLines,
    serializeVCardLines,
    unescapeText,
    VCardError,
} from '../lib/carddav/vcard-ast';
import { parseVCard } from '../lib/carddav/vcard-parse';

// Wrap a single content line in a minimal valid vCard so it can go through the public parser.
const parseCard = (line: string) => parseVCardLines(`BEGIN:VCARD\r\nVERSION:3.0\r\n${line}\r\nEND:VCARD\r\n`);

// Apple-Contacts-shaped vCard 3.0: UID, N/FN, ORG, two folded properties (TITLE, NOTE), a grouped
// item1.EMAIL + item1.X-ABLabel pair, two TEL and two ADR lines, an X-SOCIALPROFILE, BDAY, CATEGORIES,
// X-EIGEN-ID, and a base64 PHOTO folded across 5 physical lines. Built by joining physical lines with
// real CRLFs so nothing normalizes them.
const APPLE_FIXTURE =
    [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'PRODID:-//Apple Inc.//macOS 14.5//EN',
        'UID:john-quinlan-doe-1234',
        'N:Doe;John;Quinlan;;',
        'FN:John Quinlan Doe',
        'ORG:Example Corporation;Reliability Engineering',
        'TITLE:Principal Engineer of Distributed Systems and Site Reliability Engi',
        ' neering Platforms',
        'item1.EMAIL;type=INTERNET;type=pref:john.quinlan.doe@example.com',
        'item1.X-ABLabel:_$!<Work>!$_',
        'TEL;type=CELL;type=pref:+31 6 12345678',
        'TEL;type=HOME:+31 30 1234567',
        'ADR;type=HOME:;;123 Main St;Springfield;IL;62704;USA',
        'ADR;type=WORK:;;1 Market Sq;Utrecht;;3500;Netherlands',
        'X-SOCIALPROFILE;type=twitter:https://twitter.com/johnqdoe',
        'NOTE:Met at the 2026 distributed-systems summit in Utrecht; follow up abo',
        ' ut the CardDAV sync proposal next quarter.',
        'BDAY:1973-10-03',
        'CATEGORIES:Engineering,Utrecht',
        'X-EIGEN-ID:eig_abc123',
        'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBw',
        ' cJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zND',
        ' L/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjI',
        ' yMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAEC',
        ' AwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII',
        'END:VCARD',
    ].join('\r\n') + '\r\n';

describe('vCard content-line AST', () => {
    test('unfolds a continuation, consuming only the single leading whitespace char', () => {
        const oneSpace = parseCard('NOTE:ab\r\n cd');
        expect(oneSpace.find((l) => l.name === 'NOTE')!.value).toBe('abcd');
        const twoSpace = parseCard('NOTE:ab\r\n  cd');
        expect(twoSpace.find((l) => l.name === 'NOTE')!.value).toBe('ab cd');
    });

    test('parses group and repeated params', () => {
        const email = parseCard('item1.EMAIL;TYPE=INTERNET;TYPE=pref:foo@bar.com').find((l) => l.name === 'EMAIL')!;
        expect(email.group).toBe('item1');
        expect(email.name).toBe('EMAIL');
        expect(email.params).toEqual([
            ['TYPE', 'INTERNET'],
            ['TYPE', 'pref'],
        ]);
        expect(email.value).toBe('foo@bar.com');
    });

    test('keeps a comma and colon inside a quoted param value', () => {
        const tel = parseCard('TEL;TYPE="cell,voice":+31 6 12345678').find((l) => l.name === 'TEL')!;
        expect(tel.params).toEqual([['TYPE', 'cell,voice']]);
        expect(tel.value).toBe('+31 6 12345678');
    });

    test('escapeText escapes backslash, semicolon, comma, and newline; unescapeText inverts it', () => {
        const raw = 'a;b,c\\d\ne';
        expect(escapeText(raw)).toBe('a\\;b\\,c\\\\d\\ne');
        expect(unescapeText(escapeText(raw))).toBe(raw);
    });

    test('serializeVCardLines reproduces an untouched Apple card byte-for-byte', () => {
        expect(serializeVCardLines(parseVCardLines(APPLE_FIXTURE))).toBe(APPLE_FIXTURE);
    });

    test('getVersion returns the VERSION value', () => {
        expect(getVersion(parseVCardLines(APPLE_FIXTURE))).toBe('3.0');
    });

    test('rejects two concatenated vCards', () => {
        const two = `${APPLE_FIXTURE}${APPLE_FIXTURE}`;
        expect(() => parseVCardLines(two)).toThrow(VCardError);
        expect(() => parseVCardLines(two)).toThrow('multiple');
    });

    test('rejects text without BEGIN:VCARD', () => {
        expect(() => parseVCardLines('FN:John Doe\r\nEND:VCARD\r\n')).toThrow(VCardError);
        expect(() => parseVCardLines('FN:John Doe\r\nEND:VCARD\r\n')).toThrow('BEGIN');
    });

    test('a built line over 75 octets folds and re-parses to the same value (UTF-8 safe)', () => {
        // é (2 bytes) sits right on the 75-octet boundary of `NOTE:` + value, so a naive byte split
        // would cut it in half.
        const longText = `${'x'.repeat(69)}é${'y'.repeat(40)}`;
        const serialized = serializeVCardLines([
            makeLine('BEGIN', 'VCARD'),
            makeLine('VERSION', '3.0'),
            makeLine('NOTE', escapeText(longText)),
            makeLine('END', 'VCARD'),
        ]);
        expect(serialized).toContain('\r\n ');

        const note = parseVCardLines(serialized).find((l) => l.name === 'NOTE')!;
        expect(unescapeText(note.value)).toBe(longText);
    });
});

// Wrap a single content line in a minimal valid vCard and map it down to the projection.
const parseLineCard = (line: string) => parseVCard(`BEGIN:VCARD\r\nVERSION:3.0\r\n${line}\r\nEND:VCARD\r\n`);

describe('vCard projection parse', () => {
    test('maps a full Apple card to every projection field', () => {
        const card = parseVCard(APPLE_FIXTURE);
        expect(card.version).toBe('3.0');
        expect(card.uid).toBe('john-quinlan-doe-1234');
        expect(card.firstName).toBe('John');
        expect(card.lastName).toBe('Doe');
        expect(card.email).toEqual(['john.quinlan.doe@example.com']);
        expect(card.phone).toEqual(['+31 6 12345678', '+31 30 1234567']);
        expect(card.company).toBe('Example Corporation');
        expect(card.jobTitle).toBe(
            'Principal Engineer of Distributed Systems and Site Reliability Engineering Platforms',
        );
        expect(card.address).toEqual([
            { street: '123 Main St', city: 'Springfield', state: 'IL', zipCode: '62704', country: 'USA' },
            { street: '1 Market Sq', city: 'Utrecht', zipCode: '3500', country: 'Netherlands' },
        ]);
        expect(card.birthday).toBe('1973-10-03');
        expect(card.notes).toBe(
            'Met at the 2026 distributed-systems summit in Utrecht; follow up about the CardDAV sync proposal next quarter.',
        );
        expect(card.categories).toEqual(['Engineering', 'Utrecht']);
        expect(card.eigenId).toBe('eig_abc123');
        expect(card.isGroup).toBe(false);
        expect(card.photo).toEqual({ kind: 'inline', bytes: expect.any(Uint8Array), mediaType: 'image/jpeg' });
    });

    test('falls back to splitting FN when N is absent', () => {
        const card = parseLineCard('FN:Ada Lovelace King');
        expect(card.firstName).toBe('Ada');
        expect(card.lastName).toBe('Lovelace King');
    });

    test('comma-splits CATEGORIES respecting escaped commas', () => {
        expect(parseLineCard('CATEGORIES:Friends,Wo\\,rk').categories).toEqual(['Friends', 'Wo,rk']);
    });

    test('reads a group card via X-ADDRESSBOOKSERVER-KIND', () => {
        expect(parseLineCard('X-ADDRESSBOOKSERVER-KIND:group').isGroup).toBe(true);
    });

    test('decodes an inline base64 PHOTO to its bytes', () => {
        const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128]);
        const b64 = Buffer.from(bytes).toString('base64');
        expect(parseLineCard(`PHOTO;ENCODING=b;TYPE=JPEG:${b64}`).photo).toEqual({
            kind: 'inline',
            bytes: Buffer.from(b64, 'base64'),
            mediaType: 'image/jpeg',
        });
    });

    test('reads a PHOTO URI reference as a uri photo', () => {
        expect(parseLineCard('PHOTO;VALUE=URI:https://example.com/p.jpg').photo).toEqual({
            kind: 'uri',
            uri: 'https://example.com/p.jpg',
        });
    });

    test('normalizes a compact BDAY to YYYY-MM-DD', () => {
        expect(parseLineCard('BDAY:19850412').birthday).toBe('1985-04-12');
    });
});
