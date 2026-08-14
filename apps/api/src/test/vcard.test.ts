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
import { createVCard, mergeVCard } from '../lib/carddav/vcard-serialize';
import { transcodeTo30 } from '../lib/carddav/vcard-transcode';

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

describe('vCard merge + builder', () => {
    test('a name-only edit leaves every typed TEL/EMAIL/ADR/X- line byte-identical', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { firstName: 'Bob' });
        // The owned name lines are rewritten from the projection...
        expect(out).toContain('N:Doe;Bob;;;');
        expect(out).toContain('FN:Bob Doe');
        expect(out).not.toContain('N:Doe;John;Quinlan;;');
        expect(out).not.toContain('FN:John Quinlan Doe');
        // ...every other typed line keeps its exact source bytes — lower-case params and grouping intact.
        for (const line of [
            'TEL;type=CELL;type=pref:+31 6 12345678',
            'TEL;type=HOME:+31 30 1234567',
            'item1.EMAIL;type=INTERNET;type=pref:john.quinlan.doe@example.com',
            'item1.X-ABLabel:_$!<Work>!$_',
            'ADR;type=HOME:;;123 Main St;Springfield;IL;62704;USA',
            'ADR;type=WORK:;;1 Market Sq;Utrecht;;3500;Netherlands',
            'X-SOCIALPROFILE;type=twitter:https://twitter.com/johnqdoe',
        ]) {
            expect(out).toContain(line);
        }
    });

    test('removing a grouped email value also drops its orphaned X-ABLabel', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { email: [] });
        expect(out).not.toContain('item1.EMAIL');
        expect(out).not.toContain('X-ABLabel');
        // A grouped-less X- line is not collateral damage.
        expect(out).toContain('X-SOCIALPROFILE;type=twitter:https://twitter.com/johnqdoe');
    });

    test('removing one of two values keeps the other line byte-for-byte', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { phone: ['+31 30 1234567'] });
        expect(out).toContain('TEL;type=HOME:+31 30 1234567');
        expect(out).not.toContain('+31 6 12345678');
    });

    test('adding an email appends a bare EMAIL line before END:VCARD', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), {
            email: ['john.quinlan.doe@example.com', 'bob@example.com'],
        });
        expect(out).toContain('item1.EMAIL;type=INTERNET;type=pref:john.quinlan.doe@example.com');
        expect(out).toContain('\r\nEMAIL:bob@example.com\r\n');
        expect(out.indexOf('EMAIL:bob@example.com')).toBeLessThan(out.indexOf('END:VCARD'));
    });

    test('a categories edit writes an RFC-escaped CATEGORIES line', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { categories: ['A,B', 'C'] });
        expect(out).toContain('CATEGORIES:A\\,B,C');
        expect(out).not.toContain('CATEGORIES:Engineering,Utrecht');
    });

    test('a photo edit writes a folded ENCODING=b PHOTO that decodes back to the input bytes', () => {
        const bytes = Uint8Array.from({ length: 120 }, (_, i) => (i * 7) % 256);
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { photo: { bytes, mediaType: 'image/jpeg' } });
        expect(out).toContain('PHOTO;ENCODING=b;TYPE=JPEG:');
        expect(out.slice(out.indexOf('PHOTO;ENCODING=b;TYPE=JPEG:'))).toContain('\r\n '); // long base64 folds
        expect(parseVCard(out).photo).toEqual({ kind: 'inline', bytes: Buffer.from(bytes), mediaType: 'image/jpeg' });
    });

    test('photo: null removes the PHOTO line', () => {
        expect(mergeVCard(parseVCard(APPLE_FIXTURE), { photo: null })).not.toContain('PHOTO');
    });

    test('merging with no edits reproduces the stored card byte-for-byte', () => {
        expect(mergeVCard(parseVCard(APPLE_FIXTURE), {})).toBe(APPLE_FIXTURE);
        const edited = mergeVCard(parseVCard(APPLE_FIXTURE), { firstName: 'Bob' });
        expect(mergeVCard(parseVCard(edited), {})).toBe(edited);
    });

    test('the REST seam echoing the full projection with unchanged values is a byte-for-byte no-op', () => {
        // Task 8's updateContact sends every owned key on every save; value-keyed single-value merges must
        // rewrite nothing when the value is unchanged, or the ORG department and N middle name are lost.
        const card = parseVCard(APPLE_FIXTURE);
        const out = mergeVCard(card, {
            firstName: card.firstName,
            lastName: card.lastName,
            email: card.email,
            phone: card.phone,
            address: card.address,
            company: card.company,
            jobTitle: card.jobTitle,
            birthday: card.birthday,
            notes: card.notes,
            categories: card.categories,
            eigenId: card.eigenId,
        });
        expect(out).toBe(APPLE_FIXTURE);
    });

    test('a genuine company change keeps the existing ORG department component', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { company: 'NewCorp' });
        expect(out).toContain('ORG:NewCorp;Reliability Engineering');
        expect(out).not.toContain('ORG:Example Corporation');
    });

    test('unchanged names keep the N middle name byte-for-byte; a real change pays the pinned form', () => {
        const unchanged = mergeVCard(parseVCard(APPLE_FIXTURE), { firstName: 'John', lastName: 'Doe' });
        expect(unchanged).toContain('N:Doe;John;Quinlan;;');
        expect(unchanged).toContain('FN:John Quinlan Doe');

        const changed = mergeVCard(parseVCard(APPLE_FIXTURE), { lastName: 'Smith' });
        expect(changed).toContain('N:Smith;John;;;');
        expect(changed).toContain('FN:John Smith');
    });

    test('createVCard emits a minimal clean 3.0 card that parses back to its projection', () => {
        const bytes = Uint8Array.from({ length: 90 }, (_, i) => (i * 5) % 256);
        const uid = '9AE52DC7-B1D0-4EC6-A705-71F04F3B4E85';
        const text = createVCard(
            {
                firstName: 'Bob',
                lastName: 'Vance',
                email: ['bob@vance.com'],
                phone: ['+1 555 0100'],
                company: 'Vance Refrigeration',
                jobTitle: 'Owner',
                address: [{ street: '1 Cold St', city: 'Scranton', state: 'PA', zipCode: '18503', country: 'USA' }],
                birthday: '1970-01-02',
                notes: 'Fridge guy',
                categories: ['Work'],
                eigenId: 'eig_1',
                photo: { bytes, mediaType: 'image/png' },
            },
            uid,
        );
        expect(text.startsWith('BEGIN:VCARD\r\n')).toBe(true);
        expect(text).toContain('VERSION:3.0\r\n');
        expect(text).toContain('PRODID:-//Eigen//CardDAV//EN\r\n');
        expect(text).toContain(`UID:${uid}\r\n`);
        expect(text).toContain('X-EIGEN-ID:eig_1');
        expect(text.endsWith('END:VCARD\r\n')).toBe(true);

        const card = parseVCard(text);
        expect(card.version).toBe('3.0');
        expect(card.uid).toBe(uid);
        expect(card.firstName).toBe('Bob');
        expect(card.lastName).toBe('Vance');
        expect(card.email).toEqual(['bob@vance.com']);
        expect(card.phone).toEqual(['+1 555 0100']);
        expect(card.company).toBe('Vance Refrigeration');
        expect(card.jobTitle).toBe('Owner');
        expect(card.address).toEqual([
            { street: '1 Cold St', city: 'Scranton', state: 'PA', zipCode: '18503', country: 'USA' },
        ]);
        expect(card.birthday).toBe('1970-01-02');
        expect(card.notes).toBe('Fridge guy');
        expect(card.categories).toEqual(['Work']);
        expect(card.eigenId).toBe('eig_1');
        expect(card.photo).toEqual({ kind: 'inline', bytes: Buffer.from(bytes), mediaType: 'image/png' });
    });

    test('createVCard omits X-EIGEN-ID and PHOTO when not supplied', () => {
        const text = createVCard({ firstName: 'Ada', lastName: 'Lovelace', email: [], phone: [] }, 'uid-1');
        expect(text).not.toContain('X-EIGEN-ID');
        expect(text).not.toContain('PHOTO');
        expect(text).toContain('N:Lovelace;Ada;;;');
        expect(text).toContain('FN:Ada Lovelace');
    });
});

