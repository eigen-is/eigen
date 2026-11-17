import { describe, expect, test } from 'bun:test';
import { ERROR_LITERALS, GRID_COLUMNS, GRID_ROWS, LAST_SERIAL } from '@workspace/formula/text';
import { isRecord } from '../../core/guards';
import type { BookContent } from '../../sheets/book-codec';
import { decodeBook, encodeBook } from '../../sheets/book-codec';
import { MAX_RECORDS_PER_TYPE, MAX_SHEETS } from '../../sheets/limits';
import type { CellAttrs, CellRecord, LineAttrs, Placed, Rect, SheetContent, Span } from '../../sheets/ops';
import { isSheetContent } from '../../sheets/ops-validate';
import { encodeSheetsSnapshot } from '../../sheets/snapshot-codec';

// A seeded random number generator, so a failing case can be run again.
function random(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)];
const below = (next: () => number, most: number) => Math.floor(next() * most);

const BOX = { index: 'a0', x: 0, y: 0, width: 10, height: 10 };
const SPEC = {
    ...{ specChart: '{}', specTitle: '{}', specLegend: '{}', specAxes: '{}' },
    ...{ specPlots: '{}', specSeries: '{}', specPoints: '{}', specData: '{}' },
};
const RANGE: Rect = [0, 0, 5, 0];
const LINK = { type: 'webpage', address: 'https://eigen.is' } as const;
const RECORDS: Required<SheetContent['records']> = {
    merge: { m1: { rect: [0, 0, 1, 1] } },
    filter: { f1: { rect: [0, 0, 20, 4] } },
    filterColumn: { fc1: { filter: 'f1', column: 2, condition: { name: 'byValue', values: ['a'] }, rows: [[3, 3]] } },
    comment: { 'card-9': { row: 1, column: 1 } },
    conditionalFormat: {
        cf1: { ranges: [RANGE], order: 'a0', type: 'dataBar', format: ['#f00'] },
        cf2: {
            ranges: [RANGE],
            order: 'a1',
            type: 'default',
            format: { cellColor: '#f00', textColor: null },
            conditionName: 'formula',
            conditionValue: ['=R1C1>1'],
        },
    },
    validation: {
        v1: { ranges: [RANGE], order: 'a0', rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' } },
    },
    image: { i1: { ...BOX, mediaName: 'photo.png', angle: 15 } },
    chart: { c1: { ...BOX, ...SPEC, fill: '{"type":"solid"}', strokeStyle: 'dashed', seed: 3 } },
};

const FORMULAS = ['=R[-1]C+1', '=SUM(R1C:R[-1]C)', '=[s2]!R2C1*2', '=IF(RC[-1]>0,"yes","no")', '="="', '=NA()'];
const TEXTS = [
    '',
    'x',
    'Total',
    '=not a formula',
    '#N/A',
    'ünïcødé ❤️',
    `a"b\\c\n${String.fromCharCode(0x2028, 0xd800)}`,
    '0',
    '1',
];
const NUMBERS = [0, 1, -1, 0.1, 1e21, -2.5e-7, 46000.5, Number.MAX_SAFE_INTEGER, 5e-324];
const SCALARS = [...NUMBERS, ...TEXTS, true, false];

// One cell of every kind the snapshot stores, in turn.
const CELL_KINDS: ((next: () => number) => CellRecord)[] = [
    (next) => ({ v: pick(next, NUMBERS) }),
    (next) => ({ v: pick(next, TEXTS) }),
    (next) => ({ v: next() < 0.5 }),
    (next) => ({ v: pick(next, ERROR_LITERALS), e: 1 }),
    (next) => ({ f: pick(next, FORMULAS), v: pick(next, SCALARS) }),
    (next) => ({ f: pick(next, FORMULAS) }),
    (next) => ({ f: pick(next, FORMULAS), v: pick(next, ERROR_LITERALS), e: 1 }),
    (next) => ({
        s: [
            { v: pick(next, TEXTS), bl: 1 },
            { v: 'b', fc: '#f00', ff: 2 },
        ],
    }),
    (next) => ({ v: pick(next, SCALARS), link: LINK }),
    () => ({ link: { type: 'sheet', address: 's1' } }),
    (next) => ({ v: pick(next, SCALARS), qp: 1 }),
    () => ({ qp: 1 }),
    (next) => ({ v: pick(next, SCALARS), spill: 1 }),
    (next) => ({ f: pick(next, FORMULAS), v: pick(next, NUMBERS), link: LINK, qp: 1 }),
    (next) => ({ v: pick(next, ERROR_LITERALS), e: 1, qp: 1 }),
];

const LOOK_PARTS: CellAttrs[] = [
    { bl: 1 },
    { it: 1 },
    { ff: 'Arial' },
    { ff: 2 },
    { fs: 11 },
    { fc: '#f00' },
    { cl: 1, un: 1 },
    { fa: '0.00%' },
    { ht: 1, vt: 0 },
    { tb: '2' },
    { bg: '#eee' },
    { rt: 45 },
    { rt: 'vertical' },
    { bdt: { style: 1, color: '#000' }, bdb: { style: 2, color: '#123456' } },
    { bdl: { style: 1, color: '#000' }, bdr: { style: 1, color: '#000' }, bdd: { style: 3, color: '#fff' } },
];
const LINE_PARTS: LineAttrs[] = [{ size: 30, custom: 1 }, { hidden: 1 }, { size: 0 }, { size: 12.5, hidden: 1 }];

// Places in column order: columns and rows ascending, some rows consecutive, a few at the grid's last line.
function places(next: () => number, count: number): [number, number][] {
    const out: [number, number][] = [];
    let column = below(next, 3);
    while (out.length < count && column < GRID_COLUMNS) {
        let row = next() < 0.1 ? GRID_ROWS - 1 - below(next, 3) : below(next, 20);
        for (let cell = 1 + below(next, 6); cell > 0 && row < GRID_ROWS && out.length < count; cell -= 1) {
            out.push([row, column]);
            row += next() < 0.7 ? 1 : 2 + below(next, 5);
        }
        column = next() < 0.05 ? Math.max(column + 1, GRID_COLUMNS - 1) : column + 1 + below(next, 3);
    }
    return out;
}

function spans(next: () => number, count: number): [Span, LineAttrs][] {
    const out: [Span, LineAttrs][] = [];
    let first = below(next, 4);
    for (let run = below(next, 4); run > 0 && first < count; run -= 1) {
        const last = Math.min(count - 1, first + below(next, 5));
        out.push([[first, last], pick(next, LINE_PARTS)]);
        first = last + 1 + below(next, 4);
    }
    return out;
}

function randomSheet(next: () => number, index: number): SheetContent {
    const looks = Array.from({ length: below(next, 5) }, () => ({
        ...pick(next, LOOK_PARTS),
        ...pick(next, LOOK_PARTS),
    }));
    const bands: number[] = [];
    for (let first = below(next, 3); first < GRID_COLUMNS && next() < 0.7; first += 1 + below(next, 4)) {
        const pairs: number[] = [];
        for (let start = below(next, 4); start < GRID_ROWS && next() < 0.6; start += 1 + below(next, 9)) {
            pairs.push(start, below(next, looks.length + 1));
        }
        bands.push(first, pairs.length / 2, ...pairs);
    }
    const records: SheetContent['records'] = {};
    // A record's id is unique in the whole book, so each sheet tags the ids it takes, and a column its filter's. A
    // column comes only with its filter, which `RECORDS` lists before it.
    for (const [type, items] of Object.entries(RECORDS)) {
        if (next() >= 0.4 || (type === 'filterColumn' && records.filter === undefined)) continue;
        const tagged = Object.entries(items).map(([id, item]) => [
            `${id}.${index}`,
            'filter' in item ? { ...item, filter: `${item.filter}.${index}` } : item,
        ]);
        Object.assign(records, { [type]: Object.fromEntries(tagged) });
    }
    const fields: SheetContent['fields'] = { name: `Sheet ${index}`, order: pick(next, ['a0', 'a1', 'a5']) };
    if (next() < 0.3) Object.assign(fields, { hide: 1, color: '#f00', grid: 0 });
    if (next() < 0.3) Object.assign(fields, { defaultRowHeight: 21, defaultColWidth: 80.5 });
    if (next() < 0.3) Object.assign(fields, { frozenRows: 1, frozenColumns: GRID_COLUMNS });
    return {
        id: `s${index}`,
        fields,
        cells: places(next, below(next, 60)).map(
            ([row, column]): Placed<CellRecord> => [row, column, pick(next, CELL_KINDS)(next)],
        ),
        looks,
        bands,
        rows: spans(next, GRID_ROWS),
        columns: spans(next, GRID_COLUMNS),
        records,
    };
}

function randomBook(next: () => number): BookContent {
    return {
        g: next() < 0.1 ? Number.MAX_SAFE_INTEGER : below(next, 1_000_000),
        now: next() < 0.1 ? LAST_SERIAL + 0.999 : next() * LAST_SERIAL,
        seed: next() < 0.1 ? -(2 ** 31) : below(next, 2 ** 32) - 2 ** 31,
        computed: next() < 0.5,
        sheets: Array.from({ length: 1 + below(next, 3) }, (_, index) => randomSheet(next, index)),
    };
}

// The same JSON value with every object's keys in the reverse order.
function reversed(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reversed);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reversed(item)]),
    );
}

