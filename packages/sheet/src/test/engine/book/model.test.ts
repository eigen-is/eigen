import { describe, expect, test } from 'bun:test';
import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { Op, SheetContent, SheetFields } from '@workspace/lib/sheets/ops';
import { isSheetContent, readBatch } from '@workspace/lib/sheets/ops-validate';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { SheetRecords } from '../../../engine/book/records';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomBookContent, randomLinesOp, randomMoveOp, randomOp, randomRecordOp } from './batches';
import type { BookContent } from './book-fixtures';
import { canonical, randomOf } from './book-fixtures';
import type { Model } from './model';
import { contentOfModel, expectReads, modelAfter, modelOf } from './model';

const SEEDS = Array.from({ length: 300 }, (_, at) => at + 1);

function sheetOf(id: string, fields: Partial<SheetFields> = {}, part: Partial<SheetContent> = {}): SheetContent {
    const all = { name: id, order: 'a0', ...fields };
    return { id, fields: all, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

// The book after the ops as the model applies them, or the key of the refusal.
function after(sheets: SheetContent[], ...ops: Op[]): BookContent | RefusalKey {
    const model = modelAfter(modelOf({ g: 1, now: 1, seed: 1, sheets }), { now: 1, seed: 1, ops });
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
            expect(contentOfModel(model)).toEqual(canonical(content));
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
        expect([...refusals].sort()).toEqual(['grid-end', 'last-sheet', 'merge-cut', 'merge-overlap']);
    });

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
            expect(op.kind === 'lines' && op.insert && source.blocksPush(op.rows, op.count)).toBe(false);
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
});
