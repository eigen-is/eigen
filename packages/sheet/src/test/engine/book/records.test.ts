import { describe, expect, test } from 'bun:test';
import type { DataValidationRule } from '@workspace/lib/sheets';
import type { Rect } from '@workspace/lib/sheets/ops';
import { contentOf, sheetOf } from './records-fixtures';

const RULE: DataValidationRule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };

describe('the store', () => {
    test('a record is frozen, and one another write does not touch keeps its reference', () => {
        const sheet = sheetOf({ comment: { c1: { row: 1, column: 1 } }, merge: { m1: { rect: [0, 0, 1, 1] } } });
        const comment = sheet.records('comment').get('c1');
        const merge = sheet.records('merge').get('m1');
        expect(Object.isFrozen(comment)).toBe(true);
        sheet.write({ kind: 'record', sheet: 'S', type: 'comment', id: 'c2', set: { row: 2, column: 2 }, whole: 1 });
        sheet.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'm1', set: { rect: [4, 4, 5, 5] } });
        sheet.write({ kind: 'record', sheet: 'S', type: 'sheet', id: 'S', set: { color: '#f00' } });
        expect(sheet.records('comment').get('c1')).toBe(comment);
        expect(sheet.records('merge').get('m1')).not.toBe(merge);
        expect(merge).toEqual({ rect: [0, 0, 1, 1] });
    });

    test('a line edit or a move leaves the records it does not change as they were', () => {
        const sheet = sheetOf({
            comment: { above: { row: 1, column: 1 }, below: { row: 9, column: 1 } },
            validation: { v: { ranges: [{ row: [0, 2], column: [0, 0] }], order: 'a', rule: RULE } },
        });
        const above = sheet.records('comment').get('above');
        const rule = sheet.records('validation').get('v');
        const plan = sheet.planLines({ kind: 'lines', insert: true, index: 5, count: 1, sheet: 'S', rows: true });
        if (typeof plan === 'string') throw new Error(plan);
        plan.commit();
        expect(sheet.records('comment').get('above')).toBe(above);
        expect(sheet.records('validation').get('v')).toBe(rule);
        expect(sheet.records('comment').get('below')).toEqual({ row: 10, column: 1 });
    });
});

describe('merges are read through an index', () => {
    const sheet = () =>
        sheetOf({
            merge: { a: { rect: [0, 0, 1, 1] }, tall: { rect: [60, 3, 200, 3] }, b: { rect: [5, 2, 5, 4] } },
        });

    test('the merge of a cell, any cell of it', () => {
        const merges = sheet();
        expect(merges.merge(1, 1)).toEqual([0, 0, 1, 1]);
        expect(merges.merge(150, 3)).toEqual([60, 3, 200, 3]);
        expect(merges.merge(5, 4)).toEqual([5, 2, 5, 4]);
        expect(merges.merge(2, 0)).toBeUndefined();
        expect(merges.merge(150, 2)).toBeUndefined();
    });

    test('whether a rectangle meets a merge, and the merges in it in place order', () => {
        const merges = sheet();
        expect(merges.touchesMerge([1, 1, 4, 9])).toBe(true);
        expect(merges.touchesMerge([2, 0, 4, 9])).toBe(false);
        expect(merges.mergesIn([0, 0, 300, 3])).toEqual([
            [0, 0, 1, 1],
            [5, 2, 5, 4],
            [60, 3, 200, 3],
        ]);
        expect(merges.mergesIn([100, 0, 120, 9])).toEqual([[60, 3, 200, 3]]);
    });

    test('the index follows a make, a change, a delete and a line edit', () => {
        const merges = sheet();
        merges.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'c', set: { rect: [300, 0, 301, 0] }, whole: 1 });
        expect(merges.merge(301, 0)).toEqual([300, 0, 301, 0]);
        merges.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'tall', set: { rect: [10, 9, 11, 9] } });
        expect(merges.merge(150, 3)).toBeUndefined();
        expect(merges.merge(11, 9)).toEqual([10, 9, 11, 9]);
        merges.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'a' });
        expect(merges.merge(0, 0)).toBeUndefined();
        const plan = merges.planLines({ kind: 'lines', insert: true, index: 0, count: 100, sheet: 'S', rows: true });
        if (typeof plan === 'string') throw new Error(plan);
        plan.commit();
        expect(merges.merge(5, 2)).toBeUndefined();
        expect(merges.merge(105, 3)).toEqual([105, 2, 105, 4]);
        expect(merges.merge(401, 0)).toEqual([400, 0, 401, 0]);
    });
});

