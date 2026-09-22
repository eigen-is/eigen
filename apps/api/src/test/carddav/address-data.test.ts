// The address-data partial projection (src/lib/carddav/address-data.ts): a REPORT that asks for a subset of
// properties gets those lines back verbatim, plus the mandatory skeleton, and nothing else.
import { describe, expect, test } from 'bun:test';
import { projectAddressData } from '../../lib/carddav/address-data';
import { parseVCardLines } from '../../lib/vcard';

// A vCard is CRLF-joined and CRLF-terminated; fixtures are written as physical lines so folding is literal.
const vcard = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

// Apple-Contacts-shaped vCard 3.0: UID, N/FN, ORG, two folded properties (TITLE, NOTE), a grouped
// item1.EMAIL + item1.X-ABLabel pair, two TEL and two ADR lines, an X-SOCIALPROFILE, BDAY, CATEGORIES,
// X-EIGEN-ID, and a base64 PHOTO folded across 5 physical lines. Built by joining physical lines with
// real CRLFs so nothing normalizes them.
const APPLE_FIXTURE = vcard([
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
]);

describe('address-data partial projection', () => {
    test('keeps the requested property, its grouped X- label, and the skeleton; drops the rest', () => {
        const out = projectAddressData(APPLE_FIXTURE, ['EMAIL']);
        // The requested property is byte-identical — lower-case params and grouping survive via the raw slice.
        expect(out).toContain('item1.EMAIL;type=INTERNET;type=pref:john.quinlan.doe@example.com');
        // Its same-group label rides along (Apple pairs item1.EMAIL with item1.X-ABLabel).
        expect(out).toContain('item1.X-ABLabel:_$!<Work>!$_');
        // The mandatory skeleton stays even though none of it was requested.
        expect(out).toContain('BEGIN:VCARD');
        expect(out).toContain('VERSION:3.0');
        expect(out).toContain('UID:john-quinlan-doe-1234');
        expect(out).toContain('N:Doe;John;Quinlan;;');
        expect(out).toContain('FN:John Quinlan Doe');
        expect(out).toContain('END:VCARD');
        // Everything unrequested is gone — including a group-less X- property and PRODID.
        for (const dropped of [
            'ORG:',
            'TITLE:',
            'TEL;',
            'ADR;',
            'NOTE:',
            'BDAY:',
            'CATEGORIES:',
            'X-EIGEN-ID:',
            'PHOTO;',
            'X-SOCIALPROFILE',
            'PRODID:',
        ]) {
            expect(out).not.toContain(dropped);
        }
        // The projection is itself a valid, parseable vCard envelope.
        expect(() => parseVCardLines(out)).not.toThrow();
    });

    test('a kept folded property keeps its fold bytes verbatim', () => {
        const out = projectAddressData(APPLE_FIXTURE, ['NOTE']);
        expect(out).toContain(
            'NOTE:Met at the 2026 distributed-systems summit in Utrecht; follow up abo\r\n ut the CardDAV sync proposal next quarter.',
        );
        expect(out).not.toContain('item1.EMAIL');
    });

    test('a grouped X- label is dropped when its anchor property is not requested', () => {
        const out = projectAddressData(APPLE_FIXTURE, ['TEL']);
        expect(out).toContain('TEL;type=CELL;type=pref:+31 6 12345678');
        expect(out).toContain('TEL;type=HOME:+31 30 1234567');
        expect(out).not.toContain('item1.EMAIL'); // EMAIL not requested → its group loses its anchor...
        expect(out).not.toContain('X-ABLabel'); // ...and the orphaned label goes with it
    });

    test('property names match case-insensitively', () => {
        const out = projectAddressData(APPLE_FIXTURE, ['email']);
        expect(out).toContain('item1.EMAIL;type=INTERNET;type=pref:john.quinlan.doe@example.com');
    });
});
