import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { fits, MAX_RECORDS_PER_TYPE, MAX_STYLE_RUNS, MAX_VALUE_SLOTS } from '@workspace/lib/sheets/limits';
import type { CellRecord, Placed, SheetContent } from '@workspace/lib/sheets/ops';
import { isSheetContent } from '@workspace/lib/sheets/ops-validate';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { Workbook } from '../../../engine/book/workbook';
import type { BookContent } from './book-fixtures';
import { canonical, FORMULAS, randomBook, randomOf, reversed } from './book-fixtures';

const LAST_ROW = GRID_ROWS - 1;

function sheetOf(id: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order: 'a0' };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

function bookOf(...sheets: SheetContent[]): BookContent {
    return { g: 1, now: 45_000.5, seed: 7, sheets };
}

function refusalOf(load: () => unknown): unknown {
    try {
        load();
    } catch (error) {
        return error instanceof Refusal ? error.key : error;
    }
    return undefined;
}

describe('engine/book/workbook — a load and the walk back', () => {
    test('a sheet with nothing on it walks back plain', () => {
        const book = new Workbook(bookOf(sheetOf('a')));
        expect(book.content()).toEqual(bookOf(sheetOf('a', { bands: [0, 0] })));
        expect(book.weight()).toEqual({ slots: 0, runs: 0, bands: 1, records: 0, sheets: 1 });
    });

    test('every kind of cell walks back as it came, in column order', () => {
        const cells: Placed<CellRecord>[] = [
            [0, 0, { v: 1.5 }],
            [1, 0, { v: '' }],
            [2, 0, { v: true }],
            [3, 0, { v: '#DIV/0!', e: 1 }],
            [4, 0, { v: '#BUSY!', e: 1 }],
            [5, 0, { link: { type: 'webpage', address: 'https://eigen.is' } }],
            [6, 0, { v: 2, f: '=R[-6]C+0.5' }],
            [7, 0, { f: '=R[-7]C' }],
            [8, 0, { v: '#N/A', e: 1, f: '=NA()' }],
            [0, 1, { qp: 1 }],
            [1, 1, { s: [{ v: 'a', bl: 1 }, { v: 'b' }], link: { type: 'sheet', address: 'a' } }],
            [2, 1, { v: 'typed', qp: 1 }],
            [9, 1, { qp: 1 }],
            [4, 3, { link: { type: 'cellrange', address: 'A1' } }],
        ];
        const book = new Workbook(bookOf(sheetOf('a', { cells })));
        expect(book.content().sheets[0].cells).toEqual(cells);
        expect(JSON.stringify(book.content().sheets[0].cells)).toBe(JSON.stringify(cells));
        expect(book.engine.valueOf('a', 1, 1)).toBe('ab');
        expect(book.engine.valueOf('a', 5, 0)).toBeNull();
        // The cells that hold only a link or a mark take no slot: column 0 ends at row 8, column 1 at row 2.
        expect(book.weight().slots).toBe(9 + 3);
        expect(book.engine.slots()).toBe(12);
    });

    test('a cell’s spill mark loads and walks back dropped', () => {
        const cells: Placed<CellRecord>[] = [[0, 0, { v: 1, spill: 1 }]];
        expect(isSheetContent(sheetOf('a', { cells }))).toBe(true);
        expect(new Workbook(bookOf(sheetOf('a', { cells }))).content().sheets[0].cells).toEqual([[0, 0, { v: 1 }]]);
    });

    test('a formula walks back in the spelling the engine keeps', () => {
        const book = new Workbook(bookOf(sheetOf('a', { cells: [[0, 0, { v: 3, f: '=sum(RC[1],1.0)' }]] })));
        expect(book.content().sheets[0].cells).toEqual([[0, 0, { v: 3, f: '=SUM(RC[1],1)' }]]);
    });

    test('bands the bytes say the long way round load to the one form', () => {
        const bold = { bl: 1 as const };
        const long = sheetOf('a', {
            looks: [bold, { it: 1 }, { bl: 1 }, {}],
            // Columns 0 and 1 hold equal lists in two bands, said in equal neighbouring runs; column 5 is plain twice.
            bands: [0, 3, 2, 1, 4, 3, 6, 4, 1, 2, 2, 3, 6, 0, 5, 2, 0, 4, 9, 0, 7, 1, 3, 2],
        });
        const book = new Workbook(bookOf(long));
        expect(book.content().sheets[0]).toEqual(
            sheetOf('a', { looks: [bold, { it: 1 }], bands: [0, 3, 0, 0, 2, 1, 6, 0, 5, 0, 7, 2, 0, 0, 3, 2] }),
        );
        expect(book.weight()).toEqual({ slots: 0, runs: 5, bands: 3, records: 0, sheets: 1 });
    });

    test('line keys the bytes say in pieces load joined, and a line with no key is in no run', () => {
        const tall = { size: 30, custom: 1 as const };
        const book = new Workbook(
            bookOf(
                sheetOf('a', {
                    rows: [
                        [[0, 1], tall],
                        [[2, 2], tall],
                        [[3, 3], {}],
                    ],
                    columns: [[[4, 4], { hidden: 1 }]],
                }),
            ),
        );
        const [sheet] = book.content().sheets;
        expect(sheet.rows).toEqual([[[0, 2], tall]]);
        expect(sheet.columns).toEqual([[[4, 4], { hidden: 1 }]]);
    });

    test('sheets walk back in tab order, ties by id, and the engine holds them in that order', () => {
        const at = (id: string, order: string) => sheetOf(id, { fields: { name: id, order } });
        const book = new Workbook(bookOf(at('z', 'a1'), at('b', 'a2'), at('a', 'a2'), at('m', 'a0')));
        expect(book.content().sheets.map((sheet) => sheet.id)).toEqual(['m', 'z', 'a', 'b']);
        expect([0, 1, 2, 3].map((place) => book.engine.sheetAt(place))).toEqual(['m', 'z', 'a', 'b']);
        expect([...book.sheets.keys()]).toEqual(['m', 'z', 'a', 'b']);
    });

    test('the generation and the clock walk back', () => {
        const { g, now, seed } = new Workbook({ g: 12, now: 46_000.25, seed: -5, sheets: [sheetOf('a')] }).content();
        expect({ g, now, seed }).toEqual({ g: 12, now: 46_000.25, seed: -5 });
    });

    test('two sheets with one id or one name are the engine’s to refuse, by its own error', () => {
        expect(refusalOf(() => new Workbook(bookOf(sheetOf('a'), sheetOf('a'))))).toEqual(new Error('Sheet a exists'));
        const named = sheetOf('b', { fields: { name: 'A', order: 'a1' } });
        expect(refusalOf(() => new Workbook(bookOf(sheetOf('a'), named)))).toEqual(new Error('Sheet name A is in use'));
    });

    test('the formula texts of the random books are the engine’s own spelling', () => {
        const cells = FORMULAS.map((f, row): Placed<CellRecord> => [row, 0, { f }]);
        const book = new Workbook(bookOf(sheetOf('s0', { cells })));
        expect(book.content().sheets[0].cells).toEqual(cells);
    });

    for (const seed of [1, 2, 3, 2026]) {
        test(`random books load to their canonical form, and that form loads to itself, seed ${seed}`, () => {
            const random = randomOf(seed);
            const seen = { cells: 0, rich: 0, marks: 0, sheets: 0, joinedBands: 0, joinedLines: 0, records: 0 };
            for (let i = 0; i < 300; i += 1) {
                const raw = randomBook(random);
                for (const sheet of raw.sheets) expect(isSheetContent(sheet)).toBe(true);
                const expected = canonical(raw);
                const book = new Workbook(raw);
                const content = book.content();
                expect(content).toEqual(expected);
                for (const sheet of content.sheets) expect(isSheetContent(sheet)).toBe(true);
                expect(new Workbook(content).content()).toEqual(expected);
                // Said in another order it is the same document, to the byte.
                expect(JSON.stringify(new Workbook(reversed(raw)).content())).toBe(JSON.stringify(content));

                seen.sheets += raw.sheets.length;
                for (const [at, sheet] of expected.sheets.entries()) {
                    const said = raw.sheets.find(({ id }) => id === sheet.id) ?? sheet;
                    seen.cells += sheet.cells.length;
                    seen.rich += sheet.cells.filter(([, , cell]) => cell.s).length;
                    seen.marks += sheet.cells.filter(([, , { v, f, s }]) => v === undefined && !f && !s).length;
                    seen.joinedBands += sheet.bands.length < said.bands.length ? 1 : 0;
                    seen.joinedLines += sheet.rows.length < said.rows.length ? 1 : 0;
                    seen.records += Object.keys(sheet.records).length;
                    expect(book.engine.sheetAt(at)).toBe(sheet.id);
                }
            }
            expect(seen.sheets).toBeGreaterThan(600);
            expect(seen.cells).toBeGreaterThan(3000);
            expect(seen.rich).toBeGreaterThan(200);
            expect(seen.marks).toBeGreaterThan(200);
            expect(seen.joinedBands).toBeGreaterThan(100);
            expect(seen.joinedLines).toBeGreaterThan(100);
            expect(seen.records).toBeGreaterThan(1000);
        });
    }

    test('a recalculated book walks back to a snapshot that loads and recalculates to itself', () => {
        const random = randomOf(77);
        for (let i = 0; i < 200; i += 1) {
            const book = new Workbook(randomBook(random));
            expect(book.engine.recalc(Number.POSITIVE_INFINITY).stopped).toBe(false);
            const content = book.content();
            const again = new Workbook(content);
            again.engine.recalc(Number.POSITIVE_INFINITY);
            expect(again.content()).toEqual(content);
        }
    });
});

