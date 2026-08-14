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

// Wrap a single content line in a minimal valid vCard so it can go through the public parser.
const parseCard = (line: string) => parseVCardLines(`BEGIN:VCARD\r\nVERSION:3.0\r\n${line}\r\nEND:VCARD\r\n`);

// Apple-Contacts-shaped vCard 3.0: N/FN, two folded properties (TITLE, NOTE), a grouped
// item1.EMAIL + item1.X-ABLabel pair, an X-SOCIALPROFILE, and a base64 PHOTO folded across 5
// physical lines. Built by joining physical lines with real CRLFs so nothing normalizes them.
const APPLE_FIXTURE =
    [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'PRODID:-//Apple Inc.//macOS 14.5//EN',
        'N:Doe;John;Quinlan;;',
        'FN:John Quinlan Doe',
        'ORG:Example Corporation;Reliability Engineering',
        'TITLE:Principal Engineer of Distributed Systems and Site Reliability Engi',
        ' neering Platforms',
        'item1.EMAIL;type=INTERNET;type=pref:john.quinlan.doe@example.com',
        'item1.X-ABLabel:_$!<Work>!$_',
        'X-SOCIALPROFILE;type=twitter:https://twitter.com/johnqdoe',
        'NOTE:Met at the 2026 distributed-systems summit in Utrecht; follow up abo',
        ' ut the CardDAV sync proposal next quarter.',
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
