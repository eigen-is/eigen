import { describe, expect, test } from 'bun:test';
import { isSheetContent, readBatch } from '@workspace/lib/sheets/ops-validate';
import { SheetRecords } from '../../../engine/book/records';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomBookContent, randomLinesOp, randomMoveOp, randomOp, randomRecordOp } from './batches';
import { canonical, randomOf } from './book-fixtures';
import type { Model } from './model';
import { contentOfModel, expectReads, modelAfter, modelOf } from './model';

const SEEDS = Array.from({ length: 300 }, (_, at) => at + 1);

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