describe('engine/book/workbook — the limits at the door', () => {
    // One cell on the last row of every column: 16,384 cells that would be 17 billion slots.
    const farCells = Array.from(
        { length: GRID_COLUMNS },
        (_, column): Placed<CellRecord> => [LAST_ROW, column, { v: 1 }],
    );
    // Four bands of a million runs each, no two neighbours alike.
    const stripes = Array.from({ length: 4 }, (_, band) => [
        band,
        MAX_STYLE_RUNS / 4,
        ...Array.from({ length: MAX_STYLE_RUNS / 4 }, (_, row) => [row, 1 + ((row + band) % 2)]).flat(),
    ]).flat();
    const striped = { looks: [{ bl: 1 as const }, { it: 1 as const }], bands: stripes };

    test('a book over the slot limit does not open, and the engine allocated none of it', () => {
        const before = process.memoryUsage().rss;
        const started = performance.now();
        expect(refusalOf(() => new Workbook(bookOf(sheetOf('a', { cells: farCells }))))).toBe('too-many-cells');
        expect(performance.now() - started).toBeLessThan(2000);
        expect(process.memoryUsage().rss - before).toBeLessThan(256 * 2 ** 20);
    });

    test('the slots count each column’s length, so a book at the limit opens and one cell more does not', () => {
        const columns = Math.floor(MAX_VALUE_SLOTS / GRID_ROWS);
        const rest = MAX_VALUE_SLOTS - columns * GRID_ROWS;
        // A value, a formula with no value and a rich text each take the slot of their row.
        for (const last of [{ v: 1 }, { f: '=1' }, { s: [{ v: 'rich' }] }] satisfies CellRecord[]) {
            const cells = (extra: number): Placed<CellRecord>[] => [
                ...farCells.slice(0, columns),
                [0, columns, { v: 1 }],
                [rest - 1 + extra, columns, last],
            ];
            const book = new Workbook(bookOf(sheetOf('a', { cells: cells(0) })));
            expect(book.engine.slots()).toBe(MAX_VALUE_SLOTS);
            expect(refusalOf(() => new Workbook(bookOf(sheetOf('a', { cells: cells(1) }))))).toBe('too-many-cells');
            // A cell that holds only a link or a mark takes no slot, wherever it stands.
            const marked: Placed<CellRecord>[] = [
                ...cells(0),
                [rest, columns, { qp: 1 }],
                [LAST_ROW, columns + 1, { qp: 1 }],
            ];
            expect(new Workbook(bookOf(sheetOf('a', { cells: marked }))).engine.slots()).toBe(MAX_VALUE_SLOTS);
        }
    });

    test('the slots count per sheet: sheets that each end column A on the last row count a column each', () => {
        const columns = Math.floor(MAX_VALUE_SLOTS / GRID_ROWS);
        const far = (count: number) =>
            bookOf(
                ...Array.from({ length: count }, (_, at) => sheetOf(`s${at}`, { cells: [[LAST_ROW, 0, { v: 1 }]] })),
            );
        expect(new Workbook(far(columns)).weight().slots).toBe(columns * GRID_ROWS);
        expect(refusalOf(() => new Workbook(far(columns + 1)))).toBe('too-many-cells');
    });

    test('the weight sums every sheet', () => {
        const book = new Workbook(
            bookOf(
                sheetOf('a', { cells: [[0, 0, { v: 1 }]] }),
                sheetOf('b', {
                    fields: { name: 'b', order: 'a1' },
                    cells: [[4, 2, { v: 1 }]],
                    looks: [{ bl: 1 }],
                    bands: [0, 1, 0, 1, 3, 2, 0, 1, 5, 0],
                }),
            ),
        );
        expect(book.weight()).toEqual({ slots: 1 + 5, runs: 3, bands: 3, records: 0, sheets: 2 });
    });

    test('the weight counts the most records of a type on one sheet, so a write past the loader’s cap is refused', () => {
        const comments = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`c${i}`, { row: i, column: 0 }]));
        const book = new Workbook(bookOf(sheetOf('a', { records: { comment: comments } }), sheetOf('b')));
        expect(book.weight()).toMatchObject({ records: 5, sheets: 2 });
        const records = book.sheets.get('b')?.records;
        for (let i = 0; i <= MAX_RECORDS_PER_TYPE; i += 1) {
            records?.write({
                kind: 'record',
                sheet: 'b',
                type: 'comment',
                id: `c${i}`,
                set: { row: i % 1000, column: 0 },
                whole: 1,
            });
        }
        expect(book.weight().records).toBe(MAX_RECORDS_PER_TYPE + 1);
        expect(fits(book.weight())).toBe('too-many-records');
    });

    test('a book over the format limit does not open', () => {
        expect(refusalOf(() => new Workbook(bookOf(sheetOf('a', striped))))).toBe('too-many-formats');
    });

    test('the limits weigh the bands as rebuilt: runs the bytes say twice count once', () => {
        const twice = stripes.map((n, at) => (at % (2 + MAX_STYLE_RUNS / 2) > 1 && at % 2 === 1 ? 1 : n));
        const book = new Workbook(bookOf(sheetOf('a', { ...striped, bands: twice })));
        expect(book.weight()).toEqual({ slots: 0, runs: 1, bands: 1, records: 0, sheets: 1 });
    });

    test('the limits are weighed before the engine reads a sheet: a book over one with two sheets of one id is refused for its weight', () => {
        const heavy = sheetOf('a', { cells: farCells.slice(0, 5) });
        expect(refusalOf(() => new Workbook(bookOf(heavy, sheetOf('a'))))).toBe('too-many-cells');
        expect(refusalOf(() => new Workbook(bookOf(sheetOf('a', striped), sheetOf('a'))))).toBe('too-many-formats');
    });
});

