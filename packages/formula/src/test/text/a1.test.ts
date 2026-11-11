import { describe, expect, test } from 'bun:test';
import {
    columnIndex,
    columnLabel,
    findSheetByName,
    GRID_COLUMNS,
    GRID_ROWS,
    parseA1,
    parseA1Range,
    quoteSheetName,
    rangeToA1,
    sheetFinder,
    sheetNameKey,
    toA1,
} from '../../text';

describe('column labels', () => {
    test.each([
        [0, 'A'],
        [25, 'Z'],
        [26, 'AA'],
        [701, 'ZZ'],
        [702, 'AAA'],
        [16383, 'XFD'],
    ])('%d is %s, and back', (index, label) => {
        expect(columnLabel(index)).toBe(label);
        expect(columnIndex(label)).toBe(index);
        expect(columnIndex(label.toLowerCase())).toBe(index);
    });

    test('text that names no column of the grid is -1', () => {
        expect(columnIndex('')).toBe(-1);
        expect(columnIndex('A1')).toBe(-1);
        expect(columnIndex('ABCD')).toBe(-1);
        expect(columnIndex('$A')).toBe(-1);
        expect(columnIndex('XFE')).toBe(-1);
        expect(columnIndex('ZZZ')).toBe(-1);
    });

    test("the grid is Excel's", () => {
        expect(GRID_ROWS).toBe(1048576);
        expect(columnLabel(GRID_COLUMNS - 1)).toBe('XFD');
    });
});

describe('toA1 and rangeToA1', () => {
    test('a cell', () => {
        expect(toA1(0, 0)).toBe('A1');
        expect(toA1(9, 27)).toBe('AB10');
    });

    test('a rectangle, one cell without the colon', () => {
        expect(rangeToA1({ row: [0, 2], column: [0, 1] })).toBe('A1:B3');
        expect(rangeToA1({ row: [4, 4], column: [2, 2] })).toBe('C5');
        expect(rangeToA1({ row: [0, 2], column: [0, 1] }, true)).toBe('$A$1:$B$3');
        expect(rangeToA1({ row: [4, 4], column: [2, 2] }, true)).toBe('$C$5');
    });
});

describe('parseA1Range', () => {
    test.each([
        ['A1', { sheet: undefined, start: { column: 0, row: 0 }, end: { column: 0, row: 0 } }],
        ['$B$2:c5', { sheet: undefined, start: { column: 1, row: 1 }, end: { column: 2, row: 4 } }],
        ['Sheet1!$A$1:B3', { sheet: 'Sheet1', start: { column: 0, row: 0 }, end: { column: 1, row: 2 } }],
        ["'My Sheet'!A1", { sheet: 'My Sheet', start: { column: 0, row: 0 }, end: { column: 0, row: 0 } }],
        ["'Bob''s'!B2:A1", { sheet: "Bob's", start: { column: 0, row: 0 }, end: { column: 1, row: 1 } }],
        ['B2:A1', { sheet: undefined, start: { column: 0, row: 0 }, end: { column: 1, row: 1 } }],
        ['A3:C1', { sheet: undefined, start: { column: 0, row: 0 }, end: { column: 2, row: 2 } }],
        ['$C$1:a3', { sheet: undefined, start: { column: 0, row: 0 }, end: { column: 2, row: 2 } }],
        ['Sheet1!B2:Sheet1!A1', { sheet: 'Sheet1', start: { column: 0, row: 0 }, end: { column: 1, row: 1 } }],
        [
            'XFD1048576',
            { sheet: undefined, start: { column: 16383, row: 1048575 }, end: { column: 16383, row: 1048575 } },
        ],
    ])('%s', (text, expected) => {
        expect(parseA1Range(text)).toEqual(expected);
    });

    test.each([
        '',
        'A',
        'A:A',
        '1:1',
        'A1:',
        'A1:B',
        'A1+B1',
        'SUM(A1)',
        'A1 ',
        ' A1',
        'XFE1',
        'A0',
        'Sheet1!',
        "'A1",
        'Rate',
        '[1]Book!A1',
    ])('%p is no cell or rectangle', (text) => {
        expect(parseA1Range(text)).toBeNull();
    });
});

