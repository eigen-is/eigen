// Alternate formats shift in the state reducer, not the engine; they must follow the same
// membership rule as every other range, deletes dropping a wholly deleted range.

import { describe, expect, test } from 'bun:test';
import { produce } from 'immer';
import type { Context } from '../../../state/context';
import { deleteRowCol, insertRowCol } from '../../../state/modules/rowcol';
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