describe('vCard 4.0 -> 3.0 transcode', () => {
    // Thunderbird-102+ shape: VERSION:4.0, a data: URI PHOTO, a VALUE=uri TEL, and a grouped ITEM1.EMAIL.
    const photoBytes = Uint8Array.from({ length: 96 }, (_, i) => (i * 11) % 256);
    const photoB64 = Buffer.from(photoBytes).toString('base64');
    const THUNDERBIRD_FIXTURE =
        [
            'BEGIN:VCARD',
            'VERSION:4.0',
            'UID:urn:uuid:5c2a9e10-3d4b-4a2f-9c1e-7b6f0a1d2e3f',
            'FN:Grace Hopper',
            'N:Hopper;Grace;;;',
            'ITEM1.EMAIL;PREF=1:grace.hopper@example.com',
            'TEL;VALUE=uri;TYPE=cell:tel:+31 6 87654321',
            `PHOTO:data:image/jpeg;base64,${photoB64}`,
            'END:VCARD',
        ].join('\r\n') + '\r\n';

    test('transcodes a Thunderbird 4.0 card to 3.0 with an inline ENCODING=b photo', () => {
        const out = transcodeTo30(THUNDERBIRD_FIXTURE);
        const card = parseVCard(out);
        expect(card.version).toBe('3.0');
        expect(card.photo).toEqual({ kind: 'inline', bytes: Buffer.from(photoBytes), mediaType: 'image/jpeg' });
        expect(out).toContain('VERSION:3.0');
        expect(out).toContain('PHOTO;ENCODING=b;TYPE=JPEG:');
        expect(out).not.toContain('VERSION:4.0');
        expect(out).not.toContain('data:image/jpeg');
        // Lines we don't rewrite ride through verbatim — 4.0-only params and grouping included.
        expect(out).toContain('TEL;VALUE=uri;TYPE=cell:tel:+31 6 87654321');
        expect(out).toContain('ITEM1.EMAIL;PREF=1:grace.hopper@example.com');
    });

    test('leaves a 3.0 card untouched, returning the same reference', () => {
        expect(transcodeTo30(APPLE_FIXTURE)).toBe(APPLE_FIXTURE);
    });

    test('rewrites a remote 4.0 PHOTO to the 3.0 VALUE=uri form', () => {
        const input =
            [
                'BEGIN:VCARD',
                'VERSION:4.0',
                'FN:Remote Photo',
                'PHOTO;MEDIATYPE=image/png:https://example.com/p.png',
                'END:VCARD',
            ].join('\r\n') + '\r\n';
        const out = transcodeTo30(input);
        expect(out).toContain('PHOTO;VALUE=uri:https://example.com/p.png');
        expect(out).not.toContain('MEDIATYPE');
        expect(parseVCard(out).photo).toEqual({ kind: 'uri', uri: 'https://example.com/p.png' });
    });
});
