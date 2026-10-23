// Images and charts are one kind of record on the wire: a map per kind keyed by id, each writer naming one object's
// fields. These drive the real op pipeline over both kinds: an editor recipe through patchToOp, a peer through the
// Workbook's applyOp and a joiner through replaySheetsOps.

import { describe, expect, test } from 'bun:test';
import { CHART_MAX_SIDE, sampleChartSpec } from '@workspace/lib/charts';
import { floatingItems, type SheetChart, type SheetImage } from '@workspace/lib/sheets';
import { applyPatches, produce } from 'immer';
import { normalizeSheetConfig } from '../../../engine/sheet-config';
import type { Context } from '../../../state/context';
import { insertChart } from '../../../state/modules/chart';
import {
    deleteActiveObject,
    deleteFloatingObject,
    reorderFloatingObject,
    selectFloatingObject,
    updateFloatingBox,
    withoutDeletedFloatingEdits,
} from '../../../state/modules/floating';
import { insertImage, removeImageByMediaName, replaceImageMediaName } from '../../../state/modules/image';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import type { Sheet } from '../../../state/types';
import { inverseRowColOptions, patchToOp } from '../../../state/utils/patch';
import { author, join, receive } from '../factories/collab';
import { contextFactory } from '../factories/context';

const S = 'id_1';
const T = 'id_2';
const BOX = { x: 10, y: 20, width: 400, height: 300 };
const image = (id: string, index: string): SheetImage => ({ id, index, ...BOX, mediaName: `${id}.png` });
const chart = (id: string, index: string): SheetChart => ({
    id,
    index,
    ...BOX,
    spec: JSON.stringify(sampleChartSpec('column')),
});

// S holds image i1 above chart c1; T holds image t1, whose upload is still pending.
function workbook(): Context {
    const ctx = contextFactory({
        sheets: [
            { name: 'S', id: S, order: 0, images: { i1: image('i1', 'a2') }, charts: { c1: chart('c1', 'a1') } },
            { name: 'T', id: T, order: 1, images: { t1: { ...image('t1', 'a0'), mediaName: 'pending:t1' } } },
        ],
    }) as Context;
    for (const sheet of ctx.sheets) normalizeSheetConfig(sheet);
    return ctx;
}

const KINDS = [
    { kind: 'image', id: 'i1', field: 'images' },
    { kind: 'chart', id: 'c1', field: 'charts' },
] as const;

const objects = (sheets: Sheet[]) => sheets.map(({ images, charts }) => ({ images, charts }));
const paintOrder = (ctx: Context) => floatingItems(ctx.sheets[0]).map(({ object }) => object.id);