describe('engine/book/workbook — the look sweep', () => {
    const bold = { bl: 1 as const };
    const red = { fc: '#ff0000' };
    const loaded = () =>
        new Workbook(
            bookOf(
                sheetOf('a', { looks: [bold, red], bands: [0, 2, 0, 1, 5, 2, 3, 1, 0, 2] }),
                sheetOf('b', { fields: { name: 'b', order: 'a1' }, looks: [red], bands: [2, 1, 4, 1] }),
            ),
        );
    const wearUnused = (book: Workbook, count: number) => {
        for (let i = 0; i < count; i += 1) book.looks.intern({ fs: 100 + i });
    };

    test('a table that holds no more than 64 looks, or twice what it held after its load, is not swept', () => {
        const book = loaded();
        expect(book.looks.size).toBe(3);
        wearUnused(book, 61);
        book.sweepLooks();
        expect(book.looks.size).toBe(64);
        book.looks.intern({ un: 1 });
        book.sweepLooks();
        expect(book.looks.size).toBe(3);
    });

    test('the load holds only the looks a band wears, so the next sweep counts from those', () => {
        const unworn = Array.from({ length: 200 }, (_, at) => ({ fs: 100 + at }));
        const raw = bookOf(sheetOf('a', { looks: [...unworn, bold], bands: [0, 1, 0, 201] }));
        const book = new Workbook(raw);
        expect(book.looks.size).toBe(2);
        expect(book.content()).toEqual(bookOf(sheetOf('a', { looks: [bold], bands: [0, 1, 0, 1] })));
        wearUnused(book, 63);
        book.sweepLooks();
        expect(book.looks.size).toBe(2);
    });

    test('a sweep renumbers the looks in every sheet’s bands and moves no byte', () => {
        const book = loaded();
        wearUnused(book, 70);
        const late = book.looks.intern({ it: 1 });
        expect(late).toBe(73);
        book.sheets.get('b')?.bands.write([0, 0, 9, 0], () => late);
        // No cell wears bold any more, so every look that stays gets a lower id.
        book.sheets.get('a')?.bands.write([0, 0, 4, 2], () => 0);
        const before = book.content();

        book.sweepLooks();
        expect(book.looks.size).toBe(3);
        expect(book.sheets.get('a')?.bands.look(7, 0)).toBe(1);
        expect(book.looks.look(1)).toEqual(red);
        expect(book.sheets.get('b')?.bands.look(4, 2)).toBe(1);
        expect(book.sheets.get('b')?.bands.look(0, 0)).toBe(2);
        expect(book.looks.look(2)).toEqual({ it: 1 });
        expect(book.content()).toEqual(before);
        expect(JSON.stringify(book.content())).toBe(JSON.stringify(before));
        // A look interned after the sweep takes the next id, never one a cell wears.
        expect(book.looks.intern(bold)).toBe(3);
    });

    test('after a sweep the next one waits for twice the looks that one left', () => {
        const book = loaded();
        // 99 more looks worn, each on its own row, so a sweep leaves 101 looks and plain.
        for (let row = 10; row < 109; row += 1) {
            const look = book.looks.intern({ ht: row });
            book.sheets.get('a')?.bands.write([row, 0, row, 0], () => look);
        }
        wearUnused(book, 200);
        book.sweepLooks();
        expect(book.looks.size).toBe(102);
        const before = book.content();
        wearUnused(book, 102);
        book.sweepLooks();
        expect(book.looks.size).toBe(204);
        book.looks.intern({ un: 1 });
        book.sweepLooks();
        expect(book.looks.size).toBe(102);
        expect(book.content()).toEqual(before);
    });
});

describe('engine/book/workbook — the clock', () => {
    test('a formula the load computes reads the snapshot’s clock', () => {
        const book = new Workbook(bookOf(sheetOf('a', { cells: [[0, 0, { f: '=NOW()' }]] })));
        book.engine.recalc(100);
        expect(book.engine.valueOf('a', 0, 0)).toBe(45_000.5);
    });
});