const BOOK: BookContent = {
    g: 3,
    now: 46000.25,
    seed: -7,
    computed: true,
    sheets: [
        {
            id: 's1',
            fields: { name: 'Sheet1', order: 'a0', frozenRows: 1 },
            cells: [
                [0, 0, { v: 'Total' }],
                [1, 0, { v: 12.5 }],
                [2, 0, { f: '=SUM(R1C:R[-1]C)', v: 12.5 }],
                [4, 0, { f: '=R[-1]C+1' }],
                [0, 1, { v: true }],
                [1, 1, { f: '=NA()', v: '#N/A', e: 1 }],
                [2, 1, { v: '#DIV/0!', e: 1 }],
                [3, 1, { s: [{ v: 'a', bl: 1 }, { v: 'b' }] }],
                [4, 1, { v: 'eigen', link: LINK }],
                [5, 1, { f: '=R[-1]C+1', v: 2, qp: 1 }],
            ],
            looks: [{ bl: 1 }, { bg: '#eee', bdt: { style: 1, color: '#000' } }],
            bands: [0, 2, 0, 1, 10, 0, 3, 1, 0, 2, 5, 0],
            rows: [[[0, 0], { size: 30, custom: 1 }]],
            columns: [[[2, 2], { hidden: 1 }]],
            records: RECORDS,
        },
        {
            id: 's2',
            fields: { name: 'Sheet2', order: 'a1' },
            cells: [
                [0, 0, { f: '=[s1]!R1C1', v: 'Total' }],
                [1, 0, { f: '=SUM(R1C:R[-1]C)', v: 0 }],
                [2, 0, { v: 3, spill: 1 }],
            ],
            looks: [],
            bands: [],
            rows: [],
            columns: [],
            records: {},
        },
    ],
};
const TEXT = encodeBook(BOOK);
const parsed = (): Record<string, unknown> => JSON.parse(TEXT);
// The example's text with one part of it written anew.
const edited = (edit: (book: Record<string, unknown>, sheet: Record<string, unknown>) => void) => {
    const book = parsed();
    const sheets = book['sheets'];
    const sheet = Array.isArray(sheets) && isRecord(sheets[0]) ? sheets[0] : {};
    edit(book, sheet);
    return decodeBook(JSON.stringify(book));
};