describe('record writes and what their inverse needs', () => {
    test('a make of a new record is undone by a delete, a replace by the old record whole', () => {
        const sheet = sheetOf({ comment: { c1: { row: 1, column: 1 } } });
        expect(
            sheet.write({
                kind: 'record',
                sheet: 'S',
                type: 'comment',
                id: 'c2',
                set: { row: 3, column: 0 },
                whole: 1,
            }),
        ).toEqual([{ kind: 'record', type: 'comment', sheet: 'S', id: 'c2' }]);
        expect(
            sheet.write({
                kind: 'record',
                sheet: 'S',
                type: 'comment',
                id: 'c1',
                set: { row: 4, column: 4 },
                whole: 1,
            }),
        ).toEqual([{ kind: 'record', type: 'comment', sheet: 'S', id: 'c1', set: { row: 1, column: 1 }, whole: 1 }]);
    });

    test('a change sets named fields, null clears one, and the inverse sets the old values back', () => {
        const sheet = sheetOf({}, { frozenRows: 2 });
        const inverse = sheet.write({
            kind: 'record',
            sheet: 'S',
            type: 'sheet',
            id: 'S',
            set: { frozenRows: null, color: '#0f0' },
        });
        expect(sheet.fields).toEqual({ name: 'S', order: 'S', color: '#0f0' });
        expect(inverse).toEqual([
            { kind: 'record', type: 'sheet', sheet: 'S', id: 'S', set: { frozenRows: 2, color: null } },
        ]);
    });

    test('a change of a record that is gone is skipped: its inverse is empty', () => {
        const sheet = sheetOf();
        expect(sheet.write({ kind: 'record', sheet: 'S', type: 'comment', id: 'gone', set: { row: 2 } })).toEqual([]);
        expect(sheet.write({ kind: 'record', sheet: 'S', type: 'comment', id: 'gone' })).toEqual([]);
        expect(contentOf(sheet).records).toEqual({});
    });

    test('a delete is undone by the record whole', () => {
        const sheet = sheetOf({ image: { i: { index: 'a', x: 1, y: 2, width: 3, height: 4, mediaName: 'm.png' } } });
        expect(sheet.write({ kind: 'record', sheet: 'S', type: 'image', id: 'i' })).toEqual([
            {
                kind: 'record',
                type: 'image',
                sheet: 'S',
                id: 'i',
                set: { index: 'a', x: 1, y: 2, width: 3, height: 4, mediaName: 'm.png' },
                whole: 1,
            },
        ]);
        expect(sheet.records('image').size).toBe(0);
    });

    test('a merge over a live merge is refused and writes nothing, by a make or a change', () => {
        const sheet = sheetOf({ merge: { a: { rect: [0, 0, 1, 1] }, b: { rect: [3, 3, 4, 4] } } });
        const over: Rect = [1, 1, 3, 3];
        expect(sheet.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'c', set: { rect: over }, whole: 1 })).toBe(
            'merge-overlap',
        );
        expect(sheet.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'a', set: { rect: over } })).toBe(
            'merge-overlap',
        );
        expect(sheet.records('merge').size).toBe(2);
        expect(sheet.merge(2, 2)).toBeUndefined();
        // A merge replaced over its own cells is no overlap.
        expect(
            sheet.write({ kind: 'record', sheet: 'S', type: 'merge', id: 'a', set: { rect: [0, 0, 2, 2] }, whole: 1 }),
        ).toEqual([{ kind: 'record', type: 'merge', sheet: 'S', id: 'a', set: { rect: [0, 0, 1, 1] }, whole: 1 }]);
    });

    test('a new filter takes the place of the live one and its columns, which its inverse brings back first', () => {
        const sheet = sheetOf({
            filter: { f: { rect: [0, 0, 9, 3] } },
            filterColumn: {
                k1: { filter: 'f', column: 1, rows: [[2, 3]] },
                k2: { filter: 'f', column: 2, rows: [] },
            },
        });
        const inverse = sheet.write({
            kind: 'record',
            sheet: 'S',
            type: 'filter',
            id: 'g',
            set: { rect: [5, 5, 9, 9] },
            whole: 1,
        });
        expect(contentOf(sheet).records).toEqual({ filter: { g: { rect: [5, 5, 9, 9] } } });
        expect(inverse).toEqual([
            { kind: 'record', type: 'filter', sheet: 'S', id: 'f', set: { rect: [0, 0, 9, 3] }, whole: 1 },
            {
                kind: 'record',
                type: 'filterColumn',
                sheet: 'S',
                id: 'k1',
                set: { filter: 'f', column: 1, rows: [[2, 3]] },
                whole: 1,
            },
            {
                kind: 'record',
                type: 'filterColumn',
                sheet: 'S',
                id: 'k2',
                set: { filter: 'f', column: 2, rows: [] },
                whole: 1,
            },
        ]);
        expect(
            sheetOf().write({
                kind: 'record',
                sheet: 'S',
                type: 'filter',
                id: 'g',
                set: { rect: [0, 0, 1, 1] },
                whole: 1,
            }),
        ).toEqual([{ kind: 'record', type: 'filter', sheet: 'S', id: 'g' }]);
    });

    test('deleting a filter deletes its columns, and its inverse makes the filter before them', () => {
        const sheet = sheetOf({
            filter: { f: { rect: [0, 0, 9, 3] } },
            filterColumn: { k1: { filter: 'f', column: 1, rows: [] } },
        });
        expect(sheet.write({ kind: 'record', sheet: 'S', type: 'filter', id: 'f' })).toMatchObject([
            { type: 'filter', id: 'f', whole: 1 },
            { type: 'filterColumn', id: 'k1', whole: 1 },
        ]);
        expect(contentOf(sheet).records).toEqual({});
    });

    test('a filter column that names no live filter is skipped, made or changed', () => {
        const sheet = sheetOf({
            filter: { f: { rect: [0, 0, 9, 3] } },
            filterColumn: { k1: { filter: 'f', column: 1, rows: [] } },
        });
        expect(
            sheet.write({
                kind: 'record',
                sheet: 'S',
                type: 'filterColumn',
                id: 'k2',
                set: { filter: 'old', column: 2, rows: [] },
                whole: 1,
            }),
        ).toEqual([]);
        expect(
            sheet.write({ kind: 'record', sheet: 'S', type: 'filterColumn', id: 'k1', set: { filter: 'old' } }),
        ).toEqual([]);
        expect(contentOf(sheet).records.filterColumn).toEqual({ k1: { filter: 'f', column: 1, rows: [] } });
    });
});

