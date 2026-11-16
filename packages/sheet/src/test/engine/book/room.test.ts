import { describe, expect, spyOn, test } from 'bun:test';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomAnyOp, randomBookContent } from './batches';
import { randomOf } from './book-fixtures';
import type { Model } from './model';
import { modelAfter, modelOf } from './model';
import { walked } from './room-fixtures';

describe('engine/book/room — the counts the workbook keeps are what a walk of it counts', () => {
    test('after a load, and whenever a batch asks the weight, over random books and batches', () => {
        let asked = 0;
        let refused = 0;
        const kinds = new Set<string>();
        for (let seed = 1; seed <= 150; seed += 1) {
            const random = randomOf(seed);
            const book = new Workbook(randomBookContent(random));
            expect(book.weight()).toMatchObject(walked(book));
            const over = book.over.bind(book);
            const addSheet = book.addSheet.bind(book);
            // A sheet being added is counted before the book lists it, so a walk does not see it yet.
            let adding = false;
            spyOn(book, 'addSheet').mockImplementation((sheet, checked) => {
                adding = true;
                try {
                    return addSheet(sheet, checked);
                } finally {
                    adding = false;
                }
            });
            spyOn(book, 'over').mockImplementation((slots, formats) => {
                asked += 1;
                if (!adding) expect(book.weight()).toMatchObject(walked(book));
                return over(slots, formats);
            });
            let model: Model = modelOf(book.content());
            for (let round = 0; round < 6; round += 1) {
                const batch = batchOf(random, model, randomAnyOp);
                for (const op of batch.ops) kinds.add(op.kind);
                try {
                    applyOps(book, batch.ops);
                } catch (error) {
                    if (!(error instanceof Refusal)) throw error;
                    refused += 1;
                }
                expect(book.weight()).toMatchObject(walked(book));
                const next = modelAfter(model, batch);
                if (typeof next !== 'string') model = next;
            }
        }
        expect(kinds.size).toBe(6);
        expect(refused).toBeGreaterThan(50);
        expect(asked).toBeGreaterThan(1000);
    }, 300_000);
});