describe('law 4: a round trip', () => {
    test('gives back every random book, which encodes to the same text again', () => {
        const next = random(1);
        for (let round = 0; round < 500; round += 1) {
            const book = randomBook(next);
            for (const sheet of book.sheets) expect(isSheetContent(sheet)).toBe(true);
            const text = encodeBook(book);
            const decoded = decodeBook(text);
            expect(decoded).toEqual(book);
            if (decoded !== null) expect(encodeBook(decoded)).toBe(text);
        }
    });

    test('gives back every cell kind of the example', () => {
        expect(decodeBook(TEXT)).toEqual(BOOK);
    });
});

describe('the encoded form', () => {
    test('is the tag, the generation, the clock, computed, the formulas and the sheets, in that order', () => {
        expect(Object.keys(parsed())).toEqual(['f', 'g', 'now', 'seed', 'computed', 'formulas', 'sheets']);
        expect(TEXT.startsWith('{"f":"eigensheets/3","g":3,"now":46000.25,"seed":-7,"computed":true,')).toBe(true);
    });

    test('lists each formula once, in order of first use walking sheets then cells', () => {
        expect(parsed()['formulas']).toEqual(['=SUM(R1C:R[-1]C)', '=R[-1]C+1', '=NA()', '=[s1]!R1C1']);
    });

    test('writes a column as runs of consecutive rows, a value bare and a formula by its index', () => {
        const sheets = parsed()['sheets'];
        expect(Array.isArray(sheets) && sheets[0]).toMatchObject({
            cells: [
                [0, 0, 'Total', 12.5, [0, 12.5]],
                [0, 4, [1]],
                [
                    1,
                    0,
                    true,
                    [2, '#N/A', 1],
                    { e: 1, v: '#DIV/0!' },
                    { s: [{ bl: 1, v: 'a' }, { v: 'b' }] },
                    { link: { address: 'https://eigen.is', type: 'webpage' }, v: 'eigen' },
                    { f: 1, qp: 1, v: 2 },
                ],
            ],
        });
    });
});