describe('floating writers', () => {
    test('an insert of either kind writes one new key above every image and chart', () => {
        const inserted = author(workbook(), (ctx) => insertImage(ctx, 'new.png', 40, 30));
        const [id] = Object.keys(inserted.next.sheets[0].images!).filter((key) => key !== 'i1');
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const added = inserted.next.sheets[0].images![id];
        expect(inserted.ops).toEqual([{ op: 'add', id: S, path: ['images', id], value: added }]);
        expect(added.index > 'a2').toBe(true);

        const charted = author(workbook(), (ctx) => insertChart(ctx, 'c2', BOX, sampleChartSpec('line')));
        expect(charted.next.sheets[0].charts!.c2.index > 'a2').toBe(true);
    });

    for (const { kind, id, field } of KINDS) {
        test(`a move, resize or rotate of a ${kind} writes only the fields that changed, a first angle as an add`, () => {
            const { ops } = author(workbook(), (ctx) =>
                updateFloatingBox(ctx, { kind, id }, { x: 300, y: 20, width: 500, angle: 90 }),
            );
            expect(ops.map((op) => [op.op, op.path, op.value])).toEqual([
                ['replace', [field, id, 'x'], 300],
                ['replace', [field, id, 'width'], 500],
                ['add', [field, id, 'angle'], 90],
            ]);
        });

        test(`a ${kind} box past the grid or the largest side is stored clamped`, () => {
            const { ops } = author(workbook(), (ctx) =>
                updateFloatingBox(ctx, { kind, id }, { x: -40, width: 9.4e11 }),
            );
            expect(ops.map((op) => [op.path, op.value])).toEqual([
                [[field, id, 'x'], 0],
                [[field, id, 'width'], CHART_MAX_SIDE],
            ]);
        });

        test(`an edit to a ${kind} a peer deleted is dropped everywhere, and from its undo entry`, () => {
            const base = workbook();
            const move = author(base, (ctx) => updateFloatingBox(ctx, { kind, id }, { x: 300 }));
            const removal = author(base, (ctx) => deleteFloatingObject(ctx, { kind, id }));
            expect(removal.ops).toEqual([{ op: 'remove', id: S, path: [field, id] }]);
            const gone = receive(removal.next, move.ops);
            expect(gone.sheets[0][field]).toEqual({});
            expect(join(base, [removal.ops, move.ops])[0][field]).toEqual({});
            const peerGone = receive(move.next, removal.ops);
            expect(() => applyPatches(peerGone, move.inverse)).toThrow();
            expect(withoutDeletedFloatingEdits(peerGone, move.inverse)).toEqual([]);
            expect(withoutDeletedFloatingEdits(move.next, move.inverse)).toEqual(move.inverse);
            expect(withoutDeletedFloatingEdits(removal.next, removal.inverse)).toEqual(removal.inverse);
        });
    }

    test('three clients editing different images end identical, and so does a joiner', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.sheets[0].images!.i2 = image('i2', 'a3');
        });
        const a = author(base, (ctx) => insertImage(ctx, 'new.png', 40, 30));
        const b = author(base, (ctx) => updateFloatingBox(ctx, { kind: 'image', id: 'i1' }, { x: 300, y: 40 }));
        const c = author(base, (ctx) => updateFloatingBox(ctx, { kind: 'image', id: 'i2' }, { angle: 45 }));
        const onA = receive(receive(a.next, b.ops), c.ops);
        const onB = receive(receive(b.next, c.ops), a.ops);
        const onC = receive(receive(c.next, a.ops), b.ops);
        const joiner = join(base, [b.ops, a.ops, c.ops]);
        expect(objects(onB.sheets)).toEqual(objects(onA.sheets));
        expect(objects(onC.sheets)).toEqual(objects(onA.sheets));
        expect(objects(joiner)).toEqual(objects(onA.sheets));
        expect(Object.keys(onA.sheets[0].images!)).toHaveLength(3);
        expect(onA.sheets[0].images!.i1).toMatchObject({ x: 300, y: 40 });
        expect(onA.sheets[0].images!.i2.angle).toBe(45);
    });

    test('an image goes above a chart and back below it, one index written each way', () => {
        const base = workbook();
        expect(paintOrder(base)).toEqual(['c1', 'i1']);
        const back = author(base, (ctx) => reorderFloatingObject(ctx, { kind: 'image', id: 'i1' }, 'backward'));
        expect(paintOrder(back.next)).toEqual(['i1', 'c1']);
        expect(back.ops.map((op) => op.path)).toEqual([['images', 'i1', 'index']]);
        const front = author(back.next, (ctx) => reorderFloatingObject(ctx, { kind: 'image', id: 'i1' }, 'toFront'));
        expect(paintOrder(front.next)).toEqual(['c1', 'i1']);
        expect(author(base, (ctx) => reorderFloatingObject(ctx, { kind: 'chart', id: 'c1' }, 'toBack')).ops).toEqual(
            [],
        );
    });

    // Two peers inserting at once can store one key twice; a move between them must not throw.
    test('a z-order move over tied indices never throws', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.sheets[0].images!.i1.index = 'a1';
        });
        const moved = author(base, (ctx) => reorderFloatingObject(ctx, { kind: 'chart', id: 'c1' }, 'forward'));
        expect(paintOrder(moved.next)).toEqual(['i1', 'c1']);
    });

    // The insert repairs the tie on i2 in its own batch; a peer deleting i2 at once must not cost the insert.
    test('an insert over tied indices survives a peer deleting a tied object, on every client and a joiner', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.sheets[0].images!.i2 = image('i2', 'a2');
        });
        const insert = author(base, (ctx) => insertImage(ctx, 'new.png', 40, 30));
        const removal = author(base, (ctx) => deleteFloatingObject(ctx, { kind: 'image', id: 'i2' }));
        expect(insert.ops.map((op) => op.path)).toContainEqual(['images', 'i2', 'index']);
        const onA = receive(insert.next, removal.ops);
        const onB = receive(removal.next, insert.ops);
        const joiner = join(base, [removal.ops, insert.ops]);
        expect(Object.keys(onA.sheets[0].images!)).toHaveLength(2);
        expect(objects(onB.sheets)).toEqual(objects(onA.sheets));
        expect(objects(joiner)).toEqual(objects(onA.sheets));
        const undone = applyPatches(onA, withoutDeletedFloatingEdits(onA, insert.inverse));
        expect(objects(undone.sheets)).toEqual(objects(removal.next.sheets));
    });

    test('a media rename and a pending removal reach an image on another sheet', () => {
        const renamed = author(workbook(), (ctx) => replaceImageMediaName(ctx, 'pending:t1', 'photo.png'));
        expect(renamed.ops).toEqual([
            { op: 'replace', id: T, path: ['images', 't1', 'mediaName'], value: 'photo.png' },
        ]);
        const removed = author(workbook(), (ctx) => removeImageByMediaName(ctx, 'pending:t1'));
        expect(removed.ops).toEqual([{ op: 'remove', id: T, path: ['images', 't1'] }]);
    });

    test('selecting one kind lets go of the other, and Delete removes the selected one', () => {
        const selected = produce(workbook(), (ctx: Context) => {
            selectFloatingObject(ctx, { kind: 'chart', id: 'c1' });
            selectFloatingObject(ctx, { kind: 'image', id: 'i1' });
        });
        expect(selected.activeObject).toEqual({ kind: 'image', id: 'i1' });
        const { next, ops } = author(selected, deleteActiveObject);
        expect(ops).toEqual([{ op: 'remove', id: S, path: ['images', 'i1'] }]);
        expect(next.activeObject).toBeUndefined();
    });

    test('a viewer writes nothing', () => {
        const base = produce(workbook(), (ctx: Context) => {
            ctx.allowEdit = false;
        });
        for (const recipe of [
            (ctx: Context) => insertImage(ctx, 'new.png', 40, 30),
            (ctx: Context) => replaceImageMediaName(ctx, 'pending:t1', 'photo.png'),
            (ctx: Context) => removeImageByMediaName(ctx, 'pending:t1'),
            ...KINDS.flatMap(({ kind, id }) => [
                (ctx: Context) => updateFloatingBox(ctx, { kind, id }, { x: 1 }),
                (ctx: Context) => reorderFloatingObject(ctx, { kind, id }, 'toBack'),
                (ctx: Context) => deleteFloatingObject(ctx, { kind, id }),
            ]),
        ]) {
            expect(author(base, recipe).ops).toEqual([]);
        }
    });
});

