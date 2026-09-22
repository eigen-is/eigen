// The addressbook-query matcher (src/lib/carddav/query-filter.ts): the prop-filter, param-filter and
// text-match semantics a CardDAV client's REPORT leans on. Parsing the XML into these types is covered by
// the carddav integration suite.
import { describe, expect, test } from 'bun:test';
import {
    matchCard,
    type ParamFilter,
    type PropFilter,
    type QueryFilter,
    type TextMatch,
} from '../../lib/carddav/query-filter';
import { parseVCardLines } from '../../lib/vcard';

// A vCard is CRLF-joined and CRLF-terminated; fixtures are written as physical lines so folding is literal.
const vcard = (lines: string[]) => `${lines.join('\r\n')}\r\n`;

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