describe('canonical', () => {
    test('writes equal books to equal text, whatever order their keys were set in', () => {
        const next = random(2);
        for (let round = 0; round < 300; round += 1) {
            const book = randomBook(next);
            const text = encodeBook(book);
            const shuffled = decodeBook(JSON.stringify(reversed(JSON.parse(text))));
            expect(shuffled).toEqual(book);
            if (shuffled !== null) expect(encodeBook(shuffled)).toBe(text);
        }
    });

    test('writes a book built in another key order as the example', () => {
        const [first, second] = BOOK.sheets;
        const records = Object.fromEntries(Object.entries(first.records).reverse());
        const cells = first.cells.map(
            ([row, column, { v, e, f, s, link, qp }]): Placed<CellRecord> => [
                row,
                column,
                {
                    ...(qp && { qp }),
                    ...(link && { link }),
                    ...(s && { s }),
                    ...(e && { e }),
                    ...(v !== undefined && { v }),
                    ...(f && { f }),
                },
            ],
        );
        const book: BookContent = {
            sheets: [
                {
                    records,
                    columns: first.columns,
                    rows: first.rows,
                    bands: first.bands,
                    looks: [{ bl: 1 }, { bdt: { color: '#000', style: 1 }, bg: '#eee' }],
                    cells,
                    fields: { frozenRows: 1, order: 'a0', name: 'Sheet1' },
                    id: 's1',
                },
                second,
            ],
            computed: true,
            seed: -7,
            now: 46000.25,
            g: 3,
        };
        expect(encodeBook(book)).toBe(TEXT);
    });

    test('writes -0 as 0, and a key set to undefined as no key', () => {
        const sheet = (cell: CellRecord): BookContent => ({
            ...BOOK,
            sheets: [{ ...BOOK.sheets[1], cells: [[0, 0, cell]] }],
        });
        expect(encodeBook(sheet({ v: -0 }))).toBe(encodeBook(sheet({ v: 0 })));
        expect(encodeBook({ ...sheet({ v: 1 }), now: -0 })).toBe(encodeBook({ ...sheet({ v: 1 }), now: 0 }));
        expect(encodeBook(sheet({ v: 1, link: undefined, qp: undefined }))).toBe(encodeBook(sheet({ v: 1 })));
        expect(encodeBook(sheet({ v: 1, f: undefined }))).toBe(encodeBook(sheet({ v: 1 })));
        const decoded = decodeBook(encodeBook(sheet({ v: -0 })));
        expect(Object.is(decoded?.sheets[0].cells[0][2].v, 0)).toBe(true);
    });
});

