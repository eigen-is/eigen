import { describe, expect, test } from 'bun:test';
import { setColumnWidth, setRowHeight } from '../../../state/api/rowcol';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/rowcol', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;

    test('setRowHeight', () => {
        const ctx = getContext();
        setRowHeight(ctx, { 2: 50 });
        setRowHeight(ctx, { 3: 100 }, true);
        expect(ctx.sheets[0].config?.rowlen).toEqual({ 3: 100, 2: 50 });
        expect(ctx.sheets[0].config?.customHeight).toEqual({ 3: 1 });
    });

    test('setColumnWidth', () => {
        const ctx = getContext();
        setColumnWidth(ctx, { 2: 50 });
        setColumnWidth(ctx, { 3: 100 }, true);
        expect(ctx.sheets[0].config?.columnlen).toEqual({ 3: 100, 2: 50 });
        expect(ctx.sheets[0].config?.customWidth).toEqual({ 3: 1 });
    });

    test("a pasted table's unusable height writes nothing", () => {
        const ctx = getContext();
        setRowHeight(ctx, { 2: Number.NaN, 3: -1 });
        expect(ctx.sheets[0].config?.rowlen?.[2]).toBeUndefined();
        expect(ctx.sheets[0].config?.rowlen?.[3]).toBeUndefined();
    });
});