describe('the reads at a cell', () => {
    test('the validation of a cell is the last rule in order that covers it, ties by id', () => {
        const sheet = sheetOf({
            validation: {
                b: { ranges: [{ row: [0, 9], column: [0, 0] }], order: 'a1', rule: { ...RULE, value1: 'b' } },
                a: { ranges: [{ row: [0, 9], column: [0, 0] }], order: 'a1', rule: { ...RULE, value1: 'a' } },
                c: { ranges: [{ row: [5, 5], column: [0, 0] }], order: 'a0', rule: { ...RULE, value1: 'c' } },
            },
        });
        expect(sheet.validation(5, 0)?.rule.value1).toBe('b');
        expect(sheet.validation(5, 1)).toBeUndefined();
    });

    test('the comments of a cell are its ids in order, through a move to and from the cell', () => {
        const sheet = sheetOf({
            comment: { z: { row: 1, column: 1 }, a: { row: 1, column: 1 }, m: { row: 2, column: 2 } },
        });
        expect(sheet.comments(1, 1)).toEqual(['a', 'z']);
        sheet.write({ kind: 'record', sheet: 'S', type: 'comment', id: 'm', set: { row: 1, column: 1 } });
        expect(sheet.comments(1, 1)).toEqual(['a', 'm', 'z']);
        expect(sheet.comments(2, 2)).toEqual([]);
        sheet.write({ kind: 'record', sheet: 'S', type: 'comment', id: 'a' });
        expect(sheet.comments(1, 1)).toEqual(['m', 'z']);
    });
});