describe('refusal', () => {
    test('of another tag, today’s eigensheets/2 included', () => {
        const old = encodeSheetsSnapshot(
            [{ id: 's1', name: 'Sheet1', order: 0, celldata: [{ r: 0, c: 0, v: { v: 1 } }] }],
            {
                computed: true,
            },
        );
        expect(decodeBook(old)).toBeNull();
        expect(decodeBook(old.replace('eigensheets/2', 'eigensheets/3'))).toBeNull();
        for (const tag of [undefined, 'eigensheets/2', 'eigensheets/4', 'eigensheets/3 ', 3]) {
            expect(edited((book) => Object.assign(book, { f: tag }))).toBeNull();
        }
        expect(edited((book) => delete book['f'])).toBeNull();
    });

    test('of every truncated text', () => {
        for (let length = 0; length < TEXT.length; length += 1) expect(decodeBook(TEXT.slice(0, length))).toBeNull();
    });

    test('of a formula index past the list, or no index', () => {
        for (const index of [4, -1, 0.5, '0', null, Number.POSITIVE_INFINITY]) {
            const cells = [[0, 0, [index, 1]]];
            expect(edited((_, sheet) => Object.assign(sheet, { cells }))).toBeNull();
            expect(edited((_, sheet) => Object.assign(sheet, { cells: [[0, 0, { f: index, v: 1 }]] }))).toBeNull();
        }
        expect(edited((_, sheet) => Object.assign(sheet, { cells: [[0, 0, { f: '=R1C1', v: 1 }]] }))).toBeNull();
        expect(edited((_, sheet) => Object.assign(sheet, { cells: [[0, 0, [3, 1]]] }))).not.toBeNull();
    });

    test('of a cell no record reads', () => {
        for (const cell of [
            null,
            [],
            [0, 1, 1, 1],
            [0, 1, 2],
            [0, null],
            [0, '#N/A', 1, 1],
            { v: 1, x: 1 },
            { f: 0, s: [] },
        ]) {
            expect(edited((_, sheet) => Object.assign(sheet, { cells: [[0, 0, cell]] }))).toBeNull();
        }
        for (const run of [[], [0], [0, 0], [0, '0', 1], [0, 0.5, 1], [GRID_COLUMNS, 0, 1], [0, GRID_ROWS - 1, 1, 2]]) {
            expect(edited((_, sheet) => Object.assign(sheet, { cells: [run] }))).toBeNull();
        }
        expect(
            edited((_, sheet) =>
                Object.assign(sheet, {
                    cells: [
                        [1, 0, 1],
                        [0, 0, 1],
                    ],
                }),
            ),
        ).toBeNull();
        expect(
            edited((_, sheet) =>
                Object.assign(sheet, {
                    cells: [
                        [0, 0, 1, 2],
                        [0, 1, 1],
                    ],
                }),
            ),
        ).toBeNull();
    });

    test('of a sheet that fails the sheet guard', () => {
        expect(edited((_, sheet) => Object.assign(sheet, { x: 1 }))).toBeNull();
        expect(edited((_, sheet) => delete sheet['looks'])).toBeNull();
        expect(edited((_, sheet) => delete sheet['cells'])).toBeNull();
        expect(edited((_, sheet) => Object.assign(sheet, { fields: { order: 'a0' } }))).toBeNull();
        expect(edited((_, sheet) => Object.assign(sheet, { bands: [0, 1, 0, 3] }))).toBeNull();
        expect(edited((_, sheet) => Object.assign(sheet, { id: 'a[b' }))).toBeNull();
        expect(edited((book) => Object.assign(book, { sheets: [7] }))).toBeNull();
        expect(edited((book) => Object.assign(book, { sheets: {} }))).toBeNull();
    });

    test('of a book with no sheet', () => {
        expect(decodeBook(encodeBook({ ...BOOK, sheets: [] }))).toBeNull();
        expect(decodeBook(encodeBook({ ...BOOK, sheets: [BOOK.sheets[1]] }))).not.toBeNull();
    });

    test('of a book with more sheets than a workbook holds', () => {
        const sheets = (count: number) =>
            Array.from({ length: count }, (_, index) => ({
                ...BOOK.sheets[1],
                id: `s${index}`,
                fields: { name: `n${index}`, order: 'a0' },
            }));
        expect(decodeBook(encodeBook({ ...BOOK, sheets: sheets(MAX_SHEETS) }))).not.toBeNull();
        expect(decodeBook(encodeBook({ ...BOOK, sheets: sheets(MAX_SHEETS + 1) }))).toBeNull();
    });

    test('of two sheets with one id', () => {
        const twin = { ...BOOK.sheets[1], fields: { name: 'Twin', order: 'a2' } };
        expect(decodeBook(encodeBook({ ...BOOK, sheets: [...BOOK.sheets, { ...twin, id: 's1' }] }))).toBeNull();
        expect(decodeBook(encodeBook({ ...BOOK, sheets: [...BOOK.sheets, { ...twin, id: 's3' }] }))).not.toBeNull();
    });

    test('of two sheets that hold a record of one type under one id', () => {
        const twin = (records: SheetContent['records']) => ({ ...BOOK.sheets[1], records });
        const book = (records: SheetContent['records']) =>
            decodeBook(encodeBook({ ...BOOK, sheets: [BOOK.sheets[0], twin(records)] }));
        expect(book({ comment: { 'card-9': { row: 4, column: 4 } } })).toBeNull();
        expect(book({ chart: { c1: RECORDS.chart.c1 } })).toBeNull();
        // Ids are a type's own: a merge may share its id with a comment.
        expect(book({ merge: { 'card-9': { rect: [4, 4, 5, 5] } } })).not.toBeNull();
        expect(book({ comment: { 'card-8': { row: 4, column: 4 } } })).not.toBeNull();
    });

    test('of a sheet with a filter column whose filter it does not hold, or with two filters', () => {
        const twin = (records: SheetContent['records']) => ({ ...BOOK.sheets[1], records });
        const book = (records: SheetContent['records']) =>
            decodeBook(encodeBook({ ...BOOK, sheets: [BOOK.sheets[0], twin(records)] }));
        const column = (filter: string) => ({ filter, column: 1, rows: [] });
        expect(book({ filter: { f2: { rect: [0, 0, 5, 5] } }, filterColumn: { c2: column('f2') } })).not.toBeNull();
        expect(book({ filterColumn: { c2: column('f2') } })).toBeNull();
        // Ids are book-wide, so a column may not name the filter another sheet holds.
        expect(book({ filterColumn: { c2: column('f1') } })).toBeNull();
        expect(book({ filter: { f2: { rect: [0, 0, 5, 5] }, f3: { rect: [6, 0, 9, 5] } } })).toBeNull();
    });

    test('of a clock, a generation or a head out of range', () => {
        const heads: [string, unknown][] = [
            ...[-1, LAST_SERIAL + 1, '1', null].map((now): [string, unknown] => ['now', now]),
            ...[2 ** 31, -(2 ** 31) - 1, 0.5].map((seed): [string, unknown] => ['seed', seed]),
            ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((g): [string, unknown] => ['g', g]),
            ['computed', 1],
            ['formulas', {}],
            ['formulas', [1]],
            ['x', 1],
            ['__proto__', {}],
        ];
        for (const [key, value] of heads) {
            expect(edited((book) => Object.defineProperty(book, key, { value, enumerable: true }))).toBeNull();
        }
        expect(decodeBook(TEXT.replace('"now":46000.25', '"now":1e400'))).toBeNull();
        expect(edited((book) => Object.assign(book, { now: LAST_SERIAL + 0.999, seed: -(2 ** 31) }))).not.toBeNull();
    });

    test('of a book past a bound the sheet guard holds', () => {
        const comments = (count: number) =>
            Object.fromEntries(Array.from({ length: count }, (_, index) => [`c${index}`, { row: 0, column: 0 }]));
        const book = (count: number): BookContent => ({
            ...BOOK,
            sheets: [{ ...BOOK.sheets[1], records: { comment: comments(count) } }],
        });
        expect(decodeBook(encodeBook(book(MAX_RECORDS_PER_TYPE)))).not.toBeNull();
        expect(decodeBook(encodeBook(book(MAX_RECORDS_PER_TYPE + 1)))).toBeNull();
    });
});