describe('quoteSheetName', () => {
    test.each(['Sheet1', 'Data_2024', 'a.b', 'Übersicht', '数据', 'XFE1x', 'ABCD1'])('%s stays bare', (name) => {
        expect(quoteSheetName(name)).toBe(name);
    });

    test.each([
        ['My Sheet', "'My Sheet'"],
        ["Bob's", "'Bob''s'"],
        ['P&L', "'P&L'"],
        ['2024', "'2024'"],
        ['.hidden', "'.hidden'"],
        ['A1', "'A1'"],
        ['xfd1048576', "'xfd1048576'"],
        ['RC', "'RC'"],
        ['R1C1', "'R1C1'"],
        ['r', "'r'"],
        ['C', "'C'"],
        ['R5', "'R5'"],
        ['TRUE', "'TRUE'"],
        ['false', "'false'"],
        ['a-b', "'a-b'"],
        ['a+b', "'a+b'"],
        ['Q1 (final)', "'Q1 (final)'"],
        ['a!b', "'a!b'"],
        ['', "''"],
        ['a?b', "'a?b'"],
        ['a\\b', "'a\\b'"],
        ['a$b', "'a$b'"],
        ['\uff21\uff11', "'\uff21\uff11'"],
        ['x\u200by', "'x\u200by'"],
        ['a\u3000b', "'a\u3000b'"],
        ['\u3164', "'\u3164'"],
        ['\u0e2a\u0e23\u0e38\u0e1b', "'\u0e2a\u0e23\u0e38\u0e1b'"],
    ])('%s is quoted', (name, expected) => {
        expect(quoteSheetName(name)).toBe(expected);
    });

    test.each(['\u6570\u636e', '\uff21\uff11', 'x\u200by', '\u0e2a\u0e23\u0e38\u0e1b', '\ud83d\ude00', 'a\u00d7b'])(
        'a sheet named %s is spelled so that it reads back',
        (name) => {
            const find = sheetFinder([{ id: 'id1', name }]);
            const tree = parseA1(`=${quoteSheetName(name)}!A1`, 0, 0, find);
            expect(tree).toMatchObject({ sheet: 'id1' });
        },
    );
});

describe('sheetNameKey', () => {
    test('names compare in any case', () => {
        expect(sheetNameKey('data')).toBe(sheetNameKey('DATA'));
        expect(sheetNameKey('Übersicht')).toBe(sheetNameKey('übersicht'));
        expect(sheetNameKey('Data')).not.toBe(sheetNameKey('Data2'));
    });

    test('the Greek final sigma matches the other two', () => {
        expect(sheetNameKey('ΟΔΟΣ')).toBe(sheetNameKey('οδος'));
        expect(sheetNameKey('οδοσ')).toBe(sheetNameKey('οδος'));
    });

    test('a character whose uppercase is longer keeps its case', () => {
        expect(sheetNameKey('straße')).toBe('STRAßE');
        expect(sheetNameKey('straße')).not.toBe(sheetNameKey('strasse'));
    });
});

describe('findSheetByName and sheetFinder', () => {
    const sheets = [
        { id: '1', name: 'Data' },
        { id: '2', name: 'data' },
        { id: '3', name: 'Totals' },
    ];

    test.each([
        ['Data', '1'],
        ['data', '2'],
        ['DATA', '1'],
        ['totals', '3'],
        ['Totals', '3'],
        ['Missing', undefined],
    ])('%s reads sheet %p', (name, id) => {
        expect(findSheetByName(sheets, name)?.id).toBe(id);
        expect(sheetFinder(sheets)(name)?.id).toBe(id);
    });
});
