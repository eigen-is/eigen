import { describe, expect, test } from 'bun:test';
import type { Batch, Op, SheetContent } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomBookContent, randomLandingReaderOp, randomLineReaderOp, randomOp } from './batches';
import type { Book } from './book-fixtures';
import { randomOf } from './book-fixtures';
import { bytes } from './bytes';
import { modelAfter, modelOf } from './model';
import { formulaRule } from './records-fixtures';

// The inverse of a batch, or the key of its refusal.
function landed(book: Workbook, batch: Batch): Op[] | string {
    try {
        const inverse = applyOps(book, batch.ops);
        book.setClock(batch.now, batch.seed);
        return inverse;
    } catch (error) {
        if (error instanceof Refusal) return error.key;
        throw error;
    }
}

// A reader that joins from a snapshot: the book as its content loads it.
function folded(book: Workbook): Workbook {
    bytes(book);
    return new Workbook(structuredClone(book.content()));
}

function sheetOf(id: string, order: string, part: Partial<SheetContent> = {}): SheetContent {
    const fields = { name: id, order };
    return { id, fields, cells: [], looks: [], bands: [], rows: [], columns: [], records: {}, ...part };
}

// Three sheets whose formulas read rows 2 to 4 of sheet `a`, each with comments on those rows.
function threeSheets(): Book {
    const readers: SheetContent['cells'] = [
        [9, 0, { f: '=SUM([a]!R3C1:R4C1)' }],
        [9, 1, { f: '=[a]!R3C2*2' }],
    ];
    const sheets = ['a', 'b', 'c'].map((id, at) => sheetOf(id, `a${at}`, { cells: readers }));
    return { g: 1, now: 45_000, seed: 3, computed: false, sheets };
}

const batch = (...ops: Op[]): Batch => ({ g: 1, now: 45_001, seed: 4, ops });

describe('the order of an inverse', () => {
    test('a replayed book and a folded one give one inverse after tabs moved and a sheet came back', () => {
        const replayed = new Workbook(threeSheets());
        // The tabs turn round, sheet `b` goes and comes back by the undo of its delete, and records are made in an
        // order that is not the order of their ids.
        landed(replayed, batch({ kind: 'record', sheet: 'a', type: 'sheet', id: 'a', set: { order: 'a9' } }));
        const back = landed(replayed, batch({ kind: 'sheet', delete: 'b' }));
        if (typeof back === 'string') throw new Error(back);
        landed(replayed, batch(...back));
        for (const sheet of ['c', 'a', 'b']) {
            for (const id of ['z', 'k', 'q']) {
                landed(
                    replayed,
                    batch(
                        { kind: 'record', sheet, type: 'comment', id, set: { row: 2, column: 1 }, whole: 1 },
                        {
                            kind: 'record',
                            sheet,
                            type: 'conditionalFormat',
                            id,
                            set: formulaRule([[2, 3, 3, 3]], '=[a]!R3C1>0'),
                            whole: 1,
                        },
                    ),
                );
            }
        }
        const joined = folded(replayed);
        expect(bytes(joined)).toBe(bytes(replayed));

        const lines = batch({ kind: 'lines', sheet: 'a', rows: true, insert: false, index: 2, count: 2 });
        const fromReplay = landed(replayed, lines);
        expect(landed(joined, lines)).toEqual(fromReplay);
        // One input per sheet for the formulas the delete broke, and the rules and comments of every sheet.
        expect(fromReplay.length).toBeGreaterThan(12);
        landed(replayed, batch(...(typeof fromReplay === 'string' ? [] : fromReplay)));
        landed(joined, batch(...(typeof fromReplay === 'string' ? [] : fromReplay)));

        const move = batch({ kind: 'move', sheet: 'a', from: [2, 0, 3, 1], toSheet: 'c', toRow: 1, toColumn: 1 });
        const moved = landed(replayed, move);
        expect(landed(joined, move)).toEqual(moved);
        expect(moved.length).toBeGreaterThan(3);
        expect(bytes(joined)).toBe(bytes(replayed));
    });

    test('random logs: a reader that folds mid-way returns every inverse the replaying reader does', () => {
        let structural = 0;
        let compared = 0;
        for (let seed = 1; seed <= 150; seed += 1) {
            const random = randomOf(seed * 7919);
            const content = randomBookContent(random);
            let model = modelOf(content);
            const replayed = new Workbook(structuredClone(content));
            let joined: Workbook | undefined;
            for (let at = 0; at < 14; at += 1) {
                const make = [randomOp, randomOp, randomLineReaderOp, randomLandingReaderOp][at % 4];
                const next = batchOf(random, model, make);
                const after = modelAfter(model, next);
                const inverse = landed(replayed, next);
                if (typeof after !== 'string' && typeof inverse !== 'string') model = after;
                if (joined) {
                    expect(landed(joined, next), `seed ${seed} batch ${at}`).toEqual(inverse);
                    compared += 1;
                    if (typeof inverse !== 'string' && inverse.length > 2) structural += 1;
                }
                if (at === 6) joined = folded(replayed);
            }
            if (joined) expect(bytes(joined), `seed ${seed}`).toBe(bytes(replayed));
        }
        expect(compared).toBe(150 * 7);
        expect(structural).toBeGreaterThan(150);
    });
});