// JSON texts of values no book holds, such as a number past a double or a prototype key.
const ODD: string[] = [
    ...['null', 'true', '0', '-0', '-1', '1.5', '1e400', String(2 ** 53)],
    ...['""', '"eigensheets/3"', '"="', '"__proto__"', '[]', '{}', '[null,1]', '{"__proto__":{"f":"eigensheets/3"}}'],
];
const KEYS = [
    'f',
    'g',
    'now',
    'seed',
    'computed',
    'formulas',
    'sheets',
    'id',
    'fields',
    'cells',
    'looks',
    'bands',
    'v',
];

function randomJson(next: () => number, depth: number): string {
    const kind = below(next, depth > 3 ? 1 : 3);
    if (kind === 0) return pick(next, ODD);
    const items = Array.from({ length: below(next, 5) }, () => randomJson(next, depth + 1));
    if (kind === 1) return `[${items.join(',')}]`;
    return `{${items.map((item) => `"${pick(next, KEYS)}":${item}`).join(',')}}`;
}

type Node = Record<string, unknown> | unknown[];

// Every object and array inside a value, so a mutation can pick one at random.
function nodesOf(value: unknown, into: Node[] = []): Node[] {
    if (Array.isArray(value) || isRecord(value)) into.push(value);
    if (Array.isArray(value)) for (const item of value) nodesOf(item, into);
    else if (isRecord(value)) for (const item of Object.values(value)) nodesOf(item, into);
    return into;
}

