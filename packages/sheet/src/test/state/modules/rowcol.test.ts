// Alternate formats shift in the state reducer, not the engine; they must follow the same
// membership rule as every other range, deletes dropping a wholly deleted range.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Context } from '../../../state/context';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
import type { Sheet } from '../../../state/types';
import type { Span } from '../../engine/range-oracle';
import { expectedDelete, expectedInsert, SPANS } from '../../engine/range-oracle';
import { contextFactory } from '../factories/context';

const OTHER: Span = [0, 1];
const onAxis = (type: 'row' | 'column', span: Span) =>
    type === 'row' ? { row: span, column: OTHER } : { row: OTHER, column: span };

function withAlternateFormats(type: 'row' | 'column'): Context {
    return contextFactory({
        sheets: [
            {
                name: 'sheet',
                id: 'id_1',
                order: 0,
                config: {},
                data: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null)),
                alternateFormatRules: SPANS.map((span) => ({ cellrange: onAxis(type, span) })),
            },
        ],
    }) as Context;
}

describe('alternate formats follow the membership rule', () => {
    for (const type of ['row', 'column'] as const) {
        test(`${type} inserts`, () => {
            for (let index = 0; index <= 6; index += 1) {
                for (const direction of ['lefttop', 'rightbottom'] as const) {
                    for (const count of [1, 2]) {
                        const op = { type, index, count, direction, id: 'id_1' };
                        const next = produce(withAlternateFormats(type), (ctx: Context) =>
                            insertRowCol(ctx, op, false),
                        );
                        const insertAt = direction === 'lefttop' ? index : index + 1;
                        expect(next.sheets[0].alternateFormatRules!.map((af) => af.cellrange)).toEqual(
                            SPANS.map((span) => onAxis(type, expectedInsert(span, insertAt, count))),
                        );
                    }
                }
            }
        });

        test(`${type} deletes drop a wholly deleted range`, () => {
            for (let start = 0; start <= 6; start += 1) {
                for (let end = start; end <= 6; end += 1) {
                    const op = { type, start, end, id: 'id_1' };
                    const next = produce(withAlternateFormats(type), (ctx: Context) => deleteRowCol(ctx, op));
                    const expected = SPANS.map((span) => expectedDelete(span, start, end)).filter(
                        (span) => span !== null,
                    );
                    expect(next.sheets[0].alternateFormatRules!.map((af) => af.cellrange)).toEqual(
                        expected.map((span) => onAxis(type, span)),
                    );
                }
            }
        });
    }
});

describe('the filter and read-only rows follow a row or column op', () => {
    const filtered = (): Context =>
        contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config: { rowReadOnly: { 3: 1, 5: 1 }, colReadOnly: { 3: 1, 5: 1 } },
                    data: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null)),
                    filterRange: { row: [0, 3], column: [0, 3] },
                    filter: {
                        1: { rowhidden: { 2: 0 }, optionstate: true, str: 0, edr: 3, cindex: 1, stc: 0, edc: 3 },
                    },
                },
            ],
        }) as Context;
    const entry = { optionstate: true, cindex: 1, stc: 0, edc: 3 };

    test('a row insert above moves the filter and its hidden rows down', () => {
        const op = { type: 'row', index: 0, count: 2, direction: 'lefttop', id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => insertRowCol(ctx, op, false)).sheets;
        expect(sheet.filterRange).toEqual({ row: [2, 5], column: [0, 3] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: { 4: 0 }, str: 2, edr: 5 } });
        expect(sheet.config?.rowhidden).toEqual({ 4: 0 });
        expect(sheet.config?.rowReadOnly).toEqual({ 5: 1, 7: 1 });
    });

    test('a column insert inside widens the filter', () => {
        const op = { type: 'column', index: 1, count: 1, direction: 'rightbottom', id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => insertRowCol(ctx, op, false)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 3], column: [0, 4] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: { 2: 0 }, str: 0, edr: 3, edc: 4 } });
        expect(sheet.config?.colReadOnly).toEqual({ 4: 1, 6: 1 });
    });

    test('a row delete inside shrinks the filter and moves its hidden rows up', () => {
        const op = { type: 'row', start: 1, end: 1, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 2], column: [0, 3] });
        expect(sheet.filter).toEqual({ 1: { ...entry, rowhidden: { 1: 0 }, str: 0, edr: 2 } });
        expect(sheet.config?.rowReadOnly).toEqual({ 2: 1, 4: 1 });
    });

    test('a row delete of every hidden row drops the filter entries', () => {
        const op = { type: 'row', start: 2, end: 2, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 2], column: [0, 3] });
        expect(sheet.filter).toBeUndefined();
    });

    test('a column delete at the left edge moves the filter column left', () => {
        const op = { type: 'column', start: 0, end: 0, id: 'id_1' } as const;
        const [sheet] = produce(filtered(), (ctx: Context) => deleteRowCol(ctx, op)).sheets;
        expect(sheet.filterRange).toEqual({ row: [0, 3], column: [0, 2] });
        expect(sheet.filter).toEqual({ 0: { ...entry, rowhidden: { 2: 0 }, str: 0, edr: 3, cindex: 0, edc: 2 } });
        expect(sheet.config?.colReadOnly).toEqual({ 2: 1, 4: 1 });
    });
});

describe('read-only rows and columns at the op boundary', () => {
    const sheet = (config?: Sheet['config']): Context =>
        contextFactory({
            sheets: [
                {
                    name: 'sheet',
                    id: 'id_1',
                    order: 0,
                    config,
                    data: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => null)),
                },
            ],
        }) as Context;
    // The engine refuses an insert at a read-only index, so the entry there is one that is not read-only.
    const boundary = { 2: 1, 3: 0, 4: 1 };

    for (const [type, key] of [
        ['row', 'rowReadOnly'],
        ['column', 'colReadOnly'],
    ] as const) {
        test(`a ${type} inserted before the index moves the entry at the index, as the hidden ${type}s move`, () => {
            const op = { type, index: 3, count: 2, direction: 'lefttop', id: 'id_1' } as const;
            const next = produce(sheet({ [key]: boundary }), (ctx: Context) => insertRowCol(ctx, op, false));
            expect(next.sheets[0].config?.[key]).toEqual({ 2: 1, 5: 0, 6: 1 });
        });

        test(`a ${type} inserted after the index keeps the entry at the index`, () => {
            const op = { type, index: 3, count: 2, direction: 'rightbottom', id: 'id_1' } as const;
            const next = produce(sheet({ [key]: boundary }), (ctx: Context) => insertRowCol(ctx, op, false));
            expect(next.sheets[0].config?.[key]).toEqual({ 2: 1, 3: 0, 6: 1 });
        });

        test(`a ${type} insert or delete on a sheet with no read-only ${type}s writes none`, () => {
            const insert = { type, index: 3, count: 1, direction: 'lefttop', id: 'id_1' } as const;
            for (const config of [undefined, {}]) {
                const inserted = produce(sheet(config), (ctx: Context) => insertRowCol(ctx, insert, false));
                expect(inserted.sheets[0].config).not.toHaveProperty(key);
                const deleted = produce(sheet(config), (ctx: Context) =>
                    deleteRowCol(ctx, { type, start: 1, end: 1, id: 'id_1' }),
                );
                expect(deleted.sheets[0].config).not.toHaveProperty(key);
            }
        });
    }
});
