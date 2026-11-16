import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { exceedsChartSpecBytes, newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Op, SheetContent, SheetFields } from '@workspace/lib/sheets/ops';
import { isSheetContent, readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { SheetRecords } from '../../../engine/book/records';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomBookContent, randomLinesOp, randomMoveOp, randomOp, randomRecordOp } from './batches';
import type { Book } from './book-fixtures';
import { canonical, randomOf } from './book-fixtures';
import type { Model } from './model';
import { contentOfModel, expectReads, modelAfter, modelOf } from './model';
import { chartOf, ref } from './records-fixtures';

const SEEDS = Array.from({ length: 400 }, (_, at) => at + 1);

function sheetOf(id: string, fields: Partial<SheetFields> = {}, part: Partial<SheetContent> = {}): SheetContent {
    const all = { name: id, order: 'a0', ...fields };
    return { id, fields: all, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

// The book after the ops as the model applies them, or the key of the refusal.
function after(sheets: SheetContent[], ...ops: Op[]): Book | RefusalKey {
    const model = modelAfter(modelOf({ g: 1, now: 1, seed: 1, computed: false, sheets }), { now: 1, seed: 1, ops });
    return typeof model === 'string' ? model : contentOfModel(model);
}

function sheetsAfter(sheets: SheetContent[], ...ops: Op[]): SheetContent[] {
    const book = after(sheets, ...ops);
    if (typeof book === 'string') throw new Error(`refused: ${book}`);
    return book.sheets;
}

describe('engine/book — the model and the batches the appliers are held to', () => {
    test('a loaded book reads as its model, which walks back to the canonical snapshot', () => {
        for (const seed of SEEDS) {
            const content = randomBookContent(randomOf(seed));
            const model = modelOf(content);
            // A computed book's formulas hold the values the model does not model.
            if (!content.computed) expect(contentOfModel(model)).toEqual(canonical(content));
            expectReads(new Workbook(content), model);
        }
    });

    test('every random batch of every kind passes the validators as it is', () => {
        const kinds = new Set<string>();
        for (const seed of SEEDS) {
            const random = randomOf(seed);
            const batch = batchOf(random, modelOf(randomBookContent(random)), randomOp, 8);
            for (const op of batch.ops) kinds.add(op.kind);
            const text = JSON.stringify(batch);
            expect(readBatch(text)).toEqual(JSON.parse(text));
        }
        expect([...kinds].sort()).toEqual(['format', 'input', 'lines', 'move', 'record', 'sheet']);
    });

    test('the model applies batches of every kind, refuses some, and stays a book the validators pass', () => {
        const refusals = new Set<string>();
        let applied = 0;
        for (const seed of SEEDS) {
            const random = randomOf(seed);
            let model: Model = modelOf(randomBookContent(random));
            for (let round = 0; round < 6; round += 1) {
                const before = JSON.stringify(contentOfModel(model));
                const after = modelAfter(model, batchOf(random, model, randomOp));
                expect(JSON.stringify(contentOfModel(model))).toBe(before);
                if (typeof after === 'string') {
                    refusals.add(after);
                    continue;
                }
                applied += 1;
                model = after;
                for (const sheet of contentOfModel(model).sheets) {
                    expect(isSheetContent(JSON.parse(JSON.stringify(sheet)))).toBe(true);
                }
                // A book of the model's content opens and reads as the model.
                expectReads(new Workbook(contentOfModel(model)), model);
            }
        }
        expect(applied).toBeGreaterThan(600);
        expect([...refusals].sort()).toEqual(['grid-end', 'id-in-use', 'last-sheet', 'merge-cut', 'merge-overlap']);
    }, 30_000);

    // The record store is tested on its own, by tables. Here it and the model, written apart, are held to each other.
    test('the model moves records under lines and moves as the record store does', () => {
        let compared = 0;
        let cut = 0;
        for (let seed = 1; seed <= 1500; seed += 1) {
            const random = randomOf(seed);
            let model: Model = modelOf(randomBookContent(random));
            for (let round = 0; round < 3; round += 1) {
                const after = modelAfter(model, batchOf(random, model, randomRecordOp, 6));
                if (typeof after !== 'string') model = after;
            }
            const stores = new Map(
                contentOfModel(model).sheets.map(({ id, fields, records }) => [
                    id,
                    new SheetRecords(id, fields, records),
                ]),
            );
            const op = random() < 0.5 ? randomLinesOp(random, model) : randomMoveOp(random, model);
            const source = stores.get(op.sheet);
            if (!source || (op.kind === 'move' && !stores.has(op.toSheet))) continue;
            // The applier plans no move of a block onto itself, which changes nothing.
            const still =
                op.kind === 'move' && op.sheet === op.toSheet && op.toRow === op.from[0] && op.toColumn === op.from[1];
            if (still) continue;
            const expected = modelAfter(model, { now: 1, seed: 1, ops: [op] });
            const plans = [...stores.values()].map((store) =>
                op.kind === 'move' ? store.planMove(op, source) : store.planLines(op),
            );
            const refused = plans.find((plan) => typeof plan === 'string');
            if (refused) {
                expect(expected).toBe(refused);
                cut += 1;
                continue;
            }
            // The model also refuses an insert for what the sheet's cells, looks and line keys hold at its end.
            if (typeof expected === 'string') {
                expect(expected).toBe('grid-end');
                continue;
            }
            expect(op.kind === 'lines' && op.insert && source.wouldPush(op)).toBe(false);
            for (const plan of plans) if (typeof plan !== 'string') plan.commit();
            for (const sheet of contentOfModel(expected).sheets) {
                const store = stores.get(sheet.id);
                expect({ fields: store?.fields, records: store?.content() }).toEqual({
                    fields: sheet.fields,
                    records: sheet.records,
                });
            }
            compared += 1;
        }
        expect(compared).toBeGreaterThan(900);
        expect(cut).toBeGreaterThan(20);
    });
});

describe('engine/book — the model, rule by rule', () => {
    test('a sheet added with a name in use takes a suffix within the 31 characters a name may have', () => {
        const long = 'x'.repeat(31);
        const add = (id: string, order: string): Op => ({ kind: 'sheet', add: sheetOf(id, { name: long, order }) });
        const sheets = sheetsAfter([sheetOf('a', { name: long })], add('b', 'a1'), add('c', 'a2'));
        expect(sheets.map((sheet) => sheet.fields.name)).toEqual([
            long,
            `${'x'.repeat(27)} (2)`,
            `${'x'.repeat(27)} (3)`,
        ]);
        for (const sheet of sheets) expect(isSheetContent(JSON.parse(JSON.stringify(sheet)))).toBe(true);
    });

    test('a formula typed with a held sheet’s name enters bound, or with #REF! where bound it is too long', () => {
        const id = 'b'.repeat(60);
        const long = `="${'a'.repeat(131_010)}"&'N'!R1C1`;
        const broken = `="${'a'.repeat(131_010)}"&#REF!`;
        const typed: SheetContent['cells'] = [
            [0, 0, { f: "='Data'!R1C1+1" }],
            [1, 0, { f: "='DATA'!R1C1:R2C2" }],
            [2, 0, { f: long }],
            [3, 0, { f: "='Later'!R1C1" }],
        ];
        const held = [sheetOf('b', { name: 'Data', order: 'a1' }), sheetOf(id, { name: 'N', order: 'a2' })];
        const expected: SheetContent['cells'] = [
            [0, 0, { f: '=[b]!R1C1+1' }],
            [1, 0, { f: '=[b]!R1C1:R2C2' }],
            [2, 0, { f: broken }],
            [3, 0, { f: "='Later'!R1C1" }],
        ];
        // On load, as the engine binds it.
        const content = {
            g: 1,
            now: 1,
            seed: 1,
            computed: false,
            sheets: [sheetOf('a', {}, { cells: typed }), ...held],
        };
        expect(contentOfModel(modelOf(content)).sheets[0].cells).toEqual(expected);
        expectReads(new Workbook(content), modelOf(content));
        // On input.
        const [input] = sheetsAfter([sheetOf('a'), ...held], { kind: 'input', sheet: 'a', cells: typed });
        expect(input.cells).toEqual(expected);
        // On an add, the added sheet's own name included, and the formulas of the book that waited for its name.
        const own: SheetContent['cells'] = [...typed, [4, 0, { f: "='later'!R1C1" }]];
        const added = sheetOf('c', { name: 'Later', order: 'a3' }, { cells: own });
        const waiting = sheetOf('a', {}, { cells: [[0, 0, { f: "='Later'!R1C1" }]] });
        const sheets = sheetsAfter([waiting, ...held], { kind: 'sheet', add: added });
        expect(sheets.map((sheet) => [sheet.id, sheet.cells])).toEqual([
            ['a', [[0, 0, { f: '=[c]!R1C1' }]]],
            ['b', []],
            [id, []],
            ['c', [...expected.slice(0, 3), [3, 0, { f: '=[c]!R1C1' }], [4, 0, { f: '=[c]!R1C1' }]]],
        ]);
    });

    test('a value beside a formula is held only for one this build cannot evaluate, which holds #REF! given none', () => {
        const cells: SheetContent['cells'] = [
            [0, 0, { f: "='[1]N'!R1C1", v: 4 }],
            [1, 0, { f: "=SUM('N:M'!R1C1)", v: '#N/A', e: 1 }],
            [2, 0, { f: "='[1]N'!R1C1", v: '#REF!', e: 1 }],
            [3, 0, { f: "='[1]N'!R1C1" }],
            [4, 0, { f: '=R1C1+1', v: 5 }],
        ];
        const content = { g: 1, now: 1, seed: 1, computed: false, sheets: [sheetOf('a', {}, { cells })] };
        expect(contentOfModel(modelOf(content)).sheets[0].cells).toEqual([
            ...cells.slice(0, 3),
            [3, 0, { f: "='[1]N'!R1C1", v: '#REF!', e: 1 }],
            [4, 0, { f: '=R1C1+1' }],
        ]);
        expectReads(new Workbook(content), modelOf(content));
    });

    test('deleting the last shown sheet is refused, and deleting a hidden one is not', () => {
        const sheets = [sheetOf('a'), sheetOf('b', { hide: 1, order: 'a1' })];
        expect(after(sheets, { kind: 'sheet', delete: 'a' })).toBe('last-sheet');
        expect(after([sheetOf('a')], { kind: 'sheet', delete: 'a' })).toBe('last-sheet');
        expect(sheetsAfter(sheets, { kind: 'sheet', delete: 'b' }).map((sheet) => sheet.id)).toEqual(['a']);
    });

    test('an insert before the freeze freezes the new lines too, up to the grid', () => {
        const frozen = sheetOf('a', { frozenRows: GRID_ROWS - 500, frozenColumns: GRID_COLUMNS - 1 });
        const [rows] = sheetsAfter([frozen], {
            kind: 'lines',
            sheet: 'a',
            rows: true,
            insert: true,
            index: 0,
            count: 1000,
        });
        expect(rows.fields.frozenRows).toBe(GRID_ROWS);
        const [columns] = sheetsAfter([frozen], {
            kind: 'lines',
            sheet: 'a',
            rows: false,
            insert: true,
            index: 3,
            count: 2,
        });
        expect(columns.fields.frozenColumns).toBe(GRID_COLUMNS);
        for (const sheet of [rows, columns]) expect(isSheetContent(JSON.parse(JSON.stringify(sheet)))).toBe(true);
    });

    test('a format restyles the runs of a rich cell in its ranges, key by key', () => {
        const rich = { s: [{ v: 'red ', fc: '#ff0000' }, { v: 'plain' }] };
        const cells: SheetContent['cells'] = [
            [0, 0, rich],
            [1, 0, rich],
        ];
        const [sheet] = sheetsAfter([sheetOf('a', {}, { cells })], {
            kind: 'format',
            sheet: 'a',
            ranges: [[0, 0, 0, 0]],
            set: { bl: 1 },
            clear: ['fc'],
        });
        expect(sheet.cells).toEqual([
            [
                0,
                0,
                {
                    s: [
                        { v: 'red ', bl: 1 },
                        { v: 'plain', bl: 1 },
                    ],
                },
            ],
            [1, 0, rich],
        ]);
    });

    test('a link format sets every cell’s link, keeping its runs, mark and value, and a clear keeps the rest', () => {
        const link = { type: 'webpage', address: 'https://eigen.is' } as const;
        const cells: SheetContent['cells'] = [
            [0, 0, { s: [{ v: 'a', bl: 1 }] }],
            [1, 0, { v: 'typed', qp: 1 }],
            [2, 0, { v: 3, link: { type: 'sheet', address: 's1' } }],
        ];
        const set: Op = { kind: 'format', sheet: 'a', ranges: [[0, 0, 3, 0]], set: { link } };
        const [linked] = sheetsAfter([sheetOf('a', {}, { cells })], set);
        expect(linked.cells).toEqual([
            [0, 0, { s: [{ v: 'a', bl: 1 }], link }],
            [1, 0, { v: 'typed', qp: 1, link }],
            [2, 0, { v: 3, link }],
            [3, 0, { link }],
        ]);
        const [cleared] = sheetsAfter([sheetOf('a', {}, { cells })], set, {
            kind: 'format',
            sheet: 'a',
            ranges: [[0, 0, 9, 9]],
            clear: ['link'],
        });
        expect(cleared.cells).toEqual([
            [0, 0, { s: [{ v: 'a', bl: 1 }] }],
            [1, 0, { v: 'typed', qp: 1 }],
            [2, 0, { v: 3 }],
        ]);
    });

    test('a move takes the looks of its block along and leaves the block plain', () => {
        const bold = (rect: [number, number, number, number]): Op => ({
            kind: 'format',
            sheet: 'a',
            ranges: [rect],
            set: { bl: 1 },
        });
        const move: Op = { kind: 'move', sheet: 'a', from: [0, 0, 1, 0], toSheet: 'a', toRow: 5, toColumn: 3 };
        const [moved] = sheetsAfter([sheetOf('a')], bold([0, 0, 1, 0]), move);
        const [expected] = sheetsAfter([sheetOf('a')], bold([5, 3, 6, 3]));
        expect({ looks: moved.looks, bands: moved.bands }).toEqual({ looks: expected.looks, bands: expected.bands });
    });

    test('a chart change is refused when the chart it makes is past its size bound', () => {
        const parts = newChartSpecParts(sampleChartSpec('column'));
        const padded = (part: string) => `${part.slice(0, -1)}${' '.repeat(40_000)}${part.slice(-1)}`;
        const chart = { index: 'a0', x: 0, y: 0, width: 1, height: 1, ...parts };
        const sheets = [sheetOf('a', {}, { records: { chart: { g: chart } } })];
        const change = (set: Partial<typeof parts>): Op => ({
            kind: 'record',
            sheet: 'a',
            type: 'chart',
            id: 'g',
            set,
        });
        const title = change({ specTitle: padded(parts.specTitle) });
        const [landed] = sheetsAfter(sheets, title);
        expect(landed.records.chart?.g.specTitle).toBe(padded(parts.specTitle));
        expect(after(sheets, title, change({ specLegend: padded(parts.specLegend) }))).toBe('key-too-long');
    });

    // Each line of a small axis carries its own number through the edit, as an array spliced; the rest of the grid
    // follows it. A range is where its lines went: from the first that is left to the last, the new lines between
    // them included.
    test('a range, a comment and filtered rows under a line edit cover the cells their lines went to', () => {
        const LINES = 12;
        const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
        let checked = 0;
        for (const rows of [true, false]) {
            const last = (rows ? GRID_ROWS : GRID_COLUMNS) - 1;
            for (const insert of [true, false]) {
                for (let index = 0; index < LINES; index += 1) {
                    for (let count = 1; count <= 3; count += 1) {
                        const axis: (number | null)[] = Array.from({ length: LINES + 4 }, (_, line) => line);
                        if (insert) axis.splice(index, 0, ...Array.from({ length: count }, () => null));
                        else axis.splice(index, count);
                        for (let start = 0; start < LINES; start += 1) {
                            for (let end = start; end <= LINES; end += 1) {
                                // Past the small axis the range reaches the grid's last line, and stays reaching it.
                                const open = end === LINES;
                                const stop = open ? last : end;
                                const places = axis.flatMap((line, place) =>
                                    line !== null && line >= start && line <= (open ? LINES + 3 : end) ? [place] : [],
                                );
                                const lines =
                                    places.length > 0
                                        ? ([places[0], open ? last : places[places.length - 1]] as const)
                                        : null;
                                // A rule's range of the whole axis stays whole: lines inserted at its start are in
                                // it. Filtered rows are lines, so they move.
                                const span = lines && open && start === 0 ? ([0, last] as const) : lines;
                                const rect = (a: number, b: number) =>
                                    rows ? ([a, 2, b, 3] as const) : ([2, a, 3, b] as const);
                                const records: SheetContent['records'] = {
                                    validation: { v: { ranges: [rect(start, stop)], order: 'a', rule } },
                                    comment: { c: rows ? { row: start, column: 1 } : { row: 1, column: start } },
                                    filter: { f: { rect: rows ? [0, 0, last, 4] : [0, 0, 20, last] } },
                                };
                                if (rows)
                                    records.filterColumn = { k: { filter: 'f', column: 1, rows: [[start, stop]] } };
                                const [sheet] = sheetsAfter([sheetOf('a', {}, { records })], {
                                    kind: 'lines',
                                    sheet: 'a',
                                    rows,
                                    insert,
                                    index,
                                    count,
                                });
                                const at = axis.indexOf(start);
                                expect(sheet.records.validation?.v?.ranges ?? null).toEqual(
                                    span && [rect(span[0], span[1])],
                                );
                                expect(sheet.records.comment?.c ?? null).toEqual(
                                    at < 0 ? null : rows ? { row: at, column: 1 } : { row: 1, column: at },
                                );
                                // A delete of the filter's first row takes the filter, and its columns with it.
                                const header = rows && !insert && index === 0;
                                if (rows && !header)
                                    expect(sheet.records.filterColumn?.k?.rows).toEqual(lines ? [lines] : []);
                                checked += 1;
                            }
                        }
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(10_000);
    });

    test('a line edit is refused when the refs it rewrites take a chart past its size bound', () => {
        const chart = (length: number) =>
            chartOf({
                categories: null,
                series: [{ id: 's', name: 'n'.repeat(length), values: ref('a', [0, 0], [0, 0]) }],
            });
        // The longest name that keeps the chart inside its bound.
        let [low, high] = [1, 70_000];
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (exceedsChartSpecBytes(chart(middle))) high = middle - 1;
            else low = middle;
        }
        const sheets = [sheetOf('a', {}, { records: { chart: { g: chart(low) } } }), sheetOf('b', { order: 'a1' })];
        const insert = (sheet: string): Op => ({
            kind: 'lines',
            sheet,
            rows: true,
            insert: true,
            index: 0,
            count: 1_000_000,
        });
        expect(after(sheets, insert('a'))).toBe('key-too-long');
        expect(sheetsAfter(sheets, insert('b'))[0].records.chart?.g).toEqual(chart(low));
    });
});
