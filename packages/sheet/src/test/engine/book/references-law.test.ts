import { describe, expect, test } from 'bun:test';
import type { BookContent } from '@workspace/lib/sheets/book-codec';
import type { Batch, Op } from '@workspace/lib/sheets/ops';
import { opReferences } from '@workspace/lib/sheets/ops';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import { batchOf, randomAnyOp, randomBookContent, randomMoveOp, randomSheetOp, someSheet } from './batches';
import type { Random } from './book-fixtures';
import { below, randomOf } from './book-fixtures';
import type { Model } from './model';
import { modelOf } from './model';

const SEEDS = Number(process.env['REFERENCES_LAW_SEEDS'] ?? 150);

type Named = { media: Set<string>; comments: Set<string> };

// The media names and comment ids a book's content holds, on any sheet.
function namedIn({ sheets }: BookContent): Named {
    const named: Named = { media: new Set(), comments: new Set() };
    for (const { records } of sheets) {
        for (const { mediaName } of Object.values(records.image ?? {})) named.media.add(mediaName);
        for (const id of Object.keys(records.comment ?? {})) named.comments.add(id);
    }
    return named;
}

function pick<T>(random: Random, list: readonly T[]): T {
    return list[below(random, list.length)];
}

// An op that brings or changes a medium or a comment: an image made, given another medium or deleted, a comment made,
// moved, deleted or changed while it is gone, a sheet copied whole with its records, a block moved with its comments
// to another sheet, or a sheet deleted or added.
function referenceOp(random: Random, model: Model, book: Workbook): Op {
    const { id: sheet, records } = someSheet(random, model);
    const images = [...records.image.keys()];
    const comments = [...records.comment.keys()];
    const fresh = `${sheet}x${below(random, 6)}`;
    const box = { index: 'a0', x: 1, y: 2, width: 30, height: 40 };
    return pick<() => Op>(random, [
        () => ({
            kind: 'record',
            sheet,
            type: 'image',
            id: fresh,
            set: { ...box, mediaName: `m${below(random, 99)}.png` },
            whole: 1,
        }),
        () => ({
            kind: 'record',
            sheet,
            type: 'image',
            id: pick(random, [...images, fresh]),
            set: { mediaName: `m${below(random, 99)}.png` },
        }),
        () => ({ kind: 'record', sheet, type: 'image', id: pick(random, [...images, fresh]) }),
        () => ({
            kind: 'record',
            sheet,
            type: 'comment',
            id: fresh,
            set: { row: below(random, 14), column: below(random, 8) },
            whole: 1,
        }),
        () => ({
            kind: 'record',
            sheet,
            type: 'comment',
            id: pick(random, [...comments, fresh]),
            set: { row: below(random, 14) },
        }),
        () => ({ kind: 'record', sheet, type: 'comment', id: pick(random, [...comments, fresh]) }),
        () => {
            const part = book.sheets.get(sheet);
            if (!part) return randomSheetOp(random, model);
            const add = book.sheetContent(sheet, part);
            const name = `Copy ${below(random, 1000)}`;
            return {
                kind: 'sheet',
                add: { ...add, id: `copy${below(random, 1_000_000)}`, fields: { ...add.fields, name } },
            };
        },
        () => randomMoveOp(random, model),
        () => randomSheetOp(random, model),
    ])();
}

function land(book: Workbook, batch: Batch): Op[] | undefined {
    try {
        const inverse = applyOps(book, batch.ops);
        book.setClock(batch.now, batch.seed);
        return inverse;
    } catch (error) {
        if (error instanceof Refusal) return undefined;
        throw error;
    }
}

describe('engine/book — LAW 9: every reference is named by the log or the snapshot', () => {
    test(
        'every media name and comment id in the content comes from an op that landed or from the snapshot loaded',
        () => {
            const counts = { landed: 0, undone: 0, redone: 0, copies: 0, media: 0, comments: 0, fromOps: 0 };
            for (let seed = 1; seed <= SEEDS; seed += 1) {
                const random = randomOf(seed);
                const start = randomBookContent(random);
                const book = new Workbook(start);
                const named = namedIn(start);
                const undo: Op[][] = [];
                const redo: Op[][] = [];
                for (let step = 0; step < 10; step += 1) {
                    const model = modelOf(book.content());
                    const draw = random();
                    const stack =
                        draw < 0.2 && undo.length > 0 ? undo : draw < 0.3 && redo.length > 0 ? redo : undefined;
                    const ops =
                        stack?.pop() ??
                        batchOf(random, model, (r, m) => (r() < 0.6 ? referenceOp(r, m, book) : randomAnyOp(r, m)), 4)
                            .ops;
                    const inverse = land(book, { g: model.g, now: model.now + 1, seed: step, ops });
                    if (!inverse) continue;
                    if (stack === undo) counts.undone += 1;
                    else if (stack === redo) counts.redone += 1;
                    else counts.landed += 1;
                    (stack === undo ? redo : undo).push(inverse);
                    for (const op of ops) {
                        if (op.kind === 'sheet' && 'add' in op && op.add.id.startsWith('copy')) counts.copies += 1;
                        const { media, comments } = opReferences(op);
                        for (const name of media) named.media.add(name);
                        for (const id of comments) named.comments.add(id);
                    }
                    const held = namedIn(book.content());
                    expect([...held.media].filter((name) => !named.media.has(name))).toEqual([]);
                    expect([...held.comments].filter((id) => !named.comments.has(id))).toEqual([]);
                    const loaded = namedIn(start);
                    counts.media += held.media.size;
                    counts.comments += held.comments.size;
                    for (const name of held.media) if (!loaded.media.has(name)) counts.fromOps += 1;
                    for (const id of held.comments) if (!loaded.comments.has(id)) counts.fromOps += 1;
                }
            }
            expect(counts.landed).toBeGreaterThan(SEEDS * 5);
            expect(counts.undone).toBeGreaterThan(SEEDS);
            expect(counts.redone).toBeGreaterThan(SEEDS / 3);
            expect(counts.copies).toBeGreaterThan(SEEDS / 3);
            expect(counts.media).toBeGreaterThan(SEEDS * 5);
            expect(counts.comments).toBeGreaterThan(SEEDS * 5);
            expect(counts.fromOps).toBeGreaterThan(SEEDS * 5);
            if (process.env['REFERENCES_LAW_SEEDS']) console.log(counts);
        },
        SEEDS * 300,
    );
});