// A row or column op moves no image, and only the charts whose refs it shifts: it, its undo and its redo write those
// per object, so a peer's insert, delete or move of any other object on the sheet survives on every client.
describe('row and column ops over floating objects', () => {
    const grid = () => Array.from({ length: 10 }, () => Array.from({ length: 4 }, () => null));
    const withGrid = () =>
        produce(workbook(), (ctx: Context) => {
            for (const sheet of ctx.sheets) sheet.data = grid();
        });
    const insertOp = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: S } as const;
    const deleteOp = { type: 'row', start: 3, end: 6, id: S } as const;
    const peerEdits = (ctx: Context) => {
        insertImage(ctx, 'new.png', 40, 30);
        deleteFloatingObject(ctx, { kind: 'image', id: 'i1' });
        updateFloatingBox(ctx, { kind: 'chart', id: 'c1' }, { x: 300 });
    };

    test.each([
        ['insert', (ctx: Context) => insertRowCol(ctx, insertOp), { insertRowColOp: insertOp }],
        ['delete', (ctx: Context) => deleteRowCol(ctx, deleteOp), { deleteRowColOp: deleteOp }],
    ] as const)("undoing a row %s keeps a peer's later insert, delete and move, everywhere", (_, recipe, options) => {
        const base = withGrid();
        const op = author(base, recipe, options);
        const peerEdit = author(receive(base, op.ops), peerEdits);
        const undone = applyPatches(receive(op.next, peerEdit.ops), op.inverse);
        const undoOptions = { ...inverseRowColOptions(options), restoreDeletedCells: 'deleteRowColOp' in options };
        const undoOps = patchToOp(undone, op.inverse, undoOptions, true);
        const expected = objects(peerEdit.next.sheets);
        expect(Object.keys(expected[0].images!)).toHaveLength(1);
        expect(objects(undone.sheets)).toEqual(expected);
        expect(objects(receive(peerEdit.next, undoOps).sheets)).toEqual(expected);
        expect(objects(join(base, [op.ops, peerEdit.ops, undoOps]))).toEqual(expected);
    });

    test("a row insert racing a peer's image insert keeps the image, everywhere", () => {
        const base = withGrid();
        const op = author(base, (ctx) => insertRowCol(ctx, insertOp), { insertRowColOp: insertOp });
        const peerInsert = author(base, (ctx) => insertImage(ctx, 'new.png', 40, 30));
        const onA = receive(op.next, peerInsert.ops);
        const onB = receive(peerInsert.next, op.ops);
        expect(Object.keys(onB.sheets[0].images!)).toHaveLength(2);
        expect(objects(onA.sheets)).toEqual(objects(onB.sheets));
        expect(objects(join(base, [peerInsert.ops, op.ops]))).toEqual(objects(onB.sheets));
    });
});
