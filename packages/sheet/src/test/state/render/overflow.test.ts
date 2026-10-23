// Text overflow follows Google Sheets and Excel: a text cell without a wrap or
// clip setting spills into neighbours that hold no value, whatever their
// style, and stops at the first cell with a value or a merge. A source that
// has scrolled off-screen still spills into the visible empty cells.

import { describe, expect, test } from 'bun:test';
import type { Cell } from '../../../engine/types';
import { OVERFLOW_REACH_COLUMNS, overflowColIn, rowOverflowSpans } from '../../../state/render/overflow';

// 100px columns: the right edge of column c sits at (c + 1) * 100.
const edges = (count: number) => Array.from({ length: count }, (_, c) => (c + 1) * 100);
const text = (v: string, extra: Partial<Cell> = {}): Cell => ({ v, m: v, ct: { fa: 'General', t: 'g' }, ...extra });
// What the xlsx import writes into the empty cells of a styled range.
const styled: Cell = { fs: 11, ff: 'Inter', bg: '#FFFFFF', vt: 0 };
// A long text is 350px wide: it covers its own column and reaches 2.5 more.
const width = (cell: Cell) => (String(cell.v).length > 2 ? 350 : 10);

function row(count: number, cells: Record<number, Cell>): (Cell | null)[] {
    return Array.from({ length: count }, (_, c) => cells[c] ?? null);
}

describe('rowOverflowSpans', () => {
    test('text without a wrap setting spills over styled-but-empty neighbours', () => {
        const cells = row(10, { 0: text('Before September'), 1: styled, 2: styled, 3: styled });
        expect(rowOverflowSpans(0, cells, edges(10), 0, 9, width)).toEqual({ 0: { r: 0, stc: 0, edc: 3 } });
    });

    test('a neighbour with a value stops the spill', () => {
        const cells = row(10, { 0: text('Before September'), 2: text('x') });
        expect(rowOverflowSpans(0, cells, edges(10), 0, 9, width)).toEqual({ 0: { r: 0, stc: 0, edc: 1 } });
    });

    test('a space or an empty formula result is a value too', () => {
        const space = row(10, { 0: text('Before September'), 2: text(' ') });
        const formula = row(10, { 0: text('Before September'), 2: { f: '=""', v: '', m: '' } });
        expect(rowOverflowSpans(0, space, edges(10), 0, 9, width)?.[0]?.edc).toBe(1);
        expect(rowOverflowSpans(0, formula, edges(10), 0, 9, width)?.[0]?.edc).toBe(1);
    });

    test('a merge stops the spill', () => {
        const cells = row(10, { 0: text('Before September'), 2: { mc: { r: 0, c: 2, rs: 1, cs: 2 } } });
        expect(rowOverflowSpans(0, cells, edges(10), 0, 9, width)?.[0]?.edc).toBe(1);
    });

    test('wrapped and clipped text stays in its cell; explicit overflow spills', () => {
        for (const tb of ['0', '2']) {
            expect(rowOverflowSpans(0, row(10, { 0: text('Before September', { tb }) }), edges(10), 0, 9, width)).toBe(
                undefined,
            );
        }
        const overflow = row(10, { 0: text('Before September', { tb: '1' }) });
        expect(rowOverflowSpans(0, overflow, edges(10), 0, 9, width)?.[0]?.edc).toBe(3);
    });

    test('right-aligned text spills left, centred text both ways', () => {
        const right = row(10, { 5: text('Before September', { ht: 2 }) });
        expect(rowOverflowSpans(0, right, edges(10), 0, 9, width)).toEqual({ 5: { r: 0, stc: 2, edc: 5 } });
        const centred = row(10, { 5: text('Before September', { ht: 0 }) });
        expect(rowOverflowSpans(0, centred, edges(10), 0, 9, width)).toEqual({ 5: { r: 0, stc: 3, edc: 7 } });
    });

    test('numbers and text that fits never spill', () => {
        const cells = row(10, { 0: { v: 123456789, m: '123456789', ct: { fa: 'General', t: 'n' } }, 4: text('ok') });
        expect(rowOverflowSpans(0, cells, edges(10), 0, 9, width)).toBe(undefined);
    });

    test('a source scrolled off to the left still spills into the visible empty cells', () => {
        const cells = row(10, { 0: text('Before September') });
        expect(rowOverflowSpans(0, cells, edges(10), 2, 9, width)).toEqual({ 0: { r: 0, stc: 0, edc: 3 } });
    });

    test('a right-aligned source scrolled off to the right spills into the view', () => {
        const cells = row(10, { 9: text('Before September', { ht: 2 }) });
        expect(rowOverflowSpans(0, cells, edges(10), 0, 7, width)).toEqual({ 9: { r: 0, stc: 6, edc: 9 } });
    });

    test('an off-screen source behind a value cannot reach the view', () => {
        const cells = row(10, { 0: text('Before September'), 1: text('x') });
        expect(rowOverflowSpans(0, cells, edges(10), 2, 9, width)).toBe(undefined);
    });

    test(`the look past the view's edge stops after ${OVERFLOW_REACH_COLUMNS} empty columns`, () => {
        const count = OVERFLOW_REACH_COLUMNS + 10;
        const far = (gap: number) => {
            const cells = row(count, { 0: text('Very long') });
            // Wide enough to reach any column of the row.
            return rowOverflowSpans(0, cells, edges(count), gap, count - 1, () => count * 100);
        };
        expect(far(OVERFLOW_REACH_COLUMNS)?.[0]?.stc).toBe(0);
        expect(far(OVERFLOW_REACH_COLUMNS + 1)).toBe(undefined);
    });
});

describe('overflowColIn', () => {
    test('reads only its own row and marks the last spanned column', () => {
        const map = { 0: { 0: { r: 0, stc: 0, edc: 3 } }, 1: { 0: { r: 1, stc: 0, edc: 5 } } };
        expect(overflowColIn(map, 0, 2, 9)).toMatchObject({ colIn: true, colLast: false, colIndex: 0 });
        expect(overflowColIn(map, 0, 3, 9)).toMatchObject({ colIn: true, colLast: true, stc: 0, edc: 3 });
        expect(overflowColIn(map, 0, 4, 9).colIn).toBe(false);
        expect(overflowColIn(map, 1, 4, 4).colLast).toBe(true);
    });
});
