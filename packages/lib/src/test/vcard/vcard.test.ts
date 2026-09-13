// vCard content-line AST (RFC 2426 / RFC 6350 §3) — parsing, the projection map, and the 4.0 -> 3.0
// transcode. The CardDAV-only seams (merge/create, addressbook-query, address-data) are tested beside
// them in apps/api/src/test/carddav/vcard.test.ts.
import { describe, expect, test } from 'bun:test';
import { escapeContentText } from '../../core/content-line';
import {
    getVersion,
    makeLine,
    parseVCard,
    parseVCardLines,
    serializeVCardLines,
    transcodeTo30,
    unescapeText,
    VCardError,
} from '../../vcard';

// Wrap a single content line in a minimal valid vCard so it can go through the public parser.
const parseCard = (line: string) => parseVCardLines(`BEGIN:VCARD\r\nVERSION:3.0\r\n${line}\r\nEND:VCARD\r\n`);

// A vCard is CRLF-joined and CRLF-terminated; fixtures are written as physical lines so folding is literal.
const vcard = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

// The encode side of the parser's atob decode — kept off Node globals, like the module it exercises.
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

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

// A 3.0 card whose labels are split across two CATEGORIES lines — the way external clients legitimately
// write them. The second line carries an escaped comma that must survive as a literal in one label name.
const TWO_CATEGORY_LINES = vcard([
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Multi Cat',
    'CATEGORIES:Friends,Work',
    'CATEGORIES:Chess\\,Club',
    'END:VCARD',
]);

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

    test('escapeContentText escapes backslash, semicolon, comma, and newline; unescapeText inverts it', () => {
        const raw = 'a;b,c\\d\ne';
        expect(escapeContentText(raw)).toBe('a\\;b\\,c\\\\d\\ne');
        expect(unescapeText(escapeContentText(raw))).toBe(raw);
    });

    test('escapeContentText drops a bare CR so a value cannot split into a new property line', () => {
        expect(escapeContentText('hi\rX-ANYTHING:v')).toBe('hiX-ANYTHING:v');
        expect(escapeContentText('a\r\nb')).toBe('a\\nb');
    });

    test('buildLine re-quotes and neuters param values so a rewritten line cannot be corrupted or injected', () => {
        const serialized = serializeVCardLines([
            makeLine('BEGIN', 'VCARD'),
            makeLine('VERSION', '3.0'),
            makeLine('NOTE', 'hello', [
                ['X-P', 'a:b'], // a colon would truncate the param section unless the value is re-quoted
                ['X-Q', 'c"d\r\nX-EVIL:1'], // a literal quote + CRLF must be neutered, not injected
            ]),
            makeLine('END', 'VCARD'),
        ]);
        expect(serialized).toContain(`NOTE;X-P="a:b";X-Q="c'dX-EVIL:1":hello`);
        expect(serialized).not.toContain('\r\nX-EVIL:1');

        // parse -> rewrite -> parse is stable: the re-quoted line re-parses to the same param values.
        const reparsed = parseVCardLines(serialized).find((l) => l.name === 'NOTE')!;
        expect(reparsed.params).toEqual([
            ['X-P', 'a:b'],
            ['X-Q', "c'dX-EVIL:1"],
        ]);
        expect(reparsed.value).toBe('hello');
    });

    test('blank lines in a card are skipped rather than throwing', () => {
        const withBlanks = 'BEGIN:VCARD\r\nVERSION:3.0\r\n\r\nFN:Blank Liner\r\nN:Liner;Blank;;;\r\nEND:VCARD\r\n\r\n';
        const card = parseVCard(withBlanks);
        expect(card.firstName).toBe('Blank');
        expect(card.lastName).toBe('Liner');
    });

    test('serializeVCardLines reproduces an untouched Apple card byte-for-byte', () => {
        expect(serializeVCardLines(parseVCardLines(APPLE_FIXTURE))).toBe(APPLE_FIXTURE);
    });

    test('getVersion returns the VERSION value', () => {
        expect(getVersion(parseVCardLines(APPLE_FIXTURE))).toBe('3.0');
    });

    test('an envelope marker frames the card exactly as splitVCards does', () => {
        // The splitter trims the end of a physical line, so a card whose BEGIN/END carries trailing
        // whitespace arrives here as one card and must parse rather than count as unreadable.
        const padded = 'BEGIN:VCARD \r\nVERSION:3.0\r\nFN:x\r\nUID:u\r\nEND:VCARD \r\n';
        expect(parseVCard(padded).uid).toBe('u');
        // Leading whitespace is not trimmed, for the same reason: the splitter opens no card on this line,
        // so a card the parser accepted here could not be re-imported from its own export.
        expect(() => parseVCardLines('BEGIN: VCARD\r\nVERSION:3.0\r\nUID:u\r\nEND:VCARD\r\n')).toThrow('BEGIN');
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

    test('rejects content outside the envelope and a second END:VCARD', () => {
        // Bytes outside BEGIN/END would be stored and re-served to every DAV client.
        expect(() => parseVCardLines(`X-STRAY:leading\r\n${APPLE_FIXTURE}`)).toThrow(VCardError);
        expect(() => parseVCardLines(`X-STRAY:leading\r\n${APPLE_FIXTURE}`)).toThrow('outside');
        expect(() => parseVCardLines(`${APPLE_FIXTURE}X-STRAY:trailing\r\n`)).toThrow('outside');
        expect(() => parseVCardLines(`${APPLE_FIXTURE}END:VCARD\r\n`)).toThrow(VCardError);
        expect(() => parseVCardLines(`${APPLE_FIXTURE}END:VCARD\r\n`)).toThrow('multiple END');
    });

    test('rejects a raw C0 control character but keeps a legitimate TAB', () => {
        // A C0 control byte (here BEL, 0x07) stored in a value makes every full-book REPORT invalid XML
        // client-side, wedging the whole account's sync — so it's refused at the parse seam.
        const withBel = vcard(['BEGIN:VCARD', 'VERSION:3.0', `NOTE:a${String.fromCharCode(7)}b`, 'END:VCARD']);
        expect(() => parseVCardLines(withBel)).toThrow(VCardError);
        // TAB (0x09) is legal in a TEXT value and in line folding, so a card carrying one still parses.
        const withTab = vcard(['BEGIN:VCARD', 'VERSION:3.0', `NOTE:a${String.fromCharCode(9)}b`, 'END:VCARD']);
        expect(() => parseVCardLines(withTab)).not.toThrow();
        expect(parseVCardLines(withTab).find((l) => l.name === 'NOTE')!.value).toBe(`a${String.fromCharCode(9)}b`);
    });

    test('a built line over 75 octets folds and re-parses to the same value (UTF-8 safe)', () => {
        // é (2 bytes) sits right on the 75-octet boundary of `NOTE:` + value, so a naive byte split
        // would cut it in half.
        const longText = `${'x'.repeat(69)}é${'y'.repeat(40)}`;
        const serialized = serializeVCardLines([
            makeLine('BEGIN', 'VCARD'),
            makeLine('VERSION', '3.0'),
            makeLine('NOTE', escapeContentText(longText)),
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

    test('aggregates every CATEGORIES line, preserving an escaped comma as a literal', () => {
        expect(parseVCard(TWO_CATEGORY_LINES).categories).toEqual(['Friends', 'Work', 'Chess,Club']);
    });

    test('reads a group card via X-ADDRESSBOOKSERVER-KIND', () => {
        expect(parseLineCard('X-ADDRESSBOOKSERVER-KIND:group').isGroup).toBe(true);
    });

    test('decodes an inline base64 PHOTO to its bytes', () => {
        const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128]);
        expect(parseLineCard(`PHOTO;ENCODING=b;TYPE=JPEG:${toBase64(bytes)}`).photo).toEqual({
            kind: 'inline',
            bytes,
            mediaType: 'image/jpeg',
        });
    });

    test('reads a PHOTO URI reference as a uri photo', () => {
        expect(parseLineCard('PHOTO;VALUE=URI:https://example.com/p.jpg').photo).toEqual({
            kind: 'uri',
            uri: 'https://example.com/p.jpg',
        });
    });

    test('a comma-less data: PHOTO degrades to no photo', () => {
        expect(parseLineCard('PHOTO:data:junk').photo).toBeNull();
    });

    test('normalizes a compact BDAY to YYYY-MM-DD', () => {
        expect(parseLineCard('BDAY:19850412').birthday).toBe('1985-04-12');
    });
});

describe('vCard 4.0 -> 3.0 transcode', () => {
    // Thunderbird-102+ shape: VERSION:4.0, a data: URI PHOTO, VALUE=uri TEL values carrying tel: URIs,
    // numeric PREF, an ISO-basic BDAY, plus a 4.0-only ANNIVERSARY and an Apple-style grouped EMAIL.
    const photoBytes = Uint8Array.from({ length: 96 }, (_, i) => (i * 11) % 256);
    const photoB64 = toBase64(photoBytes);
    const THUNDERBIRD_FIXTURE = vcard([
        'BEGIN:VCARD',
        'VERSION:4.0',
        'UID:urn:uuid:5c2a9e10-3d4b-4a2f-9c1e-7b6f0a1d2e3f',
        'FN:Grace Hopper',
        'N:Hopper;Grace;;;',
        'ITEM1.EMAIL;PREF=1:grace.hopper@example.com',
        'EMAIL;PREF=2:ghopper@navy.example',
        'TEL;VALUE=uri;TYPE=cell;PREF=1:tel:+31 6 87654321',
        'TEL;VALUE=uri;TYPE=work:tel:+31 30 1234567',
        'ORG:US Navy',
        'BDAY;VALUE=date:19061209',
        'ANNIVERSARY:19301215',
        `PHOTO:data:image/jpeg;base64,${photoB64}`,
        'END:VCARD',
    ]);

    test('transcodes a Thunderbird 4.0 card to 3.0 with an inline ENCODING=b photo', () => {
        const out = transcodeTo30(THUNDERBIRD_FIXTURE);
        const card = parseVCard(out);
        expect(card.version).toBe('3.0');
        expect(card.photo).toEqual({ kind: 'inline', bytes: photoBytes, mediaType: 'image/jpeg' });
        expect(out).toContain('VERSION:3.0');
        expect(out).toContain('PHOTO;ENCODING=b;TYPE=JPEG:');
        expect(out).not.toContain('VERSION:4.0');
        expect(out).not.toContain('data:image/jpeg');
    });

    test('maps 4.0 TEL URIs, numeric PREF and ISO-basic BDAY to their real 3.0 forms', () => {
        const out = transcodeTo30(THUNDERBIRD_FIXTURE);
        // A tel: URI is not a 3.0 phone-number value: strip the scheme, drop VALUE=uri, keep the TYPE.
        expect(out).toContain('TEL;TYPE=cell;TYPE=PREF:+31 6 87654321');
        expect(out).toContain('TEL;TYPE=work:+31 30 1234567');
        expect(out).not.toContain('tel:+31');
        expect(out).not.toContain('VALUE=uri');
        // PREF=n (lowest wins) has one 3.0 spelling, on one line per property.
        expect(out).toContain('ITEM1.EMAIL;TYPE=PREF:grace.hopper@example.com');
        expect(out).toContain('EMAIL:ghopper@navy.example');
        expect(out).not.toContain('PREF=');
        expect(out).toContain('BDAY;VALUE=date:1906-12-09');

        // ...and the stored card projects the way the web UI shows it.
        const card = parseVCard(out);
        expect(card.phone).toEqual(['+31 6 87654321', '+31 30 1234567']);
        expect(card.email).toEqual(['grace.hopper@example.com', 'ghopper@navy.example']);
        expect(card.birthday).toBe('1906-12-09');
    });

    test('rides unmappable 4.0 constructs through verbatim rather than rejecting the card', () => {
        const out = transcodeTo30(THUNDERBIRD_FIXTURE);
        expect(out).toContain('ANNIVERSARY:19301215'); // no 3.0 equivalent
        expect(out).toContain('ORG:US Navy');
        expect(out).toContain('UID:urn:uuid:5c2a9e10-3d4b-4a2f-9c1e-7b6f0a1d2e3f');

        // A year-less BDAY and a non-tel TEL URI have no 3.0 form either.
        const odd = transcodeTo30(
            'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Odd One\r\nBDAY:--1209\r\nTEL;VALUE=uri:sip:odd@example.com\r\nEND:VCARD\r\n',
        );
        expect(odd).toContain('BDAY:--1209');
        expect(odd).toContain('TEL;VALUE=uri:sip:odd@example.com');
    });

    test('leaves a 3.0 card untouched, returning the same reference', () => {
        expect(transcodeTo30(APPLE_FIXTURE)).toBe(APPLE_FIXTURE);
    });

    test('a comma-less data: PHOTO transcodes to the VALUE=uri form', () => {
        const out = transcodeTo30('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:No Comma\r\nPHOTO:data:junk\r\nEND:VCARD\r\n');
        expect(out).toContain('PHOTO;VALUE=uri:data:junk');
    });

    test('rewrites a remote 4.0 PHOTO to the 3.0 VALUE=uri form', () => {
        const input = vcard([
            'BEGIN:VCARD',
            'VERSION:4.0',
            'FN:Remote Photo',
            'PHOTO;MEDIATYPE=image/png:https://example.com/p.png',
            'END:VCARD',
        ]);
        const out = transcodeTo30(input);
        expect(out).toContain('PHOTO;VALUE=uri:https://example.com/p.png');
        expect(out).not.toContain('MEDIATYPE');
        expect(parseVCard(out).photo).toEqual({ kind: 'uri', uri: 'https://example.com/p.png' });
    });
});