describe('never throws', () => {
    test('on thousands of random JSON texts and random strings', () => {
        const next = random(3);
        const alphabet = '{}[]":,.-+eE0123456789 abtrufnlsx\\';
        for (let round = 0; round < 5_000; round += 1) {
            expect(decodeBook(randomJson(next, 0))).toBeNull();
            const noise = Array.from({ length: below(next, 60) }, () => alphabet.charAt(below(next, alphabet.length)));
            expect(decodeBook(noise.join(''))).toBeNull();
            expect(decodeBook(TEXT.slice(0, below(next, TEXT.length)) + noise.join(''))).toBeNull();
        }
    });

    test('on deep nesting', () => {
        const deep = `${'['.repeat(200_000)}1${']'.repeat(200_000)}`;
        expect(decodeBook(TEXT.replace('"formulas":[', `"formulas":[${deep},`))).toBeNull();
        expect(decodeBook(TEXT.replace('"cells":[', `"cells":[[0,0,${deep}],`))).toBeNull();
    });

    test('on books with one random mutation, which are refused or read as sheets the guard holds', () => {
        const next = random(4);
        let refused = 0;
        for (let round = 0; round < 20_000; round += 1) {
            const book: unknown = JSON.parse(encodeBook(randomBook(next)));
            const nodes = nodesOf(book);
            const node = pick(next, nodes);
            const keys: (number | string)[] = Array.isArray(node) ? node.map((_, index) => index) : Object.keys(node);
            const key = pick(next, keys);
            const mutation = below(next, 4);
            const write = (value: unknown) => {
                if (Array.isArray(node)) node[Number(key ?? 0)] = value;
                else node[String(key ?? 'x')] = value;
            };
            if (mutation === 0 && !Array.isArray(node)) node['zz'] = 1;
            else if (mutation === 1) write(JSON.parse(randomJson(next, 2)));
            else if (mutation === 2) write(below(next, 3) - 1);
            else if (Array.isArray(node)) node.splice(Number(key ?? 0), 1);
            else delete node[String(key)];
            const text = JSON.stringify(book);
            const decoded = decodeBook(text);
            // A key no part lists is never valid.
            if (mutation === 0 && !Array.isArray(node)) expect(decoded).toBeNull();
            if (decoded === null) {
                refused += 1;
                continue;
            }
            for (const sheet of decoded.sheets) expect(isSheetContent(sheet)).toBe(true);
            expect(decodeBook(encodeBook(decoded))).toEqual(decoded);
        }
        expect(refused).toBeGreaterThan(5_000);
    });
});
