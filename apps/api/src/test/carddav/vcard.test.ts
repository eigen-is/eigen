// The CardDAV-only vCard seams: merging Eigen-owned edits back into a stored card, the addressbook-query
// matcher, and the address-data partial projection. The AST, projection parse and 4.0 -> 3.0 transcode are
// tested in packages/lib/src/test/vcard/vcard.test.ts.
import { describe, expect, test } from 'bun:test';
import { parseVCard, parseVCardLines } from '@workspace/lib/vcard';
import { projectAddressData } from '../../lib/carddav/address-data';
import {
    matchCard,
    type ParamFilter,
    type PropFilter,
    type QueryFilter,
    type TextMatch,
} from '../../lib/carddav/query-filter';
import { createVCard, mergeVCard } from '../../lib/carddav/vcard-serialize';

// A vCard is CRLF-joined and CRLF-terminated; fixtures are written as physical lines so folding is literal.
const vcard = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

// True if any C0 control byte other than the three XML-legal ones (TAB/CR/LF) survives in the text — the
// bytes that make an address-data REPORT invalid XML client-side.
const hasDisallowedC0 = (s: string) =>
    [...s].some((ch) => {
        const c = ch.charCodeAt(0);
        return c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;
    });

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

describe('vCard merge + builder', () => {
    test('a name-only edit leaves every typed TEL/EMAIL/ADR/X- line byte-identical', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { firstName: 'Bob' });
        // The owned name components (family, given) are rewritten; the unowned N tail (Quinlan) rides through.
        expect(out).toContain('N:Doe;Bob;Quinlan;;');
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

    test('removing one of two addresses keeps the other ADR line byte-for-byte', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), {
            address: [{ street: '123 Main St', city: 'Springfield', state: 'IL', zipCode: '62704', country: 'USA' }],
        });
        expect(out).toContain('ADR;type=HOME:;;123 Main St;Springfield;IL;62704;USA');
        expect(out).not.toContain('1 Market Sq');
    });

    test('a notes edit with a bare CR cannot inject a new property line', () => {
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { notes: 'hi\rX-EVIL:1' });
        expect(out).not.toContain('\r\nX-EVIL:1');
        const reparsed = parseVCard(out);
        expect(reparsed.notes).toBe('hiX-EVIL:1');
        expect(reparsed.lines.filter((l) => l.name === 'X-EVIL')).toHaveLength(0);
    });

    test('a C0 control byte in a notes edit is stripped, keeping a legitimate TAB', () => {
        // A pasted vertical tab (0x0B) is not valid XML character data; echoed into an address-data REPORT it
        // renders that XML invalid client-side and wedges the account's sync. It is scrubbed at the escape seam
        // (TAB stays — it is legal in a TEXT value), so the merged card round-trips and the parse-seam C0 guard
        // accepts it.
        const vt = String.fromCharCode(0x0b);
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { notes: `a${vt}b${String.fromCharCode(9)}c` });
        expect(hasDisallowedC0(out)).toBe(false);
        expect(() => parseVCardLines(out)).not.toThrow();
        expect(parseVCard(out).notes).toBe(`ab${String.fromCharCode(9)}c`); // VT dropped, TAB preserved
    });

    test('createVCard strips a C0 control byte from notes', () => {
        const created = createVCard(
            { firstName: 'A', lastName: 'B', email: [], phone: [], notes: `x${String.fromCharCode(0x0b)}y` },
            'uid-c0',
        );
        expect(hasDisallowedC0(created)).toBe(false);
        expect(() => parseVCardLines(created)).not.toThrow();
        expect(parseVCard(created).notes).toBe('xy');
    });

    test('a birthday that is not a strict YYYY-MM-DD is treated as a clear, never written or injected', () => {
        const inject = mergeVCard(parseVCard(APPLE_FIXTURE), { birthday: '1990-01-01\r\nX-EVIL:1' });
        expect(inject).not.toContain('X-EVIL');
        expect(inject).not.toContain('1990-01-01');
        expect(inject).not.toContain('BDAY'); // treated as a clear -> the existing BDAY line is removed

        const garbage = mergeVCard(parseVCard(APPLE_FIXTURE), { birthday: 'not-a-date' });
        expect(garbage).not.toContain('BDAY');

        const created = createVCard(
            { firstName: 'A', lastName: 'B', email: [], phone: [], birthday: 'not-a-date' },
            'uid-bday',
        );
        expect(created).not.toContain('BDAY');
    });

    test('editing a field whose line carried a quoted param re-quotes it instead of corrupting the line', () => {
        const card = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE;X-P="a:b":old note\r\nEND:VCARD\r\n');
        const out = mergeVCard(card, { notes: 'new note' });
        expect(out).toContain('NOTE;X-P="a:b":new note');
        const reparsed = parseVCard(out);
        expect(reparsed.notes).toBe('new note');
        expect(reparsed.lines.find((l) => l.name === 'NOTE')!.params).toEqual([['X-P', 'a:b']]);
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

    test('merging the same multiset of categories spread across lines leaves the card byte-identical', () => {
        const out = mergeVCard(parseVCard(TWO_CATEGORY_LINES), { categories: ['Chess,Club', 'Friends', 'Work'] });
        expect(out).toBe(TWO_CATEGORY_LINES);
    });

    test('dropping a category that lived on the second line collapses CATEGORIES to one line', () => {
        const out = mergeVCard(parseVCard(TWO_CATEGORY_LINES), { categories: ['Friends', 'Work'] });
        expect(parseVCardLines(out).filter((l) => l.name === 'CATEGORIES')).toHaveLength(1);
        expect(out).toContain('CATEGORIES:Friends,Work');
        expect(out).not.toContain('Chess');
    });

    test('editing a repeatable owned property replaces every line of that name', () => {
        // CATEGORIES and NOTE are legally repeatable in 3.0, but an owned edit replaces the whole property, so
        // no repeated line survives to drift from what the app just wrote — whether the projection aggregated
        // every line (CATEGORIES) or kept only the first (NOTE).
        const repeated =
            'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Two Liner\r\nCATEGORIES:Friends\r\nCATEGORIES:Work\r\nNOTE:first\r\nNOTE:second\r\nEND:VCARD\r\n';

        const labelled = mergeVCard(parseVCard(repeated), { categories: ['Friends', 'Colleagues'] });
        expect(parseVCardLines(labelled).filter((l) => l.name === 'CATEGORIES')).toHaveLength(1);
        expect(labelled).toContain('CATEGORIES:Friends,Colleagues');
        // An untouched repeatable property keeps both of its lines.
        expect(parseVCardLines(labelled).filter((l) => l.name === 'NOTE')).toHaveLength(2);

        const noted = mergeVCard(parseVCard(repeated), { notes: 'merged' });
        expect(parseVCardLines(noted).filter((l) => l.name === 'NOTE')).toHaveLength(1);
        expect(noted).toContain('NOTE:merged');
        expect(parseVCardLines(noted).filter((l) => l.name === 'CATEGORIES')).toHaveLength(2);
    });

    test('a photo edit writes a folded ENCODING=b PHOTO that decodes back to the input bytes', () => {
        const bytes = Uint8Array.from({ length: 120 }, (_, i) => (i * 7) % 256);
        const out = mergeVCard(parseVCard(APPLE_FIXTURE), { photo: { bytes, mediaType: 'image/jpeg' } });
        expect(out).toContain('PHOTO;ENCODING=b;TYPE=JPEG:');
        expect(out.slice(out.indexOf('PHOTO;ENCODING=b;TYPE=JPEG:'))).toContain('\r\n '); // long base64 folds
        expect(parseVCard(out).photo).toEqual({ kind: 'inline', bytes, mediaType: 'image/jpeg' });
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
        // updateContact sends every owned key on every save; value-keyed single-value merges must
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

    test('unchanged names keep the N middle name byte-for-byte; a real change preserves the unowned N tail', () => {
        const unchanged = mergeVCard(parseVCard(APPLE_FIXTURE), { firstName: 'John', lastName: 'Doe' });
        expect(unchanged).toContain('N:Doe;John;Quinlan;;');
        expect(unchanged).toContain('FN:John Quinlan Doe');

        // A real rename rewrites only family+given; the additional name (Quinlan) rides through untouched.
        const changed = mergeVCard(parseVCard(APPLE_FIXTURE), { lastName: 'Smith' });
        expect(changed).toContain('N:Smith;John;Quinlan;;');
        expect(changed).toContain('FN:John Smith');
    });

    test('a real name change preserves the unowned N tail (additional name, honorific prefix, suffix)', () => {
        // An Apple contact carries five N components; Eigen owns only family+given. Renaming in the web app must
        // not silently drop the middle name, prefix, or suffix from the phone on next sync — mirrors ORG's
        // department preservation.
        const card = vcard([
            'BEGIN:VCARD',
            'VERSION:3.0',
            'N:Doe;John;Quincy;Dr.;Jr.',
            'FN:Dr. John Quincy Doe Jr.',
            'END:VCARD',
        ]);
        const out = mergeVCard(parseVCard(card), { firstName: 'Jane', lastName: 'Smith' });
        expect(out).toContain('N:Smith;Jane;Quincy;Dr.;Jr.');
        expect(out).toContain('FN:Jane Smith');
        expect(out).not.toContain('N:Doe;John;Quincy;Dr.;Jr.');
    });

    test('a short N (only family+given) is rewritten with the clean five-component shape', () => {
        // With fewer than two component separators there is no tail to preserve, so it falls back to `;;;`.
        const card = vcard(['BEGIN:VCARD', 'VERSION:3.0', 'N:Doe;John', 'FN:John Doe', 'END:VCARD']);
        const out = mergeVCard(parseVCard(card), { lastName: 'Smith' });
        expect(out).toContain('N:Smith;John;;;');
    });

    test('an escaped semicolon in an owned N component does not shift the preserved tail', () => {
        // firstUnescapedSemi skips '\;', so the real family|given boundary is found even when the family name
        // carries one — the tail (Quincy) is sliced from the second true separator, not the escaped one.
        const card = vcard(['BEGIN:VCARD', 'VERSION:3.0', 'N:Do\\;e;John;Quincy;;', 'FN:John Do;e', 'END:VCARD']);
        const out = mergeVCard(parseVCard(card), { firstName: 'Jane', lastName: 'Smith' });
        expect(out).toContain('N:Smith;Jane;Quincy;;');
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
        expect(card.photo).toEqual({ kind: 'inline', bytes, mediaType: 'image/png' });
    });

    test('an eigenId carrying a CR/LF cannot inject a second vCard (create + merge strip it)', () => {
        const created = createVCard(
            { firstName: 'A', lastName: 'B', email: [], phone: [], eigenId: 'x\r\nBEGIN:VCARD' },
            'uid-inject',
        );
        // Parses as exactly ONE vCard (a leaked BEGIN would throw 'multiple') with a single sanitized line.
        expect(parseVCard(created).eigenId).toBe('xBEGIN:VCARD');
        expect(parseVCardLines(created).filter((l) => l.name === 'X-EIGEN-ID')).toHaveLength(1);

        const merged = mergeVCard(parseVCard(APPLE_FIXTURE), { eigenId: 'x\r\nBEGIN:VCARD' });
        expect(parseVCard(merged).eigenId).toBe('xBEGIN:VCARD');
        expect(parseVCardLines(merged).filter((l) => l.name === 'X-EIGEN-ID')).toHaveLength(1);
    });

    test('createVCard omits X-EIGEN-ID and PHOTO when not supplied', () => {
        const text = createVCard({ firstName: 'Ada', lastName: 'Lovelace', email: [], phone: [] }, 'uid-1');
        expect(text).not.toContain('X-EIGEN-ID');
        expect(text).not.toContain('PHOTO');
        expect(text).toContain('N:Lovelace;Ada;;;');
        expect(text).toContain('FN:Ada Lovelace');
    });
});

describe('addressbook-query matcher', () => {
    // The matcher runs over the content-line AST, so tests parse a card to VCardLine[] and build QueryFilter
    // objects directly — parsing the XML into these types is covered by the carddav integration suite.
    const linesOf = (body: string[]) => parseVCardLines(vcard(['BEGIN:VCARD', 'VERSION:3.0', ...body, 'END:VCARD']));
    const text = (over: Partial<TextMatch> & { value: string }): TextMatch => ({
        collation: null,
        matchType: 'contains',
        negate: false,
        ...over,
    });
    const prop = (over: Partial<PropFilter> & { name: string }): PropFilter => ({
        test: 'anyof',
        isNotDefined: false,
        textMatches: [],
        paramFilters: [],
        ...over,
    });
    const filter = (propFilters: PropFilter[], test: QueryFilter['test'] = 'anyof'): QueryFilter => ({
        test,
        propFilters,
    });

    test('a contains text-match hits a property value case-insensitively', () => {
        const card = linesOf(['FN:Alice']);
        expect(matchCard(card, filter([prop({ name: 'FN', textMatches: [text({ value: 'ali' })] })]))).toBe(true);
        expect(matchCard(card, filter([prop({ name: 'FN', textMatches: [text({ value: 'zzz' })] })]))).toBe(false);
    });

    test('negate-condition inverts a match: equals+negate excludes the equal card, includes a different one', () => {
        const tm = text({ matchType: 'equals', negate: true, value: 'alice' });
        expect(matchCard(linesOf(['FN:Alice']), filter([prop({ name: 'FN', textMatches: [tm] })]))).toBe(false);
        expect(matchCard(linesOf(['FN:Bob']), filter([prop({ name: 'FN', textMatches: [tm] })]))).toBe(true);
    });

    test('i;ascii-casemap folds only ASCII, i;unicode-casemap folds the accented letter too', () => {
        const card = linesOf(['FN:Éowyn']);
        const startsE = (collation: string) =>
            filter([prop({ name: 'FN', textMatches: [text({ collation, matchType: 'starts-with', value: 'é' })] })]);
        expect(matchCard(card, startsE('i;ascii-casemap'))).toBe(false);
        expect(matchCard(card, startsE('i;unicode-casemap'))).toBe(true);
    });

    test('a param-filter matches a TYPE parameter, comma-lists included under contains', () => {
        const typeCell = (matchType: TextMatch['matchType'], value: string): ParamFilter => ({
            name: 'TYPE',
            isNotDefined: false,
            textMatch: text({ matchType, value }),
        });
        const filterFor = (pf: ParamFilter) => filter([prop({ name: 'TEL', paramFilters: [pf] })]);

        expect(matchCard(linesOf(['TEL;TYPE=CELL:+31 1']), filterFor(typeCell('contains', 'cell')))).toBe(true);
        // TYPE=CELL,VOICE is one param value ('CELL,VOICE') in the AST, so contains hits it but equals does not.
        const comma = linesOf(['TEL;TYPE=CELL,VOICE:+31 2']);
        expect(matchCard(comma, filterFor(typeCell('contains', 'cell')))).toBe(true);
        expect(matchCard(comma, filterFor(typeCell('equals', 'cell')))).toBe(false);
        expect(matchCard(comma, filterFor(typeCell('equals', 'CELL,VOICE')))).toBe(true);
    });

    test('allof requires every prop-filter, anyof requires one', () => {
        const both = filter(
            [
                prop({ name: 'FN', textMatches: [text({ value: 'ali' })] }),
                prop({ name: 'ORG', textMatches: [text({ value: 'acme' })] }),
            ],
            'allof',
        );
        expect(matchCard(linesOf(['FN:Alice', 'ORG:ACME']), both)).toBe(true);
        expect(matchCard(linesOf(['FN:Alice']), both)).toBe(false); // ORG missing → allof fails
        expect(matchCard(linesOf(['FN:Alice']), { ...both, test: 'anyof' })).toBe(true); // FN alone → anyof passes
    });

    test('is-not-defined matches a card lacking the property and rejects one that has it', () => {
        const noOrg = filter([prop({ name: 'ORG', isNotDefined: true })]);
        expect(matchCard(linesOf(['FN:X']), noOrg)).toBe(true);
        expect(matchCard(linesOf(['FN:X', 'ORG:ACME']), noOrg)).toBe(false);
    });

    test('an empty prop-filter is a bare existence test', () => {
        const hasEmail = filter([prop({ name: 'EMAIL' })]);
        expect(matchCard(linesOf(['FN:X', 'EMAIL:a@b.com']), hasEmail)).toBe(true);
        expect(matchCard(linesOf(['FN:X']), hasEmail)).toBe(false);
    });

    test('a prop-filter name matches a grouped property (item1.EMAIL) group-insensitively', () => {
        const card = linesOf(['FN:X', 'item1.EMAIL;TYPE=INTERNET:grace@example.org']);
        expect(matchCard(card, filter([prop({ name: 'EMAIL', textMatches: [text({ value: 'grace' })] })]))).toBe(true);
    });
});

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
